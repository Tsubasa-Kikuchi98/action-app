// 台本を読んで「原理を外していないか」を警告する純関数（削除・書き換えはしない）。
// 課金せずに何度でも回せるので、生成直後に必ず通す。
import { NAR_TOTAL_MAX, findForbidden } from "./constants.mjs";

/**
 * @param {object} data 正規化済みの台本
 * @returns {string[]} 警告メッセージ（空配列なら問題なし）
 */
export function lintScript(data) {
  const warns = [];
  const texts = [
    data.title, data.tagline, data.presents, data.release_line, data.button_line,
    data.review_line, data.stake, ...(data.cast_lines ?? []),
    ...(data.interstitials ?? []).map((it) => it.text),
    ...data.scenes.flatMap((s) => [s.narration, s.telop, s.dialogue]),
  ];
  const bad = [...new Set(texts.flatMap(findForbidden))];
  if (bad.length) warns.push(`禁句が含まれています: ${bad.join(" / ")}`);

  const narTotal = data.scenes.reduce((a, s) => a + s.narration.length, 0);
  if (narTotal > NAR_TOTAL_MAX) warns.push(`ナレ合計 ${narTotal} 字（上限 ${NAR_TOTAL_MAX} 字）`);

  if (!data.review_line) warns.push("review_line が空です");
  if (!data.stake) warns.push("stake が空です");
  else if (!/[0-9０-９一二三四五六七八九十百千万]/.test(data.stake)) warns.push(`stake に数字がありません: ${data.stake}`);

  const noMeta = data.scenes.filter((s) => !s.visual_metaphor).map((s) => `s${s.index}`);
  if (noMeta.length) warns.push(`visual_metaphor が空: ${noMeta.join(", ")}`);
  const noArrow = data.scenes.filter((s) => s.visual_metaphor && !/[→>]/.test(s.visual_metaphor)).map((s) => `s${s.index}`);
  if (noArrow.length) warns.push(`visual_metaphor が「現実 → 演出」の形になっていない: ${noArrow.join(", ")}`);

  const dlg = data.scenes.filter((s) => s.dialogue).length;
  const wantDlg = data.style === "dialogue" ? 4 : 3;
  if (dlg < 2) warns.push(`セリフが ${dlg} 本しかありません（${data.style === "dialogue" ? "案 B は 4 本" : "2〜3 本"}）`);
  if (dlg > wantDlg) warns.push(`セリフが ${dlg} 本あります（上限 ${wantDlg}）`);

  const pos = (data.interstitials ?? []).map((it) => it.after_scene).join(",");
  if (data.scenes.length === 5 && pos !== "2,3") warns.push(`中間カードの位置が ${pos || "(なし)"}（想定は 2,3）`);

  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  if (total < 18 || total > 26) warns.push(`映像の合計尺 ${total}s（想定 20〜22s）`);

  const telops = data.scenes.map((s) => s.telop).filter(Boolean);
  if (new Set(telops).size !== telops.length) warns.push("同じテロップが 2 回出ています");

  if (data.style === "dialogue") {
    const nars = data.scenes.filter((s) => s.narration).length;
    if (nars > 2) warns.push(`案 B なのにナレが ${nars} 本あります（2 本まで）`);
  }
  return warns;
}
