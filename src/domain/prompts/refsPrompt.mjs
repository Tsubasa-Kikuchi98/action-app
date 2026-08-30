// ⓪ 基準画像（キャラクターシート・ロケーションプレート）のプロンプト（純関数）。
import { CAST, LOCATIONS, LOCATION_KEYS } from "../cast.mjs";

// 文字を描かせないこと・人物を入れないことは gpt-image-2 が破りがちなので、
// 肯定形（plain clean backdrop / an empty room）と否定形の両方を書く。
export const NO_TEXT =
  "clean unmarked surfaces, no text, no letters, no numbers, no captions, no labels, no logos, no watermark, no borders, no frame";

/** キャラクターシート（同一人物の 3 ビューを 1 枚に）。 */
export function buildCharPrompt(key) {
  const c = CAST[key];
  if (!c) throw new Error(`未知のキャラクター: ${key}（${Object.keys(CAST).join(" / ")}）`);
  return [
    "A character reference sheet for a film production, laid out as one wide image with three views side by side, left to right:",
    "(1) a front-facing bust portrait, (2) a three-quarter 45-degree bust portrait, (3) a full-body standing shot.",
    "It is the same person in three views: identical face, identical hairstyle, identical clothing and identical build in all three views.",
    `Subject: ${c.en}.`,
    "Photorealistic, contemporary corporate look, sharp focus, neutral colour, flat even studio lighting from the front, a plain smooth medium-grey backdrop behind the whole frame, neutral relaxed expression, arms at the sides, empty backdrop with no props and no furniture.",
    NO_TEXT + ".",
  ].join(" ");
}

/** ロケーションの基準プレート（人物なしのワイド）。 */
export function buildLocPrompt(key) {
  const l = LOCATIONS[key];
  if (!l) throw new Error(`未知のロケーション: ${key}（${LOCATION_KEYS.join(" / ")}）`);
  return [
    `A location reference plate for a film production: a wide establishing shot of ${l.en}.`,
    "The room is empty of people; not a single person is visible anywhere in the frame.",
    "Photorealistic, cinematic, wide-angle, eye-level, the whole room readable in one frame, anamorphic lens, film grain,",
    "and this is the master plate: the lighting direction, colour temperature, furniture and props here define how this place looks in every later shot.",
    NO_TEXT + ".",
  ].join(" ");
}
