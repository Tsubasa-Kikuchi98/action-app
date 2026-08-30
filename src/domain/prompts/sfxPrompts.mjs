// 効果音（SFX）と BGM のプロンプト（純粋な文字列データ）。
// SFX は assets/sfx/ にジョブ横断で 1 度だけ作って使い回す（生成のたびに音が変わるのを防ぐ）。

/**
 * 作る効果音の仕様。name はそのままファイル名（assets/sfx/<name>.wav）になる。
 * nolan のカードは「文字が出た瞬間に低音が来る」ことが命なので、
 * アタックが立って余韻が短いものを 2 種類（同じ型の繰り返しを避けるため）＋
 * タイトル用に「吸い込み → ヒット」を 1 種類だけ用意する。
 */
export const SFX_SPECS = [
  {
    name: "braam",
    text:
      "A single massive cinematic braam: one deep low brass hit with a huge sub-bass impact underneath, " +
      "hard immediate attack, dark and dry, decaying to silence. No melody, no rhythm, no music bed, one hit only.",
    durationSec: 1.3,
    promptInfluence: 0.6,
  },
  {
    name: "braam2",
    text:
      "A second, slightly lower cinematic braam: one enormous low brass and synth-bass hit, " +
      "hard attack with a short metallic tail, dark, dry and menacing, decaying to silence. " +
      "No melody, no rhythm, one hit only.",
    durationSec: 1.2,
    promptInfluence: 0.7,
  },
  {
    name: "riser",
    text:
      "A short reverse whoosh sucking inwards for half a second and landing on one huge low impact, " +
      "then decaying. Dark, cinematic trailer title hit. No melody, no music, no rhythm.",
    durationSec: 1.2,
    promptInfluence: 0.5,
  },
];

export const SFX_NAMES = SFX_SPECS.map((s) => s.name);

/** nolan の BGM（20 秒・インスト固定）。 */
export const NOLAN_MUSIC_PROMPT =
  "dark cinematic trailer underscore, ticking clock, low brass, rising tension, minimal melody, ends on a hard stop";

/** 既存（narration / dialogue）の BGM。 */
export const TRAILER_MUSIC_PROMPT =
  "Epic cinematic movie trailer score. Deep braams, low pulsing drone, tense ostinato strings, " +
  "building percussion hits, rising tension into a triumphant climax. Fully instrumental, no vocals.";

/** style 別の BGM プロンプトと長さ（ms）。 */
export function musicSpec(style, totalSec = 0) {
  if (style === "nolan") {
    return { prompt: NOLAN_MUSIC_PROMPT, lengthMs: Math.round((totalSec || 20) * 1000) };
  }
  return { prompt: TRAILER_MUSIC_PROMPT, lengthMs: 45000 };
}
