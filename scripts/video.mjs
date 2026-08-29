// ③ 動画生成（Phase 2）: img/sN.png を起点に image-to-video → out/<job>/vid/sN.mp4
// 使い方: node scripts/video.mjs <job> [--force] [--stills]
//
// Google Gemini API の Veo 3.1 Lite（既定 veo-3.1-lite-generate-preview）を使う。
//   - 720p / 16:9 / durationSeconds は 4 / 6 / 8 のいずれか（scene.duration_sec をそのまま渡す）
//   - 全シーンを並列投入（同時数 env VEO_CONCURRENCY、既定 3）→ 10 秒間隔でポーリング → 完了次第 DL
//   - 失敗 / タイムアウト / 安全フィルタ拒否は、そのシーンだけ motion:"still"（静止画 Ken Burns）に落とす
//
// 実機で判明した仕様（2026-08-29）:
//   - `negativePrompt` は veo-3.1-lite-generate-preview では 400 INVALID_ARGUMENT。
//     → 否定語はプロンプト本文の末尾に混ぜる（VEO_NEGATIVE_PROMPT=on で config 送信も試せる）。
//   - 出力は 1280x720 / 24fps / h264 + aac 48kHz stereo。音声は常に同梱される。
//   - 生成物はサーバに 2 日しか残らないので、完了直後にダウンロードする。
//   - 起点画像が 16:9 でないと Veo が黒帯（レターボックス）ごと動画化してしまう。
//     gpt-image-2 の 1536x1024 は 3:2 なので、送る前に ffmpeg で 1280x720 にクロップする
//     （render.mjs の静止画経路と同じ「拡大してから中央クロップ」なので画角が揃う）。
import fs from "node:fs";
import path from "node:path";
import {
  getGemini, MODELS, ensureDirs, readScript, writeScript, jobPaths,
  timed, withRetry, probeDuration, sleep, fmtUSD, isMain, PRICES, ffmpeg,
} from "./lib.mjs";

// 全カットの見た目を揃えるためのスタイル接尾辞（images.mjs の STYLE_SUFFIX と対になる）。
export const VIDEO_STYLE_SUFFIX =
  "cinematic movie trailer shot, anamorphic lens, teal and orange grade, film grain, dramatic lighting, " +
  "single continuous take";

// negativePrompt が使えないモデル向けに、否定語をプロンプト本文へ固定付与する。
export const VIDEO_NEGATIVE_SUFFIX =
  "no dialogue, no speech, no on-screen text";

// config.negativePrompt に送る文字列（VEO_NEGATIVE_PROMPT=on のときだけ使用）。
export const VEO_NEGATIVE_PROMPT = "dialogue, speech, talking, subtitles, text, captions, logo";

const POLL_MS = 10_000;

// Veo に渡す起点画像のサイズ（出力と同じ 720p 16:9）。
const SRC_W = 1280;
const SRC_H = 720;

/** img/sN.png を 16:9 にクロップして vid/_src_sN.png に書き出し、そのパスを返す。 */
async function prepareSource(img, dst) {
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(img).mtimeMs) {
    await ffmpeg([
      "-i", img,
      "-vf", `scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,crop=${SRC_W}:${SRC_H}`,
      "-frames:v", "1",
      dst,
    ]);
  }
  return dst;
}

/** scene から Veo に渡す最終プロンプトを組み立てる。 */
export function buildVideoPrompt(scene) {
  // video_prompt が無い旧 script.json（Phase 1）でも image_prompt から動かせるようにする。
  const base =
    scene.video_prompt?.trim() ||
    `${scene.image_prompt?.trim() ?? ""} Slow cinematic push-in with subtle camera drift.`;
  return `${base} ${VIDEO_STYLE_SUFFIX}, ${VIDEO_NEGATIVE_SUFFIX}`;
}

/** Veo が受け付ける尺（4/6/8）に丸める。 */
function veoDuration(sec) {
  const max = Number(process.env.VEO_MAX_SEC ?? 8);
  return [4, 6, 8].filter((v) => v <= max).find((v) => v >= sec - 1e-6) ?? Math.min(8, max);
}

/** 一定同時数で非同期タスクを走らせるワーカープール。 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 1 シーン分の生成（投入 → ポーリング → ダウンロード）。失敗しても throw せず reason を返す。 */
async function generateOne(job, scene, i, { timeoutSec }) {
  const ai = getGemini();
  const p = jobPaths(job);
  const n = i + 1;
  const img = path.join(p.img, `s${n}.png`);
  const out = path.join(p.vid, `s${n}.mp4`);

  if (!fs.existsSync(img)) {
    return { n, ok: false, reason: `起点画像がありません: ${path.basename(img)}`, sec: 0, cost: 0, veoSec: 0 };
  }

  const dur = veoDuration(scene.duration_sec ?? 4);
  const prompt = buildVideoPrompt(scene);
  const t0 = Date.now();

  fs.mkdirSync(p.vid, { recursive: true });
  const src = await prepareSource(img, path.join(p.vid, `_src_s${n}.png`));

  try {
    const { result: file } = await timed(
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

        // --- 投入（429/5xx は指数バックオフ） ---
        let op = await withRetry(
          () =>
            ai.models.generateVideos({
              model: MODELS.video,
              prompt,
              image: {
                imageBytes: fs.readFileSync(src).toString("base64"),
                mimeType: "image/png",
              },
              config,
            }),
          { label: `veo s${n} submit`, tries: 5, base: 5000 }
        );
        console.log(`  s${n}: 投入 (${dur}s) ${op.name ?? ""}`);

        // --- ポーリング ---
        const deadline = Date.now() + timeoutSec * 1000;
        let polls = 0;
        while (!op.done) {
          if (Date.now() > deadline) {
            throw new Error(`タイムアウト（${timeoutSec}s 経過。operation=${op.name ?? "?"}）`);
          }
          await sleep(POLL_MS);
          polls++;
          try {
            op = await ai.operations.getVideosOperation({ operation: op });
          } catch (e) {
            const st = e?.status ?? 0;
            console.warn(`  s${n}: poll ${polls} エラー status=${st} ${e?.message ?? e}（継続）`);
            if (st === 429) await sleep(POLL_MS);
          }
        }
        if (op.error) throw new Error(`operation エラー: ${JSON.stringify(op.error).slice(0, 400)}`);

        const res = op.response;
        if (res?.raiMediaFilteredCount) {
          throw new Error(
            `安全フィルタで拒否 (${res.raiMediaFilteredCount}件): ${(res.raiMediaFilteredReasons ?? []).join(" / ")}`
          );
        }
        const video = res?.generatedVideos?.[0]?.video;
        if (!video) throw new Error(`動画が返りませんでした: keys=${Object.keys(res ?? {}).join(",")}`);

        // --- 即ダウンロード（サーバ保持は 2 日） ---
        if (video.videoBytes) {
          fs.writeFileSync(out, Buffer.from(video.videoBytes, "base64"));
        } else {
          await withRetry(() => ai.files.download({ file: video, downloadPath: out }), {
            label: `veo s${n} download`,
          });
        }
        if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
          throw new Error("ダウンロードしたファイルが空です");
        }
        // 課金は「生成を依頼した秒数 × 単価」。usage.video_sec を estimateCost が拾う。
        return { result: out, usage: { video_sec: dur, polls }, model: MODELS.video };
      },
      { scene: n, duration_sec: dur }
    );

    const clipSec = await probeDuration(file);
    const cost = (PRICES[MODELS.video]?.perSec ?? 0) * dur;
    const sec = (Date.now() - t0) / 1000;
    console.log(
      `  s${n}: ${path.basename(file)} ${clipSec.toFixed(2)}s ` +
        `(${(fs.statSync(file).size / 1024 / 1024).toFixed(2)}MB, ${sec.toFixed(1)}s, ${fmtUSD(cost)})`
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

export async function generateVideos(job, { force = false, stills = false } = {}) {
  const p = ensureDirs(job, "vid");
  const data = readScript(job);

  // --- 全シーン静止画モード ---------------------------------------------
  if (stills) {
    for (const s of data.scenes) {
      s.motion = "still";
      s.motion_reason = "--stills 指定";
    }
    writeScript(job, data);
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
    if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) {
      scene.motion = "video";
      scene.clip_sec = Number((await probeDuration(out)).toFixed(2));
      delete scene.motion_reason;
      console.log(`  s${i + 1}: skip (既存 ${scene.clip_sec}s)`);
      continue;
    }
    todo.push({ scene, i });
  }

  const planSec = todo.reduce((a, t) => a + veoDuration(t.scene.duration_sec ?? 4), 0);
  const planCost = (PRICES[MODELS.video]?.perSec ?? 0) * planSec;
  console.log(
    `[video] ${MODELS.video} / 720p / 16:9 / ${todo.length}本 並列${concurrency} ` +
      `/ 計 ${planSec}s ≒ ${fmtUSD(planCost)}（timeout ${timeoutSec}s）`
  );
  if (planSec > budgetSec) {
    throw new Error(
      `Veo の生成予定 ${planSec}s が予算 ${budgetSec}s を超えています。` +
        `VEO_BUDGET_SEC を上げるか、シーン数 / duration_sec を見直してください。`
    );
  }

  const t0 = Date.now();
  const results = await pool(todo, concurrency, ({ scene, i }) => generateOne(job, scene, i, { timeoutSec }));

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
  writeScript(job, data);

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

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const stills = args.includes("--stills");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await generateVideos(job, { force, stills });
}
