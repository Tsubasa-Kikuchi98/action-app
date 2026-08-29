// モデル出力の正規化（純関数）。旧 script.json との互換のため既定値で埋める。
// 外部依存なし。時刻とモデル名は呼び出し側（usecase）から渡す。
import {
  SCENE_TYPES, TELOP_TIMINGS, STYLES, DEFAULT_STYLE, SCENE_COUNT,
  DURATION_RAMP, DEFAULT_CUT_COUNT, DEFAULT_CAMERA_BEAT,
  guessSceneType, cutCap, maxDialogue,
} from "./constants.mjs";
import { CAST, SPEAKERS, LEGACY_SPEAKER, LOCATION_KEYS, defaultLocation } from "../cast.mjs";

/** 改行を潰して 1 行にする。 */
export const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

/**
 * @param {object} data      モデルの生出力（JSON.parse 済み）
 * @param {string} episode   元になったエピソード文
 * @param {string} [style]   narration | dialogue
 * @param {{model?: string, createdAt?: string, sceneCount?: number, warn?: (msg: string) => void}} [opts]
 * @returns {object} 正規化した台本（引数の data を破壊的に更新して返す）
 */
export function normalize(data, episode, style = DEFAULT_STYLE, opts = {}) {
  const {
    model = "",
    createdAt = new Date().toISOString(),
    sceneCount = SCENE_COUNT,
    warn = (m) => console.warn(m),
  } = opts;

  if (!Array.isArray(data.scenes) || data.scenes.length === 0) throw new Error("scenes が空です");
  if (data.scenes.length !== sceneCount) {
    warn(`  [warn] scenes が ${data.scenes.length} 件でした → ${sceneCount} 件に調整します`);
    data.scenes = data.scenes.slice(0, sceneCount);
    while (data.scenes.length < sceneCount) data.scenes.push({ ...data.scenes[data.scenes.length - 1] });
  }
  const n = data.scenes.length;
  const wantStyle = STYLES.includes(style) ? style : "narration";

  // セリフは全体で maxDialogue 本まで（cold_open / setup には置かせない）
  // 案 B（dialogue）だけは setup にも置ける（S2 のセリフ①が構成上必要なため）
  const allowed = new Set(wantStyle === "dialogue" ? ["setup", "turn", "montage", "resolve"] : ["turn", "montage", "resolve"]);
  const dlgMax = maxDialogue(wantStyle);
  let kept = 0;
  let onSilence = 0;

  data.scenes = data.scenes.map((s, i) => {
    const type = SCENE_TYPES.includes(s.scene_type) ? s.scene_type : guessSceneType(i, n);
    const rawDlg = oneLine(s.dialogue);
    const dialogue = rawDlg && allowed.has(type) && kept < dlgMax ? (kept++, rawDlg.slice(0, 20)) : "";
    // 声はシーンごとに一方だけ: turn / montage はセリフ優先、それ以外はナレ優先
    const voiceScene = ["turn", "montage"].includes(type);
    const narrationText = voiceScene && dialogue ? "" : String(s.narration ?? "").trim();
    const dialogueText = !voiceScene && narrationText ? "" : dialogue;

    let timing = TELOP_TIMINGS.includes(s.telop_timing)
      ? s.telop_timing
      : ["turn", "montage"].includes(type) ? "cut_head" : "after_narration";
    // on_silence は予告全体で 1 回まで（音を落とす演出は繰り返すと効かない）
    if (timing === "on_silence" && ++onSilence > 1) timing = "cut_head";

    return {
      narration: oneLine(narrationText),
      telop: oneLine(s.telop).slice(0, 15),
      image_prompt: String(s.image_prompt ?? "").trim(),
      video_prompt: String(s.video_prompt ?? "").trim(),
      // Veo は 4 / 6 / 8 秒のみ。narration がナレ実尺に応じて丸め上げる。
      duration_sec: [4, 6, 8].includes(Number(s.duration_sec))
        ? Number(s.duration_sec)
        : DURATION_RAMP[i] ?? 4,
      index: i + 1,
      scene_type: type,
      location: LOCATION_KEYS.includes(s.location) ? s.location : defaultLocation(type),
      cut_count: Math.max(1, Math.min(cutCap(type), Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type]))),
      visual_metaphor: oneLine(s.visual_metaphor).slice(0, 60),
      motion_beat: String(s.motion_beat ?? "").trim(),
      camera_beat: String(s.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(s.ambient ?? "").trim(),
      dialogue: dialogueText,
      speaker: dialogueText
        ? (SPEAKERS.includes(s.speaker) && s.speaker !== "none" ? s.speaker : (LEGACY_SPEAKER[s.speaker] ?? "hero"))
        : "none",
      characters: (Array.isArray(s.characters) ? s.characters : []).filter((c) => CAST[c]).slice(0, 3),
      telop_timing: timing,
      screen_text: (Array.isArray(s.screen_text) ? s.screen_text : [])
        .map((t) => oneLine(t))
        .filter((t) => t && t.length <= 14)
        .slice(0, 2),
    };
  });

  data.title = oneLine(data.title) || "無題";
  data.tagline = oneLine(data.tagline);
  data.presents = oneLine(data.presents);
  data.release_line = oneLine(data.release_line);
  data.style = wantStyle;
  data.button_line = oneLine(data.button_line).slice(0, 20);
  data.review_line = oneLine(data.review_line).slice(0, 14);
  data.stake = oneLine(data.stake).slice(0, 16);
  data.cast_lines = (Array.isArray(data.cast_lines) ? data.cast_lines : [])
    .map(oneLine).filter(Boolean).slice(0, 3);
  data.interstitials = (Array.isArray(data.interstitials) ? data.interstitials : [])
    .map((it) => ({
      text: oneLine(it?.text),
      after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
    }))
    .filter((it) => it.text)
    .slice(0, 2);
  data.episode = episode;
  data.model = model;
  data.created_at = createdAt;
  // enrich と同じ「拡張済み」マーカー。render はこれを見てカット割り等を有効にする。
  data.enriched = true;
  return data;
}
