// VideoGenerator ポートの実装: Google Gemini API の Veo 3.1（image-to-video）。
//
// 実機で判明した仕様（2026-08-29）:
//   - `negativePrompt` は veo-3.1-lite-generate-preview では 400 INVALID_ARGUMENT。
//     → 否定語はプロンプト本文の末尾に混ぜる（VEO_NEGATIVE_PROMPT=on で config 送信も試せる）。
//   - 出力は 1280x720 / 24fps / h264 + aac 48kHz stereo。音声は常に同梱される。
//   - 生成物はサーバに 2 日しか残らないので、完了直後にダウンロードする。
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { withRetry, sleep } from "../retry.mjs";

const POLL_MS = 10_000;

let _genai = null;
export function getGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY が未設定です（.env を確認してください）");
  }
  _genai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _genai;
}

/**
 * 1 本の image-to-video を「投入 → ポーリング → ダウンロード」まで行う。
 * 失敗は例外で返す（フォールバック判断は usecase 側）。
 * @param {{model: string, prompt: string, imagePath: string, config: object, out: string,
 *          timeoutSec: number, label?: string, onSubmit?: Function, onPollError?: Function}} req
 * @returns {Promise<{path: string, polls: number}>}
 */
export async function generateVideo({
  model, prompt, imagePath, config, out, timeoutSec,
  label = "veo", onSubmit = () => {}, onPollError = () => {},
}) {
  const ai = getGemini();

  // --- 投入（429/5xx は指数バックオフ） ---
  let op = await withRetry(
    () =>
      ai.models.generateVideos({
        model,
        prompt,
        image: {
          imageBytes: fs.readFileSync(imagePath).toString("base64"),
          mimeType: "image/png",
        },
        config,
      }),
    { label: `${label} submit`, tries: 5, base: 5000 }
  );
  onSubmit(op);

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
      onPollError(polls, st, e);
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
      label: `${label} download`,
    });
  }
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error("ダウンロードしたファイルが空です");
  }
  return { path: out, polls };
}

export const videoGenerator = { generate: generateVideo };
