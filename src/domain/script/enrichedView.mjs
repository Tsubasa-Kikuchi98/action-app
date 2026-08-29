// 旧 script.json 互換ビュー（純関数・非破壊）。
// enrich していない台本（demo1 など）でも render / images / video が同じ形で読めるように、
// 拡張フィールドを既定値で埋めた「読み取り専用のビュー」を返す。
import {
  SCENE_TYPES, TELOP_TIMINGS, STYLES, DEFAULT_CUT_COUNT, DEFAULT_TELOP_TIMING,
  DEFAULT_CAMERA_BEAT, guessSceneType, cutCap,
} from "./constants.mjs";
import { SPEAKERS, LEGACY_SPEAKER, LOCATION_KEYS, defaultLocation } from "../cast.mjs";

/**
 * @param {object} data script.json の中身
 * @returns {object} 拡張フィールドが必ず存在する形のビュー（data は変更しない）
 */
export function enrichedView(data) {
  const n = data.scenes.length;
  const enriched = data.enriched === true;
  const scenes = data.scenes.map((s, i) => {
    const type = SCENE_TYPES.includes(s.scene_type) ? s.scene_type : guessSceneType(i, n);
    // 未 enrich の台本はカットを割らない（同じ静止画を何度も見せないため）
    const cut = enriched
      ? Math.max(1, Math.min(cutCap(type), Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type])))
      : 1;
    return {
      ...s,
      narration: String(s.narration ?? "").trim(),
      visual_metaphor: String(s.visual_metaphor ?? "").trim(),
      index: s.index ?? i + 1,
      scene_type: type,
      location: LOCATION_KEYS.includes(s.location) ? s.location : defaultLocation(type),
      cut_count: cut,
      motion_beat: String(s.motion_beat ?? "").trim(),
      camera_beat: String(s.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(s.ambient ?? "").trim(),
      dialogue: enriched ? String(s.dialogue ?? "").trim() : "",
      speaker: SPEAKERS.includes(s.speaker) ? s.speaker : (LEGACY_SPEAKER[s.speaker] ?? "none"),
      telop_timing: TELOP_TIMINGS.includes(s.telop_timing)
        ? s.telop_timing
        : DEFAULT_TELOP_TIMING[type],
      screen_text: enriched
        ? (Array.isArray(s.screen_text) ? s.screen_text : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 2)
        : [],
    };
  });
  return {
    ...data,
    enriched,
    scenes,
    style: STYLES.includes(data.style) ? data.style : "narration",
    tagline: String(data.tagline ?? "").trim(),
    // Phase 3 / パロディ強化。旧 script.json には無いので空文字に落ちる（render 側で分岐）。
    button_line: enriched ? String(data.button_line ?? "").trim() : "",
    review_line: enriched ? String(data.review_line ?? "").trim() : "",
    stake: enriched ? String(data.stake ?? "").trim() : "",
    release_line: String(data.release_line ?? "").trim(),
    presents: String(data.presents ?? "").trim(),
    cast_lines: (Array.isArray(data.cast_lines) ? data.cast_lines : [])
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 3),
    interstitials: (Array.isArray(data.interstitials) ? data.interstitials : [])
      .map((it) => ({
        text: String(it?.text ?? "").trim(),
        after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
      }))
      .filter((it) => it.text)
      .slice(0, 2),
  };
}

/** 既に拡張済みかどうか（--force なしのスキップ判定に使う）。 */
export function isEnriched(data) {
  return data?.enriched === true;
}
