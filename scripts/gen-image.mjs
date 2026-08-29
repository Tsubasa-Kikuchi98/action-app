// OpenAI 画像生成 API を直接呼び出して PNG を保存する。
// 使い方: node scripts/gen-image.mjs "<prompt>" [out.png]
// 環境変数: OPENAI_API_KEY(必須) / IMG_MODEL / IMG_SIZE / IMG_QUALITY
import fs from "node:fs";
import path from "node:path";

const [prompt, out = "out.png"] = process.argv.slice(2);
if (!prompt) {
  console.error('usage: node scripts/gen-image.mjs "<prompt>" [out.png]');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY が未設定です（setx OPENAI_API_KEY \"sk-...\" 後にシェルを開き直す）");
  process.exit(1);
}

const body = {
  model: process.env.IMG_MODEL ?? "gpt-image-2",
  prompt,
  size: process.env.IMG_SIZE ?? "1024x1024",
  quality: process.env.IMG_QUALITY ?? "low",
};

const r = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const j = await r.json();
if (!r.ok) {
  console.error(JSON.stringify(j, null, 2));
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, Buffer.from(j.data[0].b64_json, "base64"));
console.log(`saved: ${out} (${body.model}, ${body.size}, ${body.quality})`);
