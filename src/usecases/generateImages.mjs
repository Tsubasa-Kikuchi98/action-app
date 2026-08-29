// ② 画像生成: script.json の image_prompt → out/<job>/img/s1..s5.png
//
// 5 枚を並列生成するので、そのままだと同じ「主人公」でも顔・服が毎回変わり、
// 同じ「オフィス」でも部屋が別物になる。そこで assets/refs/ の基準画像
// （キャラクターシート・ロケーションプレート。prepareRefs で作る）を
// **images/edits の参照画像として毎回添付**して見た目を揃える。
//   image[] = そのシーンの characters のキャラシート（最大 3 枚）＋ location のプレート（1 枚）
// 参照が 1 枚も無いシーンは従来どおり images/generations にフォールバックする。
//
// 既存ファイルはスキップ（--force で再生成）。429/5xx は指数バックオフでリトライ。
import path from "node:path";
import { enrichedView } from "../domain/script/index.mjs";
import { buildEditPrompt, buildGeneratePrompt } from "../domain/prompts/imagePrompt.mjs";
import { fmtUSD } from "../domain/pricing.mjs";

/**
 * @param {object} deps { image, store, refs, model }
 */
export async function generateImages(deps, job, { force = false } = {}) {
  const { image, store, refs, files, model } = deps;
  const p = store.ensureDirs(job, "img");
  const data = store.readScript(job);
  // characters / location の既定値を埋めたビュー（プロンプト組み立てにだけ使う）
  const view = enrichedView(data);

  const size = process.env.IMG_SIZE ?? "1536x1024";
  const quality = process.env.IMG_QUALITY ?? "low";

  console.log(`[images] ${model} / ${size} / ${quality} / ${view.scenes.length}枚 並列`);

  const tasks = view.scenes.map((scene, i) => async () => {
    const n = i + 1;
    const file = path.join(p.img, `s${n}.png`);
    if (!force && files.ready(file)) {
      console.log(`  s${n}: skip (既存)`);
      return { n, file, skipped: true, cost: 0, sec: 0, refs: 0 };
    }

    const sr = refs.sceneRefs(scene);
    const useEdit = sr.files.length > 0;
    const prompt = useEdit ? buildEditPrompt(scene, sr) : buildGeneratePrompt(scene);
    const label = useEdit
      ? `edits ref=[${[...sr.chars, ...(sr.loc ? [`@${sr.loc}`] : [])].join(",")}]`
      : "generations (参照なし)";
    console.log(`  s${n}: ${label}`);

    const { result, sec, cost } = await store.timed(
      job,
      "image",
      async () => {
        const res = useEdit
          ? await image.edit({ model, prompt, images: sr.files, size, quality, label: `image s${n}` })
          : await image.generate({ model, prompt, size, quality, label: `image s${n}` });
        // 画像は枚数課金のため usage に images / quality を足しておく
        return { result: res, usage: { ...(res.usage ?? {}), images: 1, quality }, model };
      },
      { scene: n, mode: useEdit ? "edits" : "generations", refs: sr.files.length }
    );

    const buf = result.buffer;
    files.write(file, buf);
    console.log(`  s${n}: ${file} (${(buf.length / 1024).toFixed(0)}KB, ${sec.toFixed(1)}s)`);
    return { n, file, skipped: false, cost, sec, refs: sr.files.length };
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
