// ①〜⑤ を順に実行する一気通貫のオーケストレーション。
//
// 流れ（Phase 2）:
//   ① 台本 → ①' 演出(enrich, 不足時のみ) → ⓪ 基準画像(不足分のみ)
//     → ｛② 画像 ‖ ③' ナレ+セリフ ‖ ④ BGM ‖ ⑥ 効果音｝並列
//     → ③ 動画(Veo) → ⑤ 合成
//   ③ を並列グループに入れないのは、起点画像（②）と 4/6/8 に丸めた尺（③'）の両方に依存するため。
//   --stills を付けると ③ をスキップして Phase 1 相当（静止画 Ken Burns のみ）になる。
//
// 各工程の所要秒 / API usage / 推定コスト合計（Veo の秒数を含む）を表示する。
import { isEnriched } from "../domain/script/index.mjs";
import { fmtUSD } from "../domain/pricing.mjs";
import { generateScript } from "./generateScript.mjs";
import { enrichScript } from "./enrichScript.mjs";
import { prepareRefs } from "./prepareRefs.mjs";
import { generateImages } from "./generateImages.mjs";
import { generateNarration } from "./generateNarration.mjs";
import { generateVideos } from "./generateVideos.mjs";
import { prepareBgm } from "./prepareBgm.mjs";
import { prepareSfx } from "./prepareSfx.mjs";
import { renderTrailer } from "./renderTrailer.mjs";

/**
 * @param {object} deps cli/deps.mjs の createDeps() が組んだ依存一式
 */
export async function runPipeline(deps, episode, job, { force = false, skipScript = false, stills = false } = {}) {
  const { store, media, refs, files } = deps;
  const p = store.paths(job);
  const steps = [];
  const t0 = Date.now();

  const step = async (name, fn) => {
    const ts = Date.now();
    console.log(`\n===== ${name} =====`);
    const r = await fn();
    const sec = (Date.now() - ts) / 1000;
    steps.push({ name, sec, cost: r?.cost ?? 0 });
    return r;
  };

  // ① 台本
  if (skipScript && files.exists(p.script)) {
    console.log("\n===== ① 台本 =====\n  skip (既存の script.json を使用)");
    steps.push({ name: "① 台本", sec: 0, cost: 0 });
  } else {
    await step("① 台本", () => generateScript(deps.script, episode, job));
  }

  // ①' 演出情報の付与（enrich）
  //   generateScript は Phase 3 から演出フィールドも一緒に出すので、通常はここで何もしない。
  //   Phase 1/2 に作った古い script.json（--skip-script で再利用する場合）だけ補完される。
  if (isEnriched(store.readScript(job))) {
    console.log("\n===== ①' 演出情報 =====\n  skip (台本が既に演出情報を持っています)");
    steps.push({ name: "①' 演出", sec: 0, cost: 0 });
  } else {
    await step("①' 演出", () => enrichScript(deps.script, job));
  }

  // ⓪ 基準画像（キャラクターシート・ロケーションプレート）
  //   assets/refs/ にジョブ横断で残る。台本が必要とする分だけ、不足しているものを生成する。
  //   これを ② より前に置くことで、5 枚を並列生成しても人物とロケの見た目が揃う。
  await step("⓪ 基準画像", async () => {
    const need = refs.refsNeededForScript(store.readScript(job));
    return prepareRefs(deps.refsUseCase, { ...need, force: false });
  });

  // ② 画像 ‖ ③' ナレーション ‖ ④ BGM ‖ ⑥ 効果音（互いに独立なので並列）
  //   ※ script.json を書き戻すのは narration だけ。images / bgm / sfx は読むだけなので競合しない。
  //   ⑥ は assets/sfx/ にジョブ横断で残るので、2 本目以降は毎回スキップされる。
  await step("②③'④⑥ 並列", async () => {
    const [img, nar, bgm, sfx] = await Promise.all([
      generateImages(deps.image, job, { force }),
      generateNarration(deps.speech, job, { force }),
      prepareBgm(deps.bgm, job, { force }),
      prepareSfx(deps.sfx, {}),
    ]);
    return { cost: (img?.cost ?? 0) + (nar?.cost ?? 0) + (bgm?.cost ?? 0) + (sfx?.cost ?? 0) };
  });

  // ③ 動画（Veo）: 起点画像と確定した duration_sec が必要なので並列グループの後
  const vid = await step(stills ? "③ 動画(skip)" : "③ 動画", () =>
    generateVideos(deps.video, job, { force, stills })
  );

  // ⑤ 合成（台本・ナレの尺が変わっている可能性があるので常に作り直す）
  await step("⑤ 合成", () => renderTrailer(deps.render, job, { force: true }));

  // --- サマリ -------------------------------------------------------------
  const wall = (Date.now() - t0) / 1000;
  const { totalCost, rows } = store.summarizeLog(job);

  console.log("\n===== サマリ =====");
  console.log("工程            所要秒");
  for (const s of steps) console.log(`  ${s.name.padEnd(14)} ${s.sec.toFixed(1)}s`);
  console.log(`  ${"合計(実時間)".padEnd(14)} ${wall.toFixed(1)}s`);

  // API usage の内訳（log.jsonl 全体の累計）
  const byModel = {};
  for (const r of rows) {
    if (!r.ok || !r.model) continue;
    const m = (byModel[r.model] ??= { calls: 0, in: 0, out: 0, images: 0, cost: 0 });
    m.calls++;
    m.in += r.usage?.input_tokens ?? 0;
    m.out += r.usage?.output_tokens ?? 0;
    m.images += r.usage?.images ?? 0;
    m.cost += r.cost_usd ?? 0;
  }
  console.log("\nAPI usage（log.jsonl 累計）");
  for (const [model, m] of Object.entries(byModel)) {
    const detail = m.images ? `${m.images}枚` : `in ${m.in} / out ${m.out} tok`;
    console.log(`  ${model.padEnd(18)} ${String(m.calls).padStart(2)}回  ${detail.padEnd(26)} 推定 ${fmtUSD(m.cost)}`);
  }
  console.log(`  合計推定コスト: ${fmtUSD(totalCost)} ※単価は domain/pricing.mjs の PRICES（目安値）`);

  // Veo の内訳
  const veoSec = rows.filter((r) => r.step === "video" && r.ok).reduce((a, r) => a + (r.usage?.video_sec ?? 0), 0);
  const veoCost = rows.filter((r) => r.step === "video" && r.ok).reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  console.log(
    `\nVeo: 動画 ${vid?.videoCount ?? 0} シーン / 静止画フォールバック ${vid?.stillCount ?? 0} シーン` +
      ` / 生成 ${veoSec}s = ${fmtUSD(veoCost)}（log.jsonl 累計）`
  );

  // 出力の確認
  const info = await media.probeSummary(p.trailer);
  const v = info.streams.find((s) => s.codec_type === "video") ?? {};
  const a = info.streams.find((s) => s.codec_type === "audio") ?? {};
  console.log(`\n完成: ${p.trailer}`);
  console.log(
    `  ${v.width}x${v.height} / ${v.r_frame_rate} / ${v.codec_name}+${a.codec_name} ` +
      `${a.sample_rate}Hz ${a.channels}ch / ${Number(info.format.duration).toFixed(2)}s / ` +
      `${(Number(info.format.size) / 1024 / 1024).toFixed(1)}MB`
  );
  return { steps, totalCost, wall, file: p.trailer };
}
