// ② 画像生成: script.json の image_prompt → out/<job>/img/s1..s6.png
// 使い方: node scripts/images.mjs <job> [--force]
//
// 共通スタイル接尾辞を付けて gpt-image-2 で並列生成する。
// 既存ファイルはスキップ（--force で再生成）。429/5xx は指数バックオフでリトライ。
import fs from "node:fs";
import path from "node:path";
import { castDescription } from "./enrich.mjs";
import { getOpenAI, MODELS, ensureDirs, readScript, timed, withRetry, fmtUSD, isMain } from "./lib.mjs";

// 全カットの見た目を揃えるための共通スタイル接尾辞。
export const STYLE_SUFFIX =
  "cinematic still, anamorphic lens, teal and orange grade, film grain, dramatic lighting, shallow depth of field, no text, no letters, no logos, no subtitles, no watermark";

export async function generateImages(job, { force = false } = {}) {
  const openai = getOpenAI();
  const p = ensureDirs(job, "img");
  const data = readScript(job);

  const size = process.env.IMG_SIZE ?? "1536x1024";
  const quality = process.env.IMG_QUALITY ?? "low";

  console.log(`[images] ${MODELS.image} / ${size} / ${quality} / ${data.scenes.length}枚 並列`);

  const tasks = data.scenes.map((scene, i) => async () => {
    const n = i + 1;
    const file = path.join(p.img, `s${n}.png`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`  s${n}: skip (既存)`);
      return { n, file, skipped: true, cost: 0, sec: 0 };
    }
    const cast = castDescription(scene.characters);
    const prompt = `${scene.image_prompt}.${cast ? ` Characters (keep exactly this appearance): ${cast}.` : ""} ${STYLE_SUFFIX}`;

    const { result, sec, cost } = await timed(
      job,
      "image",
      async () => {
        const res = await withRetry(
          () => openai.images.generate({ model: MODELS.image, prompt, size, quality, n: 1 }),
          { label: `image s${n}` }
        );
        // 画像は枚数課金のため usage に images を足しておく
        return { result: res, usage: { ...(res.usage ?? {}), images: 1 }, model: MODELS.image };
      },
      { scene: n }
    );

    const item = result.data?.[0];
    if (!item) throw new Error(`s${n}: 画像が返りませんでした`);
    let buf;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const r = await fetch(item.url);
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      throw new Error(`s${n}: b64_json も url もありません`);
    }
    fs.writeFileSync(file, buf);
    console.log(`  s${n}: ${file} (${(buf.length / 1024).toFixed(0)}KB, ${sec.toFixed(1)}s)`);
    return { n, file, skipped: false, cost, sec };
  });

  const results = await Promise.all(tasks.map((t) => t()));
  const cost = results.reduce((a, r) => a + r.cost, 0);
  const made = results.filter((r) => !r.skipped).length;
  console.log(`[images] 生成 ${made}枚 / スキップ ${results.length - made}枚 / 推定 ${fmtUSD(cost)}`);
  return { results, cost };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await generateImages(job, { force });
}
