// ② 画像生成: script.json の image_prompt → out/<job>/img/s1..s5.png
// 使い方: node scripts/images.mjs <job> [--force]
//
// 5 枚を並列生成するので、そのままだと同じ「主人公」でも顔・服が毎回変わり、
// 同じ「オフィス」でも部屋が別物になる。そこで assets/refs/ の基準画像
// （キャラクターシート・ロケーションプレート。scripts/refs.mjs で作る）を
// **images/edits の参照画像として毎回添付**して見た目を揃える。
//   image[] = そのシーンの characters のキャラシート（最大 3 枚）＋ location のプレート（1 枚）
// 参照が 1 枚も無いシーンは従来どおり images/generations にフォールバックする。
//
// 既存ファイルはスキップ（--force で再生成）。429/5xx は指数バックオフでリトライ。
// gpt-image-2 は入力画像を常に高忠実度で扱うため `input_fidelity` は送らない（公式ガイド）。
import fs from "node:fs";
import path from "node:path";
import { toFile } from "openai";
import { castDescription, enrichedView, CAST, LOCATIONS } from "./enrich.mjs";
import { sceneRefs } from "./refs.mjs";
import { getOpenAI, MODELS, ensureDirs, readScript, timed, withRetry, fmtUSD, isMain } from "./lib.mjs";

// 全カットの見た目を揃えるための共通スタイル接尾辞。
export const STYLE_SUFFIX =
  "cinematic still, anamorphic lens, teal and orange grade, film grain, dramatic lighting, shallow depth of field, no text, no letters, no logos, no subtitles, no watermark";

/** 参照画像を渡すときのプロンプト。参照の並び順を明示して取り違えを防ぐ。 */
export function buildEditPrompt(scene, refs) {
  const order = [
    ...refs.chars.map((k) => `a character sheet (three views of the same person) of ${CAST[k].en}`),
    ...(refs.loc ? [`a location plate of ${LOCATIONS[refs.loc].en}`] : []),
  ];
  return [
    `Reference images, in this order: ${order.join("; ")}.`,
    "Use the reference images: the people must look exactly like the character sheets (same face, hair, clothing);",
    "the setting must match the location plate (same room, lighting, colors).",
    `Compose a new cinematic shot: ${scene.image_prompt}`,
    STYLE_SUFFIX,
  ].join(" ");
}

/** 参照が無いときの従来プロンプト（外見はテキストだけで指定する）。 */
export function buildGeneratePrompt(scene) {
  const cast = castDescription(scene.characters);
  return `${scene.image_prompt}.${cast ? ` Characters (keep exactly this appearance): ${cast}.` : ""} ${STYLE_SUFFIX}`;
}

export async function generateImages(job, { force = false } = {}) {
  const openai = getOpenAI();
  const p = ensureDirs(job, "img");
  const data = readScript(job);
  // characters / location の既定値を埋めたビュー（プロンプト組み立てにだけ使う）
  const view = enrichedView(data);

  const size = process.env.IMG_SIZE ?? "1536x1024";
  const quality = process.env.IMG_QUALITY ?? "low";

  console.log(`[images] ${MODELS.image} / ${size} / ${quality} / ${view.scenes.length}枚 並列`);

  const tasks = view.scenes.map((scene, i) => async () => {
    const n = i + 1;
    const file = path.join(p.img, `s${n}.png`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`  s${n}: skip (既存)`);
      return { n, file, skipped: true, cost: 0, sec: 0, refs: 0 };
    }

    const refs = sceneRefs(scene);
    const useEdit = refs.files.length > 0;
    const prompt = useEdit ? buildEditPrompt(scene, refs) : buildGeneratePrompt(scene);
    const label = useEdit
      ? `edits ref=[${[...refs.chars, ...(refs.loc ? [`@${refs.loc}`] : [])].join(",")}]`
      : "generations (参照なし)";
    console.log(`  s${n}: ${label}`);

    const { result, sec, cost } = await timed(
      job,
      "image",
      async () => {
        const res = await withRetry(
          async () => {
            if (!useEdit) {
              return openai.images.generate({ model: MODELS.image, prompt, size, quality, n: 1 });
            }
            // Uploadable はストリームだと再送（リトライ）で使い回せないので毎回作り直す。
            const image = await Promise.all(
              refs.files.map((f) =>
                toFile(fs.readFileSync(f), path.basename(f), { type: "image/png" })
              )
            );
            return openai.images.edit({ model: MODELS.image, image, prompt, size, quality, n: 1 });
          },
          { label: `image s${n}` }
        );
        // 画像は枚数課金のため usage に images / quality を足しておく
        return {
          result: res,
          usage: { ...(res.usage ?? {}), images: 1, quality },
          model: MODELS.image,
        };
      },
      { scene: n, mode: useEdit ? "edits" : "generations", refs: refs.files.length }
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
    return { n, file, skipped: false, cost, sec, refs: refs.files.length };
  });

  const results = await Promise.all(tasks.map((t) => t()));
  const cost = results.reduce((a, r) => a + r.cost, 0);
  const made = results.filter((r) => !r.skipped).length;
  const noRef = results.filter((r) => !r.skipped && r.refs === 0).length;
  console.log(
    `[images] 生成 ${made}枚 / スキップ ${results.length - made}枚` +
      `${noRef ? ` / 参照なし ${noRef}枚（refs.mjs で基準画像を作ると揃います）` : ""} / 推定 ${fmtUSD(cost)}`
  );
  return { results, cost };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await generateImages(job, { force });
}
