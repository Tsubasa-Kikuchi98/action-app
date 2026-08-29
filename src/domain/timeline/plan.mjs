// タイムライン設計（純関数）。script.json（enrichedView 済み）と「実測済みの素材情報」から、
// カット / カード / 音イベント / ASS イベントの並びを組む。
//
//   - cut_count に従って各シーンを split/trim（前半優先）→ 終盤ほど短いカットランプ
//   - turn / montage は crop+scale で疑似寄り、手ブレ、モンタージュの 1 カットはスロー
//   - 加速点に白 2 フレームのフラッシュ
//   - 冒頭 PRESENTS カード / 煽りカード / 中間カード / stopdown（無音の黒）/ タイトル / エンドカード
//   - xfade は cold_open → setup の 1 箇所だけ。offset は Σクリップ長 − Σトランジション長
//
// ffprobe による実測（尺・環境音レベル）は usecases/renderTrailer.mjs が行い、src[] として渡す。
import {
  PRESENTS_SEC, REVIEW_SEC, INTER_SEC, STOPDOWN_SEC, TITLE_SEC, END_CARD_SEC,
  SILENT_TELOP_SEC, FLASH_SEC, MIN_CUT, MIN_SCENE, NAR_LEAD, NAR_TAIL, DLG_GAP, DLG_TAIL,
  XFADE_SEC, ZOOM_BY_TYPE, SHAKE_TYPES, MAX_CUT_BY_TYPE, MAX_CUTS_PER_SCENE,
  TELOP_MAX_CUT_HEAD, TELOP_MAX_AFTER_NAR, SLOW_FACTOR, snap,
} from "./constants.mjs";

/**
 * @param {object} view enrichedView() を通した台本
 * @param {Array<object>} src 各シーンの実測情報
 *   { i, n, s, useVideo, vid, img, clipSec, hasAudio, gainDb, narFile, hasNar, narSec, dlgFile, hasDlg, dlgSec }
 * @returns {object} { segs, nar, dlg, btn, ass, total, xfadeAfter, xfadeSec, silence, silences, src }
 */
export function planTimeline(view, src) {
  const n = view.scenes.length;
  const segs = [];
  const nar = [];
  const dlg = [];
  const btn = [];       // button_line（タイトル後の落ち）。0 or 1 本
  const silences = [];  // 全レーンを落とす区間（stopdown と telop_timing: on_silence）
  const ass = [];

  // --- スロー / フラッシュを入れる位置を決める ----------------------------
  const montageIdx = view.scenes.findIndex((s) => s.scene_type === "montage");
  const accelIdx = montageIdx >= 0 ? montageIdx : Math.max(1, n - 2); // 白フラッシュを入れる直前のシーン
  const slowIdx = montageIdx >= 0 ? montageIdx : view.scenes.findIndex((s) => s.scene_type === "turn");

  // --- 冒頭 PRESENTS カード ----------------------------------------------
  let t = 0;
  const push = (seg) => {
    seg.outSec = snap(seg.outSec);
    seg.absStart = t;
    t += seg.outSec;
    segs.push(seg);
    return seg;
  };

  if (view.presents) {
    const c = push({ kind: "card", color: "black", outSec: PRESENTS_SEC });
    ass.push({
      style: "Presents", start: c.absStart, end: c.absStart + c.outSec,
      tags: `{\\pos(960,540)\\fad(400,350)}`, text: view.presents,
    });
  }

  // --- 煽りテロップ（review_line）: 提供カードの直後に 1 枚だけ ------------
  if (view.review_line) {
    const c = push({ kind: "card", color: "black", outSec: REVIEW_SEC });
    ass.push({
      style: "Review", start: c.absStart, end: c.absStart + c.outSec,
      tags: `{\\pos(960,540)\\fad(220,220)}`, text: view.review_line,
    });
  }

  // --- 中間カード: 2 枚目に賭け金（stake）を入れる ------------------------
  // trailer-structure §9-6: 2 枚目は montage 直前の「賭け金」。
  // interstitials 側に既に同じ文言が入っているときは重複させない。
  const inter = view.interstitials.map((it) => ({ ...it }));
  if (view.stake && !inter.some((it) => it.text.includes(view.stake) || view.stake.includes(it.text))) {
    if (inter.length >= 2) inter[1].text = view.stake;
    else if (inter.length === 1) inter.push({ text: view.stake, after_scene: Math.min(n - 1, inter[0].after_scene + 1) });
    else inter.push({ text: view.stake, after_scene: Math.max(1, n - 2) });
  }

  // --- 本編 ---------------------------------------------------------------
  let xfadeAfter = -1; // この segments index の直後で xfade する
  for (const m of src) {
    const { s, i } = m;

    // シーンの表示尺: ナレが必ず収まり、セリフがあればその分伸ばす
    let D = Math.max(m.hasNar ? m.narSec + NAR_LEAD + NAR_TAIL : (s.duration_sec ?? MIN_SCENE), MIN_SCENE);
    if (m.hasDlg) D = Math.max(D, NAR_LEAD + m.narSec + DLG_GAP + m.dlgSec + DLG_TAIL);
    // on_silence は「声が終わってから音を落とす」ので、その分シーンを伸ばして席を作る
    if (s.telop_timing === "on_silence") {
      const voiceLen = NAR_LEAD + (m.hasNar ? m.narSec : 0) + (m.hasDlg ? DLG_GAP + m.dlgSec : 0);
      D = Math.max(D, voiceLen + 0.1 + SILENT_TELOP_SEC + 0.25);
    }
    D = snap(D);

    // カット数: cut_count を下限に、1 カットが MAX_CUT_BY_TYPE を超えないよう増やす。
    // （セリフでシーンが伸びても「終盤ほど細かい」ランプが崩れないようにするため）
    // ただし静止画は同じ絵を割っても「別アングル」に見えないので 2 カットまで。
    // 未 enrich の旧 script.json はランプを掛けず 1 シーン 1 カットのまま（Phase 1/2 互換）。
    const maxCut = MAX_CUT_BY_TYPE[s.scene_type] ?? MAX_CUT_BY_TYPE.setup;
    const hardCap = m.useVideo ? MAX_CUTS_PER_SCENE : 2;
    const want = view.enriched ? Math.max(s.cut_count, Math.ceil(D / maxCut)) : s.cut_count;
    const K = Math.max(1, Math.min(want, hardCap, Math.floor(D / MIN_CUT)));

    // カット長: シーン内でも後半をわずかに短くする
    const wts = Array.from({ length: K }, (_, j) => 1 - 0.12 * j);
    const wsum = wts.reduce((a, b) => a + b, 0);
    const lens = wts.map((w) => snap((D * w) / wsum));

    // 加速点の白フラッシュ（本編の途中で 1 回だけ）
    if (i === accelIdx && i > 0) push({ kind: "card", color: "white", outSec: FLASH_SEC });

    const sceneStart = t;
    const zooms = ZOOM_BY_TYPE[s.scene_type] ?? ZOOM_BY_TYPE.setup;

    // --- ソース側の切り出し位置（前半優先・必要なら重ねる） -----------------
    const slowJ = i === slowIdx && K >= 2 ? 1 : -1;
    const srcLens = lens.map((L, j) => (j === slowJ ? L / SLOW_FACTOR : L));
    const srcTotal = srcLens.reduce((a, b) => a + b, 0);
    const avail = m.useVideo ? m.clipSec : Infinity;
    let ins;
    if (srcTotal <= avail * 0.995) {
      // 連続して切る（同一ショット内のジャンプカット＝寄りの変化で「別アングル」に見せる）
      ins = [];
      let acc = 0;
      for (const L of srcLens) { ins.push(acc); acc += L; }
    } else {
      // 素材が足りないときは前半に寄せて重ねる
      const maxIn = Math.max(0, avail - Math.max(...srcLens));
      ins = srcLens.map((_, j) => (K === 1 ? 0 : (maxIn * j) / (K - 1)));
    }

    for (let j = 0; j < K; j++) {
      const zoom = zooms[Math.min(j, zooms.length - 1)];
      const shake = SHAKE_TYPES.has(s.scene_type) && j > 0;
      const dir = (i + j) % 2 === 0 ? 1 : -1;
      const seg = m.useVideo
        ? {
            kind: "video", src: m.vid, hasAudio: m.hasAudio, gainDb: m.gainDb,
            srcIn: ins[j], srcLen: Math.min(srcLens[j], Math.max(0.1, avail - ins[j])),
            outSec: lens[j], zoom, shake, slow: j === slowJ ? SLOW_FACTOR : 1,
            drift: { x: dir * (18 + 10 * j), y: -6 * dir },
            // cold_open の最後のカットだけ後ろをディゾルブに使う
            fadeIn: 0, fadeOut: 0,
          }
        : { kind: "still", img: m.img, outSec: lens[j], kb: segs.length + j };
      push(seg);
    }

    // cold_open → setup の境目を xfade 対象にする（1 箇所だけ）
    if (s.scene_type === "cold_open" && i + 1 < n && view.scenes[i + 1].scene_type !== "cold_open") {
      xfadeAfter = segs.length - 1;
    }

    // --- 音イベント -------------------------------------------------------
    const narAt = sceneStart + NAR_LEAD;
    if (m.hasNar) nar.push({ n: m.n, file: m.narFile, at: narAt, sec: m.narSec });
    let voiceEnd = m.hasNar ? narAt + m.narSec : sceneStart; // このシーンで声が鳴り終わる時刻
    if (m.hasDlg) {
      // セリフはナレと重ねない（重なる場合は後ろにずらす）
      const narEnd = voiceEnd;
      const want = s.telop_timing === "cut_head" ? sceneStart + 0.15 : narEnd + DLG_GAP;
      const at = m.hasNar ? Math.max(want, narEnd + DLG_GAP) : sceneStart + 0.25;
      dlg.push({ n: m.n, file: m.dlgFile, at, sec: m.dlgSec, text: s.dialogue });
      voiceEnd = Math.max(voiceEnd, at + m.dlgSec);
    }

    // --- テロップ ---------------------------------------------------------
    const sceneEnd = sceneStart + D;
    if (s.telop) {
      const cutHead = s.telop_timing === "cut_head";
      const onSilence = s.telop_timing === "on_silence";
      // on_silence: そのシーンの声（ナレ・セリフ）を言い切った直後に音を落とし、テロップだけを見せる。
      // 声の途中でゲートを掛けると台詞が切れるので、必ず voiceEnd の後ろに置く。
      const tStart = onSilence
        ? Math.max(voiceEnd + 0.1, sceneStart + 0.2)
        : cutHead
        ? sceneStart + 0.03
        : narAt + m.narSec * 0.55;
      // 出しっぱなしにしない（カット頭に叩くテロップほど短く抜く）
      const tMax = cutHead ? TELOP_MAX_CUT_HEAD : TELOP_MAX_AFTER_NAR;
      const tEnd = Math.min(Math.max(tStart + 0.8, sceneEnd - 0.05), tStart + tMax);
      ass.push({
        style: "Telop", start: tStart, end: tEnd,
        tags: cutHead
          ? `{\\fad(80,300)\\blur0.8\\fscx106\\fscy106\\t(0,220,\\fscx100\\fscy100)}`
          : onSilence
          ? `{\\fad(120,220)\\blur0.6\\fscx108\\fscy108\\t(0,260,\\fscx100\\fscy100)}`
          : `{\\fad(500,350)\\blur1.2\\fscx104\\fscy104\\t(0,700,\\fscx100\\fscy100)}`,
        text: s.telop,
      });
      if (onSilence) {
        const st = Math.min(tStart, sceneEnd - SILENT_TELOP_SEC - 0.05);
        // 声の途中に食い込むくらいなら無音演出そのものを諦める（台詞を切らない）
        if (st >= voiceEnd - 0.01) silences.push({ start: st, end: st + SILENT_TELOP_SEC });
      }
    }
    // 画面内テロップ（gap-analysis 3-6）: 上部の左右に小さく
    s.screen_text.forEach((txt, k) => {
      const st = sceneStart + 0.25 + k * 0.2;
      const en = Math.min(sceneEnd - 0.1, st + 2.2);
      ass.push({
        style: "Screen", start: st, end: en, layer: 1,
        tags: k === 0 ? `{\\an7\\pos(150,168)\\fad(150,200)}` : `{\\an9\\pos(1770,168)\\fad(150,200)}`,
        text: txt,
      });
    });

    // --- 中間カード -------------------------------------------------------
    for (const it of inter.filter((x) => x.after_scene === m.n)) {
      const c = push({ kind: "card", color: "black", outSec: INTER_SEC });
      ass.push({
        style: "Inter", start: c.absStart, end: c.absStart + c.outSec,
        tags: `{\\pos(960,540)\\fad(150,200)\\blur0.6}`, text: it.text,
      });
    }
  }

  // --- stopdown（無音の黒）→ タイトル ------------------------------------
  const stop = push({ kind: "card", color: "black", outSec: STOPDOWN_SEC });
  const silence = { start: stop.absStart, end: stop.absStart + stop.outSec };
  silences.push(silence);

  const title = push({ kind: "card", color: "black", outSec: TITLE_SEC });
  const T0 = title.absStart;
  const T1 = T0 + TITLE_SEC;
  ass.push({
    style: "TitleMain", start: T0, end: T1,
    tags: `{\\pos(960,430)\\fad(320,380)\\blur1.0\\fscx104\\fscy104\\t(0,900,\\fscx100\\fscy100)}`,
    text: view.title,
  });
  ass.push({
    style: "TitleRule", start: T0 + 0.25, end: T1,
    // ASS の drawing 座標は「文字ボックスの左端 + 座標」で描かれる。
    // \an7 で左端を 660 に置くと 660〜1260 = 画面中央 960 を挟んだ 600px の罫線になる。
    tags: `{\\an7\\pos(660,520)\\fad(400,380)\\p1}m 0 0 l 600 0 l 600 3 l 0 3{\\p0}`,
    text: " ",
  });
  if (view.tagline) {
    ass.push({
      style: "TitleSub", start: T0 + 0.45, end: T1,
      tags: `{\\pos(960,580)\\fad(450,380)}`, text: view.tagline,
    });
  }
  ass.push({
    style: "Coming", start: T0 + 1.7, end: T1,
    tags: `{\\pos(960,832)\\fad(400,380)}`, text: "C O M I N G   S O O N",
  });
  if (view.cast_lines.length) {
    ass.push({
      style: "Cast", start: T0 + 2.0, end: T1,
      tags: `{\\pos(960,900)\\fad(400,380)}`, text: view.cast_lines.join("　　"),
    });
  }

  // --- エンドカード（release_line）------------------------------------------
  // 2026-08-30 方針: タイトル後の「落ち」セリフ（button）は廃止。
  // 本物の予告と同じく「大ヒット上映中」「近日公開」等のテロップで締める。旧台本の button_line は無視する。
  {
    const endText = view.release_line || "近日公開";
    const e = push({ kind: "card", color: "black", outSec: END_CARD_SEC });
    ass.push({
      style: "EndCard", start: e.absStart + 0.05, end: e.absStart + e.outSec,
      tags: `{\pos(960,540)\fad(250,300)\blur0.8\fscx103\fscy103\t(0,600,\fscx100\fscy100)}`, text: endText,
    });
  }

  // --- xfade による時刻の繰り上げ ----------------------------------------
  const useXfade = xfadeAfter >= 0 && xfadeAfter + 1 < segs.length && XFADE_SEC > 0;
  const shift = useXfade ? snap(XFADE_SEC) : 0;
  if (useXfade) {
    for (let k = xfadeAfter + 1; k < segs.length; k++) segs[k].absStart -= shift;
    const shiftAfter = segs[xfadeAfter].absStart + segs[xfadeAfter].outSec - shift;
    for (const e of [...nar, ...dlg, ...btn]) if (e.at >= shiftAfter) e.at -= shift;
    for (const e of ass) {
      if (e.start >= shiftAfter) { e.start -= shift; e.end -= shift; }
    }
    for (const sl of silences) {
      if (sl.start >= shiftAfter) { sl.start -= shift; sl.end -= shift; }
    }
  }

  const total = segs.reduce((a, s) => a + s.outSec, 0) - shift;
  silences.sort((a, b) => a.start - b.start);
  return {
    segs, nar, dlg, btn, ass, total,
    xfadeAfter: useXfade ? xfadeAfter : -1, xfadeSec: shift,
    silence, silences, src,
  };
}
