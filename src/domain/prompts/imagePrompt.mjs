// ② シーン画像のプロンプト組み立て（純関数）。
// 参照画像（キャラシート・ロケプレート）を添付する images/edits 経路と、
// 参照が 1 枚も無いときの images/generations 経路の 2 通り。
import { CAST, LOCATIONS, castDescription } from "../cast.mjs";

/** 全カットの見た目を揃えるための共通スタイル接尾辞。 */
export const STYLE_SUFFIX =
  "cinematic still, anamorphic lens, teal and orange grade, film grain, dramatic lighting, shallow depth of field, no text, no letters, no logos, no subtitles, no watermark";

/**
 * nolan（style: "nolan"）用のスタイル接尾辞。
 * 彩度を落とした鋼色の青・硬いコントラスト・広いシンメトリー構図・実光源のみ。
 * セリフを口パクで喋らせるので「口元が見える」ことを必ず要求する。
 */
export const NOLAN_STYLE_SUFFIX =
  "Cinematic still in the restrained style of a Christopher Nolan trailer: a wide symmetrical composition with the subject " +
  "centred in frame and the room falling away evenly on both sides, eye-level camera, natural perspective, " +
  "desaturated steel-blue palette, hard directional contrast with deep shadows, lit only by light sources visible in the shot " +
  "(monitors, ceiling strips, the window), fine grain, no colour tinting beyond the steel blue. " +
  "The person's head is turned toward the camera at a front or 45-degree angle so the face and mouth are clearly visible and large enough to read. " +
  "No text, no letters, no numbers on screen, no logos, no subtitles, no watermark.";

/** style に応じたスタイル接尾辞。 */
export const styleSuffix = (style) => (style === "nolan" ? NOLAN_STYLE_SUFFIX : STYLE_SUFFIX);

/** 参照画像を渡すときのプロンプト。参照の並び順を明示して取り違えを防ぐ。 */
export function buildEditPrompt(scene, refs, style = "narration") {
  const order = [
    ...refs.chars.map((k) => `a character sheet (three views of the same person) of ${CAST[k].en}`),
    ...(refs.loc ? [`a location plate of ${LOCATIONS[refs.loc].en}`] : []),
  ];
  return [
    `Reference images, in this order: ${order.join("; ")}.`,
    "Use the reference images: the people must look exactly like the character sheets (same face, hair, clothing)",
    // ロケプレートを添付していないときに「プレートに合わせろ」と言うと、モデルが
    // 存在しない参照を探して構図が崩れる。プレートがあるときだけ書く。
    refs.loc
      ? "; the setting must match the location plate (same room, lighting, colors)."
      : ". Build the setting from the description below.",
    `Compose a new cinematic shot: ${scene.image_prompt}`,
    styleSuffix(style),
  ].join(" ");
}

/** 参照が無いときの従来プロンプト（外見はテキストだけで指定する）。 */
export function buildGeneratePrompt(scene, style = "narration") {
  const cast = castDescription(scene.characters);
  return `${scene.image_prompt}.${cast ? ` Characters (keep exactly this appearance): ${cast}.` : ""} ${styleSuffix(style)}`;
}
