// ③ 動画生成（Phase 2）: img/sN.png を起点に image-to-video → out/<job>/vid/sN.mp4
//
// Google Gemini API の Veo 3.1 Lite（既定 veo-3.1-lite-generate-preview）を使う。
//   - 720p / 16:9 / durationSeconds は 4 / 6 / 8 のいずれか
//   - 全シーンを並列投入（同時数 env VEO_CONCURRENCY、既定 3）→ 10 秒間隔でポーリング → 完了次第 DL
//   - 失敗 / タイムアウト / 安全フィルタ拒否は、そのシーンだけ motion:"still"（静止画 Ken Burns）に落とす
//
// 起点画像が 16:9 でないと Veo が黒帯（レターボックス）ごと動画化してしまう。
// gpt-image-2 の 1536x1024 は 3:2 なので、送る前に ffmpeg で 1280x720 にクロップする
// （render の静止画経路と同じ「拡大してから中央クロップ」なので画角が揃う）。
import path from "node:path";
import { enrichedView } from "../domain/script/index.mjs";
import { buildVideoPrompt, veoDuration, VEO_NEGATIVE_PROMPT } from "../domain/prompts/videoPrompt.mjs";
import { PRICES, fmtUSD } from "../domain/pricing.mjs";
import { pool } from "./pool.mjs";

// Veo に渡す起点画像のサイズ（出力と同じ 720p 16:9）。
const SRC_W = 1280;
const SRC_H = 720;

/** img/sN.png を 16:9 にクロップして vid/_src_sN.png に書き出し、そのパスを返す。 */
async function prepareSource(media, files, img, dst) {
  if (!files.exists(dst) || files.mtimeMs(dst) < files.mtimeMs(img)) {
    await media.ffmpeg([
      "-i", img,
      "-vf", `scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,crop=${SRC_W}:${SRC_H}`,
      "-frames:v", "1",
      dst,
    ]);
  }
  return dst;
}

/** 1 シーン分の生成（投入 → ポーリング → ダウンロード）。失敗しても throw せず reason を返す。 */
async function generateOne(deps, job, scene, i, { timeoutSec }) {
  const { video, store, media, files, model } = deps;
  const p = store.paths(job);
  const n = i + 1;
  const img = path.join(p.img, `s${n}.png`);
  const out = path.join(p.vid, `s${n}.mp4`);

  if (!files.exists(img)) {
    return { n, ok: false, reason: `起点画像がありません: ${path.basename(img)}`, sec: 0, cost: 0, veoSec: 0 };
  }

  const dur = veoDuration(scene.duration_sec ?? 4);
  const prompt = buildVideoPrompt(scene);
  const t0 = Date.now();

  files.mkdir(p.vid);
  const src = await prepareSource(media, files, img, path.join(p.vid, `_src_s${n}.png`));

  try {
    const { result: file } = await store.timed(
      job,
      "video",
      async () => {
        const config = {
          aspectRatio: "16:9",
          resolution: process.env.VEO_RESOLUTION ?? "720p",
          durationSeconds: dur,
          personGeneration: "allow_adult",
        };
        // 既定では送らない（Lite は 400 を返す）。将来対応したモデル向けの逃げ道。
        if ((process.env.VEO_NEGATIVE_PROMPT ?? "off").toLowerCase() === "on") {
          config.negativePrompt = VEO_NEGATIVE_PROMPT;
        }

        const { polls } = await video.generate({
          model,
          prompt,
          imagePath: src,
          config,
          out,
          timeoutSec,
          label: `veo s${n}`,
          onSubmit: (op) => console.log(`  s${n}: 投入 (${dur}s) ${op.name ?? ""}`),
          onPollError: (poll, st, e) =>
            console.warn(`  s${n}: poll ${poll} エラー status=${st} ${e?.message ?? e}（継続）`),
        });
        // 課金は「生成を依頼した秒数 × 単価」。usage.video_sec が estimateCost に拾われる。
        return { result: out, usage: { video_sec: dur, polls }, model };
      },
      { scene: n, duration_sec: dur }
    );

    const clipSec = await media.probeDuration(file);
    const cost = (PRICES[model]?.perSec ?? 0) * dur;
    const sec = (Date.now() - t0) / 1000;
    console.log(
      `  s${n}: ${path.basename(file)} ${clipSec.toFixed(2)}s ` +
        `(${(files.size(file) / 1024 / 1024).toFixed(2)}MB, ${sec.toFixed(1)}s, ${fmtUSD(cost)})`
    );
    return { n, ok: true, file, clipSec, veoSec: dur, sec, cost };
  } catch (e) {
    const sec = (Date.now() - t0) / 1000;
    const reason = String(e?.message ?? e).slice(0, 400);
    console.warn(`  s${n}: 失敗 → 静止画にフォールバック (${sec.toFixed(1)}s): ${reason}`);
    // 投入後に落ちた場合は課金されている可能性があるため、秒数だけは計上しておく。
    return { n, ok: false, reason, sec, cost: 0, veoSec: 0 };
  }
}

/**
 * @param {object} deps { video, store, media, model }
 */
export async function generateVideos(deps, job, { force = false, stills = false, dryRun = false } = {}) {
  const { store, media, files, model } = deps;
  const p = store.ensureDirs(job, "vid");
  const data = store.readScript(job);
  // camera_beat / ambient 等の既定値を埋めたビュー（プロンプト組み立てにだけ使う）
  const view = enrichedView(data);

  // --- ドライラン: API を呼ばずにプロンプトと想定費用だけ出す --------------
  if (dryRun) {
    let sec = 0;
    for (const [i, s] of view.scenes.entries()) {
      const d = veoDuration(s.duration_sec ?? 4);
      sec += d;
      console.log(`
--- s${i + 1} [${s.scene_type}] ${d}s 生成 ---`);
      // visual_metaphor は Veo には送らない（日本語）。翻訳が効いているかの確認用に並べて表示する。
      if (s.visual_metaphor) console.log(`  [翻訳] ${s.visual_metaphor}`);
      console.log(buildVideoPrompt(s));
    }
    const cost = (PRICES[model]?.perSec ?? 0) * sec;
    console.log(`
[video --dry-run] ${model} / ${view.scenes.length}本 / 計 ${sec}s ≒ ${fmtUSD(cost)}（API は呼んでいません）`);
    return { results: [], cost: 0, veoSec: 0, videoCount: 0, stillCount: 0, dryRun: true, planSec: sec, planCost: cost };
  }

  // --- 全シーン静止画モード ---------------------------------------------
  if (stills) {
    for (const s of data.scenes) {
      s.motion = "still";
      s.motion_reason = "--stills 指定";
    }
    store.writeScript(job, data);
    console.log(`[video] --stills: 全 ${data.scenes.length} シーンを静止画（Ken Burns）にします`);
    return { results: [], cost: 0, veoSec: 0, videoCount: 0, stillCount: data.scenes.length };
  }

  const concurrency = Number(process.env.VEO_CONCURRENCY ?? 3);
  const timeoutSec = Number(process.env.VEO_TIMEOUT_SEC ?? 480);
  const budgetSec = Number(process.env.VEO_BUDGET_SEC ?? 48);

  // 既存クリップを持つシーンはスキップ（--force で再生成）
  const todo = [];
  for (const [i, scene] of data.scenes.entries()) {
    const out = path.join(p.vid, `s${i + 1}.mp4`);
    if (!force && files.ready(out)) {
      scene.motion = "video";
      scene.clip_sec = Number((await media.probeDuration(out)).toFixed(2));
      delete scene.motion_reason;
      console.log(`  s${i + 1}: skip (既存 ${scene.clip_sec}s)`);
      continue;
    }
    todo.push({ scene, i });
  }

  const planSec = todo.reduce((a, t) => a + veoDuration(t.scene.duration_sec ?? 4), 0);
  const planCost = (PRICES[model]?.perSec ?? 0) * planSec;
  console.log(
    `[video] ${model} / 720p / 16:9 / ${todo.length}本 並列${concurrency} ` +
      `/ 計 ${planSec}s ≒ ${fmtUSD(planCost)}（timeout ${timeoutSec}s）`
  );
  if (planSec > budgetSec) {
    throw new Error(
      `Veo の生成予定 ${planSec}s が予算 ${budgetSec}s を超えています。` +
        `VEO_BUDGET_SEC を上げるか、シーン数 / duration_sec を見直してください。`
    );
  }

  const t0 = Date.now();
  const results = await pool(todo, concurrency, ({ i }) => generateOne(deps, job, view.scenes[i], i, { timeoutSec }));

  // --- script.json に結果を書き戻す（単一の writer） -----------------------
  for (const r of results) {
    const scene = data.scenes[r.n - 1];
    if (r.ok) {
      scene.motion = "video";
      scene.clip_sec = Number(r.clipSec.toFixed(2));
      delete scene.motion_reason;
    } else {
      scene.motion = "still";
      scene.motion_reason = r.reason;
      delete scene.clip_sec;
    }
  }
  store.writeScript(job, data);

  const veoSec = results.reduce((a, r) => a + r.veoSec, 0);
  const cost = results.reduce((a, r) => a + r.cost, 0);
  const videoCount = data.scenes.filter((s) => s.motion === "video").length;
  const stillCount = data.scenes.length - videoCount;
  const wall = (Date.now() - t0) / 1000;

  console.log(
    `[video] 動画 ${videoCount} / 静止画フォールバック ${stillCount} ` +
      `/ Veo ${veoSec}s = ${fmtUSD(cost)} / 実時間 ${wall.toFixed(1)}s`
  );
  for (const s of data.scenes) {
    if (s.motion === "still" && s.motion_reason) console.log(`   s${s.index}: still — ${s.motion_reason}`);
  }
  return { results, cost, veoSec, videoCount, stillCount };
}
