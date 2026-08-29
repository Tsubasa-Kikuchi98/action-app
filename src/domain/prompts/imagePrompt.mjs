// ② シーン画像のプロンプト組み立て（純関数）。
// 参照画像（キャラシート・ロケプレート）を添付する images/edits 経路と、
// 参照が 1 枚も無いときの images/generations 経路の 2 通り。
import { CAST, LOCATIONS, castDescription } from "../cast.mjs";

/** 全カットの見た目を揃えるための共通スタイル接尾辞。 */
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
