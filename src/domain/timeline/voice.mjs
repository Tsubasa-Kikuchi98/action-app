// クリップの中で「人が喋っている区間」を選ぶ純関数。
//
// nolan は 8 秒生成したクリップから 3〜4 秒だけを使う。頭から機械的に切ると
// セリフの途中で切れてしまう（Veo は 2〜4 秒あたりで喋り出すことが多い）ので、
// 音声帯域のレベル列から発話区間を推定し、その区間が収まる位置から切り出す。

/** 無音として扱う下限（dB）。astats は無音で -inf を返すことがある。 */
const FLOOR = -100;

/**
 * 音声帯域のレベル列から発話区間を推定する。
 * @param {Array<{t: number, rms: number}>} levels 窓の開始時刻とその窓の RMS（dB）
 * @param {number} windowSec 1 窓の長さ（秒）
 * @returns {{start: number, end: number, peak: number}|null} 発話区間（見つからなければ null）
 */
export function detectVoiceSpan(levels, windowSec) {
  const xs = (levels ?? [])
    .map((l) => ({ t: l.t, rms: Number.isFinite(l.rms) ? l.rms : FLOOR }))
    .sort((a, b) => a.t - b.t);
  if (!xs.length) return null;

  const peak = Math.max(...xs.map((x) => x.rms));
  if (peak <= -55) return null; // クリップ全体が無音（＝喋っていない）
  // ピークから 12dB 落ちるまでを発話とみなす。環境音だけの窓を拾わないよう下限も置く。
  const th = Math.max(peak - 12, -45);

  // **最初の**まとまった発話を採る（後半のより大きい音＝群衆・物音や 2 回目の発話に
  // 引っ張られないようにする。Veo クリップは後半ほど破綻しやすいので前半を優先する）。
  // 1 窓だけの落ち込みは息継ぎとみなして繋ぐ。
  const hit = xs.map((x) => x.rms >= th);
  const a = hit.indexOf(true);
  if (a < 0) return null;
  let b = a;
  for (let i = a + 1; i < xs.length; i++) {
    if (hit[i]) b = i;
    else if (i + 1 < xs.length && hit[i + 1]) continue; // 1 窓だけの谷は繋ぐ
    else break;
  }
  return { start: xs[a].t, end: xs[b].t + windowSec, peak };
}

/**
 * 発話区間が収まるように切り出し開始位置を決める。
 * 余裕があれば発話を窓の中央に置き、足りなければ発話の直前から始める。
 * @param {{start: number, end: number}|null} span detectVoiceSpan の戻り値
 * @param {{clipSec: number, needSec: number, minLead?: number}} opts
 * @returns {number} srcIn（秒）
 */
export function pickSrcIn(span, { clipSec, needSec, minLead = 0.25 }) {
  const maxIn = Math.max(0, clipSec - needSec);
  if (!span) return 0;
  const span_ = Math.max(0, span.end - span.start);
  const lead = span_ >= needSec ? minLead : Math.max(minLead, (needSec - span_) / 2);
  return Math.min(maxIn, Math.max(0, span.start - lead));
}
