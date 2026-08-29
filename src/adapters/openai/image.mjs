// ImageGenerator ポートの実装: gpt-image-2 の generations / edits。
// gpt-image-2 は入力画像を常に高忠実度で扱うため `input_fidelity` は送らない（公式ガイド）。
import fs from "node:fs";
import path from "node:path";
import { toFile } from "openai";
import { getOpenAI } from "./client.mjs";
import { withRetry } from "../retry.mjs";

/** レスポンスの 1 枚目を Buffer にする（b64_json / url どちらでも）。 */
async function toBuffer(res, label) {
  const item = res.data?.[0];
  if (!item) throw new Error(`${label}: 画像が返りませんでした`);
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error(`${label}: b64_json も url もありません`);
}

/**
 * images/generations。
 * @param {{model: string, prompt: string, size: string, quality: string, label?: string}} req
 * @returns {Promise<{buffer: Buffer, usage: object}>}
 */
export async function generate({ model, prompt, size, quality, label = "image" }) {
  const openai = getOpenAI();
  const res = await withRetry(
    () => openai.images.generate({ model, prompt, size, quality, n: 1 }),
    { label }
  );
  return { buffer: await toBuffer(res, label), usage: res.usage ?? {} };
}

/**
 * images/edits（参照画像を添付）。
 * @param {{model: string, prompt: string, images: string[], size: string, quality: string, label?: string}} req
 * @returns {Promise<{buffer: Buffer, usage: object}>}
 */
export async function edit({ model, prompt, images, size, quality, label = "image" }) {
  const openai = getOpenAI();
  const res = await withRetry(
    async () => {
      // Uploadable はストリームだと再送（リトライ）で使い回せないので毎回作り直す。
      const image = await Promise.all(
        images.map((f) => toFile(fs.readFileSync(f), path.basename(f), { type: "image/png" }))
      );
      return openai.images.edit({ model, image, prompt, size, quality, n: 1 });
    },
    { label }
  );
  return { buffer: await toBuffer(res, label), usage: res.usage ?? {} };
}

export const imageGenerator = { generate, edit };
