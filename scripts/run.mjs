// ①〜⑤ を順に実行する一気通貫スクリプト。
// 使い方: node scripts/run.mjs "<エピソード文>" <job> [--force] [--skip-script]
//   npm run trailer -- "<エピソード文>" demo1
//
// 各工程の所要秒 / API usage / 推定コスト合計を表示する。
import fs from "node:fs";
import {
  jobPaths, summarizeLog, probeSummary, fmtUSD, isMain,
} from "./lib.mjs";
import { generateScript } from "./script.mjs";
import { generateImages } from "./images.mjs";
import { generateNarration } from "./narration.mjs";
import { prepareBgm } from "./bgm.mjs";
import { render } from "./render.mjs";

export async function runAll(episode, job, { force = false, skipScript = false } = {}) {
  const p = jobPaths(job);
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
  if (skipScript && fs.existsSync(p.script)) {
    console.log("\n===== ① 台本 =====\n  skip (既存の script.json を使用)");
    steps.push({ name: "① 台本", sec: 0, cost: 0 });
  } else {
    await step("① 台本", () => generateScript(episode, job));
  }

  // ② 画像 / ③ ナレーション / ④ BGM
  await step("② 画像", () => generateImages(job, { force }));
  await step("③ ナレーション", () => generateNarration(job, { force }));
  await step("④ BGM", () => prepareBgm(job, { force }));

  // ⑤ 合成（台本・ナレの尺が変わっている可能性があるので常に作り直す）
  await step("⑤ 合成", () => render(job, { force: true }));

  // --- サマリ -------------------------------------------------------------
  const wall = (Date.now() - t0) / 1000;
  const { totalCost, rows } = summarizeLog(job);

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
  console.log(`  合計推定コスト: ${fmtUSD(totalCost)} ※単価は lib.mjs の PRICES（目安値）`);

  // 出力の確認
  const info = await probeSummary(p.trailer);
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

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const pos = args.filter((a) => !a.startsWith("--"));
  const [episode, job = "demo1"] = pos;
  if (!episode) {
    console.error('usage: node scripts/run.mjs "<エピソード文>" <job> [--force] [--skip-script]');
    process.exit(1);
  }
  await runAll(episode, job, {
    force: flags.includes("--force"),
    skipScript: flags.includes("--skip-script"),
  });
}
