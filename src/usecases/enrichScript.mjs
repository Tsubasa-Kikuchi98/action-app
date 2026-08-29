// ①' 台本の拡張: 既存 script.json を「予告編の演出情報」で非破壊的に拡張する。
//
// 既存フィールド（narration / telop / image_prompt / video_prompt / duration_sec /
// motion / nar_sec / clip_sec / base_sec / index）は**一切変更しない**。
// Veo クリップを作り直さずに演出だけ強化するための工程なので、
// 「絵と音の中身」に関わるフィールドには触れないのが鉄則。
import {
  SCENE_TYPES, TELOP_TIMINGS, STYLES, MAX_DIALOGUE, DEFAULT_CUT_COUNT, DEFAULT_TELOP_TIMING,
  DEFAULT_CAMERA_BEAT, guessSceneType, cutCap, isEnriched,
} from "../domain/script/index.mjs";
import { SPEAKERS, LOCATION_KEYS, defaultLocation } from "../domain/cast.mjs";
import { ENRICH_SCHEMA, buildEnrichSystemPrompt } from "../domain/prompts/enrichPrompt.mjs";
import { fmtUSD } from "../domain/pricing.mjs";

export { isEnriched };

/**
 * @param {object} deps { text: TextGenerator, store: JobStore, model: string }
 */
export async function enrichScript(deps, job, { force = false, dryRun = false } = {}) {
  const { text, store, model } = deps;
  const data = store.readScript(job);
  const n = data.scenes.length;

  // --dry-run は「既に拡張済み」でもプロンプトを確認できるよう先に処理する
  if (dryRun) {
    console.log(buildEnrichSystemPrompt(n));
    console.log("\n---- JSON SCHEMA ----");
    console.log(JSON.stringify(ENRICH_SCHEMA, null, 2));
    return { data, cost: 0, dryRun: true };
  }

  if (!force && isEnriched(data)) {
    console.log(`[enrich] skip (既に拡張済み。作り直すには --force)`);
    return { data, cost: 0, skipped: true };
  }

  const brief = data.scenes
    .map(
      (s, i) =>
        `#${i + 1} (${s.duration_sec ?? "?"}s)\n  ナレ: ${s.narration}\n  テロップ: ${s.telop}\n  絵: ${s.image_prompt}`
    )
    .join("\n");

  const { result, usage, sec, cost } = await store.timed(job, "enrich", async () => {
    const resp = await text.createStructured({
      model,
      system: buildEnrichSystemPrompt(n),
      user:
        `# 元になった出来事\n${data.episode ?? "(不明)"}\n\n` +
        `# 作品タイトル\n${data.title}\n\n` +
        `# 確定済みの ${n} シーン\n${brief}\n\n` +
        `この予告に演出情報を付けてください。`,
      schemaName: "trailer_enrichment",
      schema: ENRICH_SCHEMA,
    });
    return { result: resp, usage: resp.usage, model };
  });

  const raw = result.text ?? "";
  if (!raw) throw new Error("モデルからテキスト出力が得られませんでした");
  const add = JSON.parse(raw);

  // --- マージ（既存フィールドには一切触れない） ---------------------------
  const byIndex = new Map();
  for (const s of add.scenes ?? []) byIndex.set(Number(s.index), s);

  // セリフは全体で MAX_DIALOGUE 本まで。cold_open / setup には置かせない。
  const dlgOrder = ["turn", "montage", "resolve"];
  const candidates = data.scenes
    .map((s, i) => ({ i, a: byIndex.get(i + 1) }))
    .filter(({ a }) => a && String(a.dialogue ?? "").trim())
    .filter(({ a }) => dlgOrder.includes(a.scene_type))
    .slice(0, MAX_DIALOGUE);
  const keepDialogue = new Set(candidates.map((c) => c.i));

  data.scenes = data.scenes.map((s, i) => {
    const a = byIndex.get(i + 1) ?? {};
    const type = SCENE_TYPES.includes(a.scene_type) ? a.scene_type : guessSceneType(i, n);
    const dialogue = keepDialogue.has(i) ? String(a.dialogue ?? "").trim().slice(0, 20) : "";
    return {
      ...s, // ← 既存フィールドを温存
      scene_type: type,
      location: LOCATION_KEYS.includes(a.location) ? a.location : defaultLocation(type),
      cut_count: Math.max(1, Math.min(cutCap(type), Math.round(Number(a.cut_count) || DEFAULT_CUT_COUNT[type]))),
      motion_beat: String(a.motion_beat ?? "").trim(),
      camera_beat: String(a.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(a.ambient ?? "").trim(),
      visual_metaphor: String(a.visual_metaphor ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 60),
      dialogue,
      speaker: dialogue && SPEAKERS.includes(a.speaker) && a.speaker !== "none" ? a.speaker : dialogue ? "male_mature" : "none",
      telop_timing: TELOP_TIMINGS.includes(a.telop_timing) ? a.telop_timing : DEFAULT_TELOP_TIMING[type],
      screen_text: (Array.isArray(a.screen_text) ? a.screen_text : [])
        .map((t) => String(t).replace(/[\r\n]+/g, " ").trim())
        .filter((t) => t && t.length <= 14)
        .slice(0, 2),
    };
  });

  data.tagline = String(add.tagline ?? "").replace(/[\r\n]+/g, " ").trim();
  data.button_line = String(add.button_line ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 20);
  data.review_line = String(add.review_line ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 14);
  data.stake = String(add.stake ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 16);
  data.style = STYLES.includes(data.style) ? data.style : "narration";
  data.release_line = String(add.release_line ?? "").replace(/[\r\n]+/g, " ").trim();
  data.presents = String(add.presents ?? "").replace(/[\r\n]+/g, " ").trim();
  data.cast_lines = (Array.isArray(add.cast_lines) ? add.cast_lines : [])
    .map((t) => String(t).replace(/[\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 3);
  data.interstitials = (Array.isArray(add.interstitials) ? add.interstitials : [])
    .map((it) => ({
      text: String(it?.text ?? "").replace(/[\r\n]+/g, " ").trim(),
      after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
    }))
    .filter((it) => it.text)
    .slice(0, 2);
  data.enriched = true;
  data.enriched_at = new Date().toISOString();

  store.writeScript(job, data);

  // --- ログ ---------------------------------------------------------------
  console.log(`[enrich] ${store.paths(job).script}`);
  console.log(`  presents: ${data.presents || "(なし)"} / tagline: ${data.tagline || "(なし)"}`);
  console.log(`  review: ${data.review_line || "(なし)"} / stake: ${data.stake || "(なし)"} / button: ${data.button_line || "(なし)"}`);
  console.log(`  release: ${data.release_line || "(なし)"} / cast: ${data.cast_lines.join(" / ") || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / セリフ「${s.dialogue}」(${s.speaker})` : "";
    const st = s.screen_text.length ? ` / 画面 ${s.screen_text.join(",")}` : "";
    console.log(`   s${s.index} ${s.scene_type} @${s.location} cut=${s.cut_count} telop=${s.telop_timing}${dlg}${st}`);
    console.log(`      camera: ${s.camera_beat} / motion: ${s.motion_beat} / amb: ${s.ambient}`);
    if (s.visual_metaphor) console.log(`      翻訳: ${s.visual_metaphor}`);
  }
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, cost, sec, usage };
}
