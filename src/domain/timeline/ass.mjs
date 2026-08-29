// ASS（字幕）ファイルの文字列生成（純関数）。ファイル書き込みは adapters/ffmpeg/ass.mjs。
// テロップ・画面内テロップ・各カードの文字を「絶対時刻の ASS 1 枚」に集約する。
import { W, H, FONTNAME } from "./constants.mjs";

export const assTime = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
};

/** ASS の本文用エスケープ（オーバーライド括弧と改行を潰す）。 */
export const assText = (t) =>
  String(t).replace(/[\r\n]+/g, "\\N").replace(/\{/g, "｛").replace(/\}/g, "｝").trim();

/**
 * 絶対時刻の ASS を組む。テロップ・画面内テロップ・各カードの文字を 1 枚にまとめる。
 * Style: Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline,
 *        StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment,
 *        MarginL, MarginR, MarginV, Encoding
 */
export function buildAss(events) {
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // 本編テロップ: 大きめ・字間広め・柔らかい影。レターボックスの上に載る MarginV
    `Style: Telop,${FONTNAME},70,&H00FFFFFF,&H000000FF,&H00101010,&HB4000000,-1,0,0,0,100,100,14,0,1,0,4,2,90,90,176,1`,
    // 画面内テロップ: 小さめ・半透明・英数字
    `Style: Screen,${FONTNAME},40,&H55FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,6,0,1,0,2,7,0,0,0,1`,
    // 煽りテロップ（「情シスが泣いた」）: 小さめ・字間広め
    `Style: Review,${FONTNAME},46,&H00DCDCDC,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,26,0,1,0,0,5,0,0,0,1`,
    // button（タイトル後の落ち）: 演出を落とした素の一行
    `Style: Button,${FONTNAME},40,&H00E6E6E6,&H000000FF,&H00101010,&H00000000,0,0,0,0,100,100,4,0,1,0,0,5,0,0,0,1`,
    // 中間カード
    `Style: Inter,${FONTNAME},80,&H00FFFFFF,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,20,0,1,0,0,5,0,0,0,1`,
    // 冒頭 PRESENTS
    `Style: Presents,${FONTNAME},34,&H00E8E8E8,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,18,0,1,0,0,5,0,0,0,1`,
    // タイトル
    `Style: TitleMain,${FONTNAME},128,&H00FFFFFF,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,28,0,1,0,0,5,0,0,0,1`,
    `Style: TitleSub,${FONTNAME},44,&H00F0F0F0,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,16,0,1,0,0,5,0,0,0,1`,
    `Style: TitleRule,${FONTNAME},40,&H00FFFFFF,&H000000FF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: EndCard,${FONTNAME},96,&H00FFFFFF,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,30,0,1,0,0,5,0,0,0,1`,
    `Style: Coming,${FONTNAME},36,&H00E0E0E0,&H000000FF,&H00101010,&H00000000,-1,0,0,0,100,100,22,0,1,0,0,5,0,0,0,1`,
    `Style: Cast,${FONTNAME},24,&H00C8C8C8,&H000000FF,&H00101010,&H00000000,0,0,0,0,100,100,8,0,1,0,0,5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const body = events
    .filter((e) => e.text && e.end > e.start)
    .sort((a, b) => a.start - b.start)
    .map(
      (e) =>
        `Dialogue: ${e.layer ?? 0},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.tags ?? ""}${assText(e.text)}`
    );
  return head.concat(body).join("\n") + "\n";
}
