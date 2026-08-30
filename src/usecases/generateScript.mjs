// ① 台本生成: エピソード文 → out/<job>/script.json
// ポート（deps）にだけ依存する。API を呼ぶのは deps.text、保存は deps.store。
import { STYLES, DEFAULT_STYLE, normalize, lintScript } from "../domain/script/index.mjs";
import { buildScriptSchema, buildScriptSystemPrompt } from "../domain/prompts/scriptPrompt.mjs";
import { fmtUSD } from "../domain/pricing.mjs";

/** 生成した台本を人が読める形で表示する。 */
export function printScript(data) {
  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`  title: ${data.title}${data.tagline ? ` / ${data.tagline}` : ""}`);
  console.log(`  style: ${data.style} / presents: ${data.presents || "(なし)"} / release: ${data.release_line || "(なし)"}`);
  if (data.style !== "nolan") console.log(`  review: ${data.review_line || "(なし)"} / stake: ${data.stake || "(なし)"}`);
  if (data.style !== "nolan") console.log(`  button: ${data.button_line || "(なし)"} / cast: ${data.cast_lines.join(" / ") || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  console.log(`  scenes: ${data.scenes.length} / 合計 ${total.toFixed(1)}s`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / 「${s.dialogue}」(${s.speaker})` : "";
    console.log(`   s${s.index} [${s.scene_type}] @${s.location} ${s.duration_sec}s cut=${s.cut_count} ${s.telop_timing}`);
    console.log(`      ナレ: ${s.narration || "(なし)"}${dlg}`);
    console.log(`      テロップ: ${s.telop} / 翻訳: ${s.visual_metaphor || "(なし)"}`);
  }
}

/**
 * @param {object} deps { text: TextGenerator, store: JobStore, model: string }
 */
export async function generateScript(deps, episode, job, { style = DEFAULT_STYLE } = {}) {
  const { text, store, model } = deps;
  const wantStyle = STYLES.includes(style) ? style : "narration";
  const systemPrompt = buildScriptSystemPrompt(wantStyle);

  const { result, usage, sec, cost } = await store.timed(job, "script", async () => {
    const resp = await text.createStructured({
      model,
      system: systemPrompt,
      user: `次の「仕事で起きた失敗」を映画予告の台本にしてください（style: ${wantStyle}）。\n\n---\n${episode}\n---`,
      schemaName: "trailer_script",
      schema: buildScriptSchema(wantStyle),
    });
    return { result: resp, usage: resp.usage, model };
  }, { style: wantStyle });

  const raw = result.text ?? "";
  if (!raw) throw new Error(`モデルからテキスト出力が得られませんでした:\n${JSON.stringify(result.raw ?? result, null, 2).slice(0, 2000)}`);

  const data = normalize(JSON.parse(raw), episode, wantStyle, { model });
  store.writeScript(job, data);

  console.log(`[script] ${store.paths(job).script}`);
  printScript(data);
  const warns = lintScript(data);
  for (const w of warns) console.warn(`  [warn] ${w}`);
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, sec, cost, usage, warns };
}
