// 台本を読んで「原理を外していないか」を警告する純関数（削除・書き換えはしない）。
// 課金せずに何度でも回せるので、生成直後に必ず通す。
import {
  NAR_TOTAL_MAX, NOLAN_SCENE_TYPES, NOLAN_SPEAKER_BY_TYPE, findForbidden,
  DIALOGUE_MAX_CHARS, DIALOGUE_MIN_WORDS, DIALOGUE_MAX_WORDS, countWords, hasJapanese,
} from "./constants.mjs";

/**
 * セリフ 1 本を検査する（登場人物は欧米系なのでセリフは英語）。
 * @param {{index: number, dialogue: string}} s
 * @returns {string[]}
 */
function lintDialogue(s) {
  const d = s.dialogue;
  if (!d) return [];
  if (hasJapanese(d)) return [`s${s.index}: セリフ「${d}」に日本語が混ざっています（セリフは英語）`];
  const w = countWords(d);
  if (w < DIALOGUE_MIN_WORDS || w > DIALOGUE_MAX_WORDS) {
    return [`s${s.index}: セリフ「${d}」が ${w} 語（${DIALOGUE_MIN_WORDS}〜${DIALOGUE_MAX_WORDS} 語）`];
  }
  if (d.length > DIALOGUE_MAX_CHARS) return [`s${s.index}: セリフ「${d}」が ${d.length} 文字（${DIALOGUE_MAX_CHARS} 文字以内）`];
  if (/["“”「」]/.test(d)) return [`s${s.index}: セリフ「${d}」に引用符が残っています（本文だけを入れる）`];
  return [];
}

/**
 * @param {object} data 正規化済みの台本
 * @returns {string[]} 警告メッセージ（空配列なら問題なし）
 */
export function lintScript(data) {
  if (data.style === "nolan") return lintNolan(data);
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

  warns.push(...data.scenes.flatMap(lintDialogue));

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

/**
 * nolan の lint。構成が固定なので「3 セリフ・2 カード・ナレなし・カット内文字なし」を確かめる。
 * @param {object} data 正規化済みの台本（style: "nolan"）
 * @returns {string[]} 警告メッセージ
 */
function lintNolan(data) {
  const warns = [];
  const cards = (data.interstitials ?? []).map((it) => it.text);
  const texts = [
    data.title, data.tagline, data.presents, data.release_line, ...cards,
    ...data.scenes.map((s) => s.dialogue),
  ];
  const bad = [...new Set(texts.flatMap(findForbidden))];
  if (bad.length) warns.push(`禁句が含まれています: ${bad.join(" / ")}`);

  if (data.scenes.length !== 3) warns.push(`nolan は 3 シーン構成です（${data.scenes.length} シーン）`);
  const types = data.scenes.map((s) => s.scene_type).join(",");
  if (types !== NOLAN_SCENE_TYPES.join(",")) warns.push(`scene_type の並びが ${types}（想定は ${NOLAN_SCENE_TYPES.join(",")}）`);

  for (const s of data.scenes) {
    if (s.narration) warns.push(`s${s.index}: nolan にナレーションは入れません`);
    if (s.telop || (s.screen_text ?? []).length) warns.push(`s${s.index}: カット内に文字を出しません（telop / screen_text は空）`);
    if (!s.dialogue) warns.push(`s${s.index}: セリフがありません（全 3 シーン必須）`);
    else warns.push(...lintDialogue(s));
    const want = NOLAN_SPEAKER_BY_TYPE[s.scene_type];
    if (s.dialogue && want && s.speaker !== want) warns.push(`s${s.index}: 話者が ${s.speaker}（${s.scene_type} は ${want}）`);
    if (!s.visual_metaphor) warns.push(`s${s.index}: visual_metaphor が空`);
    else if (!/[→>]/.test(s.visual_metaphor)) warns.push(`s${s.index}: visual_metaphor が「現実 → 演出」の形になっていない`);
    if (s.cut_count !== 1) warns.push(`s${s.index}: nolan は 1 クリップ 1 カットです（cut_count=${s.cut_count}）`);
  }

  const dlgs = data.scenes.map((s) => s.dialogue).filter(Boolean);
  if (new Set(dlgs).size !== dlgs.length) warns.push("同じセリフが 2 回出ています");

  if (cards.length !== 2) warns.push(`中間カードが ${cards.length} 枚です（2 枚必須）`);
  cards.forEach((t, i) => {
    if (!t) warns.push(`中間カード${i + 1} が空です`);
    else if (t.length > 14) warns.push(`中間カード${i + 1}「${t}」が ${t.length} 字（14 字以内）`);
  });
  const pos = (data.interstitials ?? []).map((it) => it.after_scene).join(",");
  if (pos !== "1,2") warns.push(`中間カードの位置が ${pos || "(なし)"}（想定は 1,2）`);

  if (data.review_line || data.stake || data.button_line || (data.cast_lines ?? []).length) {
    warns.push("nolan では review_line / stake / button_line / cast_lines を使いません");
  }
  if (!data.title) warns.push("title が空です");
  else if (data.title.length > 12) warns.push(`title「${data.title}」が ${data.title.length} 字（12 字以内が字間を広げやすい）`);

  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  if (total !== 10) warns.push(`映像の合計尺 ${total}s（nolan は 3+4+3=10s）`);
  return warns;
}
