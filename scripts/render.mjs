// ⑤ 合成: クリップ / 画像 + テロップ + ナレ + セリフ + 環境音 + BGM → out/<job>/trailer.mp4
// 使い方: node scripts/render.mjs <job> [--force]
//
// Phase 3 の設計（従来の「シーン=1クリップ」から「タイムライン+カット」に変更）:
//   1. タイムライン設計（Node）… script.json から「カット」と「カード」の並びを組む。
//        - cut_count に従って各シーンを split/trim（前半優先）→ 終盤ほど短いカットランプ
//        - turn / montage は crop+scale で疑似寄り、手ブレ、モンタージュの1カットはスロー
//        - 加速点に白 2 フレームのフラッシュ
//        - 冒頭 PRESENTS カード / 中間カード / stopdown（無音の黒）/ タイトルカード
//   2. カット別レンダ … out/<job>/cuts/cNNN.mp4（映像 + そのカット区間の環境音）
//   3. テロップ生成  … out/<job>/telop.ass（**全テキストを絶対時刻の ASS 1 枚に集約**）
//   4. 最終 1 パス   … concat（+ 1 箇所だけ xfade）→ グレード/ブルーム/グレイン/ASS/レターボックス
//                      音は 環境音 / ナレ / セリフ / BGM の 4 レーンを別処理して amix
//
// ffmpeg / Windows の注意（CLAUDE.md 準拠）:
//   - filter_complex は文字列生成 → fc.txt → `-/filter_complex fc.txt`
//   - blend は format=gbrp で行い後で yuv420p に戻す（YUV のままだとマゼンタ化）
//   - crop の w/h に t は使えない（x/y は可）→ 寄りは固定 crop、動きは x/y の式で作る
//   - zoompan の前に scale=iw*4:ih*4、fps=30 / s=1920x1080 を明示（静止画フォールバック経路）
//   - フォントは fontfile / fontsdir に 'C\:/Windows/Fonts'（font= は使わない）
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, ensureDirs, readScript, jobPaths, ffmpeg, probeDuration, probeSummary,
  probeVolume, frames, logEvent, isMain,
} from "./lib.mjs";
import { enrichedView } from "./enrich.mjs";

const W = 1920;
const H = 1080;
const FPS = 30;
const FONT = "C\\:/Windows/Fonts/YuGothB.ttc"; // .ttc は face 0（游ゴシック Bold）のみ
// 注: filtergraph 内で ass の fontsdir=C\:/Windows/Fonts はパースに失敗する
//（`No option name near '/Windows/Fonts'` = \: エスケープが効かない）。
// Windows のフォントは fontconfig が拾うので fontsdir は渡さない。
const FONTNAME = "Yu Gothic";

// レターボックス 2.39:1（1920x804）→ 上下 138px の黒帯
const BAR = Number(process.env.LETTERBOX ?? 138);

// カード類の尺（秒）
const PRESENTS_SEC = Number(process.env.PRESENTS_SEC ?? 1.4);
const INTER_SEC = Number(process.env.INTER_SEC ?? 1.05);
const STOPDOWN_SEC = Number(process.env.STOPDOWN_SEC ?? 0.5); // タイトル直前の「無音の黒」
const TITLE_SEC = Number(process.env.TITLE_SEC ?? 3.4);
const REVIEW_SEC = Number(process.env.REVIEW_SEC ?? 1.0);   // 煽りテロップ（review_line）カード
const BUTTON_MIN = Number(process.env.BUTTON_MIN ?? 1.0);   // タイトル後の落ち（button_line）
const BUTTON_MAX = Number(process.env.BUTTON_MAX ?? 1.4);
// telop_timing: on_silence で音を落とす長さ（テロップだけを見せる）
const SILENT_TELOP_SEC = Number(process.env.SILENT_TELOP_SEC ?? 0.4);
const FLASH_SEC = 2 / FPS; // 白フラッシュ 2 フレーム

// カット割りの下限とシーン尺の計算
const MIN_CUT = 0.9;
const MIN_SCENE = 2.0;
const NAR_LEAD = 0.12; // シーン頭からナレ開始までの余白
const NAR_TAIL = 0.45; // ナレ終わりからシーン終わりまでの余白
const DLG_GAP = 0.20;  // ナレ終わり → セリフ開始
const DLG_TAIL = 0.30;

// 音量（env で調整可）
// gap-analysis 1-2: 環境音は「ほぼ無音」→「主役級」に。0.25 → 0.9
const AMBIENT_VOL = Number(process.env.AMBIENT_VOL ?? 0.9);
const AMBIENT_TARGET_DB = Number(process.env.AMBIENT_TARGET_DB ?? -20); // クリップごとに mean をここへ揃える
const NAR_VOL = Number(process.env.NAR_VOL ?? 1.0);
const DLG_VOL = Number(process.env.DLG_VOL ?? 1.0);
const BTN_VOL = Number(process.env.BTN_VOL ?? 1.0);
const BGM_VOL = Number(process.env.BGM_VOL ?? 0.22);

// cold_open → setup の 1 箇所だけクロスディゾルブする（それ以外はハードカット）
const XFADE_SEC = Number(process.env.XFADE_SEC ?? 0.45);

// 疑似寄り（crop+scale）の倍率。scene_type ごとにカット順で使う。
const ZOOM_BY_TYPE = {
  cold_open: [1.06, 1.3],
  setup: [1.06, 1.4],
  turn: [1.06, 1.55, 1.3, 1.7],
  montage: [1.06, 1.7, 1.4, 1.8],
  resolve: [1.06, 1.45, 1.15, 1.3],
};
const SHAKE_TYPES = new Set(["turn", "montage"]);

// 1 カットの最長（秒）。シーンが長いときはここを超えないようカット数を増やし、
// 「終盤ほどカットが短い」ランプ（quality-research 打ち手 #1）を必ず作る。
const MAX_CUT_BY_TYPE = {
  cold_open: 3.2,
  setup: 2.8,
  turn: 2.2,
  montage: 1.7,
  resolve: 2.2,
};
const MAX_CUTS_PER_SCENE = Number(process.env.MAX_CUTS_PER_SCENE ?? 6);

// テロップの最大表示秒（出しっぱなしにするとカットの速さが死ぬ）
const TELOP_MAX_CUT_HEAD = Number(process.env.TELOP_MAX_CUT_HEAD ?? 2.0);
const TELOP_MAX_AFTER_NAR = Number(process.env.TELOP_MAX_AFTER_NAR ?? 2.8);
const SLOW_FACTOR = Number(process.env.SLOW_FACTOR ?? 1.8); // montage の 1 カットをスローに

// ---------------------------------------------------------------- 小道具
/** ROOT からの相対パスをスラッシュ区切りで返す（filter 内の : エスケープを避ける）。 */
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/");

/** 秒をフレーム境界にスナップ（concat のドリフト防止）。 */
const snap = (sec) => Math.max(1, Math.round(sec * FPS)) / FPS;

/** Ken Burns（zoompan）の式。静止画フォールバック用。 */
function kenBurns(i, f) {
  const c = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  switch (i % 4) {
    case 0: return { z: `1+0.12*on/${f}`, x: c.x, y: c.y };
    case 1: return { z: `1.12-0.12*on/${f}`, x: c.x, y: c.y };
    case 2: return { z: `1+0.10*on/${f}`, x: `(iw-iw/zoom)*on/${f}`, y: c.y };
    default: return { z: `1.12-0.10*on/${f}`, x: `(iw-iw/zoom)*(1-on/${f})`, y: c.y };
  }
}

// ---------------------------------------------------------------- ASS
const assTime = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
};

/** ASS の本文用エスケープ（オーバーライド括弧と改行を潰す）。 */
const assText = (t) =>
  String(t).replace(/[\r\n]+/g, "\\N").replace(/\{/g, "｛").replace(/\}/g, "｝").trim();

/**
 * 絶対時刻の ASS を組む。テロップ・画面内テロップ・各カードの文字を 1 枚にまとめる。
 * Style: Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline,
 *        StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment,
 *        MarginL, MarginR, MarginV, Encoding
 */
function buildAss(events) {
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

// ---------------------------------------------------------------- タイムライン設計
/**
 * script.json（enrichedView 済み）と実素材から、カット / カード / 音イベント / ASS を設計する。
 * 戻り値の segments は「実際にレンダするクリップ」で、absStart は最終タイムライン上の開始時刻。
 */
async function buildPlan(job, view) {
  const p = jobPaths(job);
  const n = view.scenes.length;
  const segs = [];
  const nar = [];
  const dlg = [];
  const btn = [];       // button_line（タイトル後の落ち）。0 or 1 本
  const silences = [];  // 全レーンを落とす区間（stopdown と telop_timing: on_silence）
  const ass = [];

  // --- 素材の実測（尺と環境音レベル） ------------------------------------
  const src = [];
  for (const [i, s] of view.scenes.entries()) {
    const nn = i + 1;
    const vid = path.join(p.vid, `s${nn}.mp4`);
    const img = path.join(p.img, `s${nn}.png`);
    const narFile = path.join(p.nar, `s${nn}.wav`);
    const dlgFile = path.join(p.dlg, `s${nn}.wav`);
    // 案 B（style: "dialogue"）は narration が空のシーンがある → その場合 wav は作られない
    const wantNar = Boolean(String(s.narration ?? "").trim());
    const hasNar = fs.existsSync(narFile) && fs.statSync(narFile).size > 0;
    if (wantNar && !hasNar) throw new Error(`ナレーションがありません: ${narFile}（scripts/narration.mjs を先に）`);

    const useVideo = s.motion === "video" && fs.existsSync(vid) && fs.statSync(vid).size > 0;
    let clipSec = 0;
    let hasAudio = false;
    let gainDb = 0;
    if (useVideo) {
      clipSec = await probeDuration(vid);
      const info = await probeSummary(vid);
      hasAudio = (info.streams ?? []).some((st) => st.codec_type === "audio");
      if (hasAudio) {
        // gap-analysis 1-2: クリップごとに環境音の mean を揃えてから主役級の音量で使う
        const v = await probeVolume(vid);
        if (v) gainDb = Math.max(-6, Math.min(14, AMBIENT_TARGET_DB - v.mean));
      }
    } else if (!fs.existsSync(img)) {
      throw new Error(`素材がありません: ${img} も ${vid} も見つかりません`);
    }

    const narSec = hasNar ? await probeDuration(narFile) : 0;
    const hasDlg = Boolean(s.dialogue) && fs.existsSync(dlgFile) && fs.statSync(dlgFile).size > 0;
    const dlgSec = hasDlg ? await probeDuration(dlgFile) : 0;

    src.push({ i, n: nn, s, useVideo, vid, img, clipSec, hasAudio, gainDb, narFile, hasNar, narSec, dlgFile, hasDlg, dlgSec });
  }

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
  if (view.release_line) {
    ass.push({
      style: "Coming", start: T0 + 1.35, end: T1,
      tags: `{\\pos(960,770)\\fad(400,380)}`, text: view.release_line,
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

  // --- button（タイトル後の落ち）------------------------------------------
  // trailer-structure §2 の普遍則 ④「タイトル後に必ず button」。
  // 予告の重厚さを一度も崩さずに来て、ここで初めて現実に戻る。
  if (view.button_line) {
    const btnFile = path.join(p.dlg, "button.wav");
    const hasBtn = fs.existsSync(btnFile) && fs.statSync(btnFile).size > 0;
    const btnSec = hasBtn ? await probeDuration(btnFile) : 0;
    const want = Math.min(BUTTON_MAX, Math.max(BUTTON_MIN, btnSec + 0.35));
    const outSec = Math.max(want, btnSec + 0.25); // 音が切れるくらいなら上限を超えて伸ばす
    const b = push({ kind: "card", color: "black", outSec });
    if (hasBtn) btn.push({ file: btnFile, at: b.absStart + 0.12, sec: btnSec, text: view.button_line });
    ass.push({
      style: "Button", start: b.absStart + 0.05, end: b.absStart + b.outSec,
      tags: `{\\pos(960,540)\\fad(120,180)}`, text: view.button_line,
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

// ---------------------------------------------------------------- カット別レンダ
/** crop（疑似寄り + 手ブレ + ドリフト）の式。crop の w/h に t は使えないので固定値にする。 */
function cropExpr(seg) {
  const z = Math.max(1.0, seg.zoom ?? 1);
  const cw = Math.max(2, Math.round((W / z) / 2) * 2);
  const ch = Math.max(2, Math.round((H / z) / 2) * 2);
  const maxX = W - cw;
  const maxY = H - ch;
  if (maxX < 2 || maxY < 2) return null;
  const D = Math.max(0.1, seg.outSec);
  const dx = Math.max(-maxX / 2, Math.min(maxX / 2, seg.drift?.x ?? 0));
  const dy = Math.max(-maxY / 2, Math.min(maxY / 2, seg.drift?.y ?? 0));
  let x = `${(maxX / 2).toFixed(1)}+${dx.toFixed(1)}*(t/${D.toFixed(3)})`;
  let y = `${(maxY / 2).toFixed(1)}+${dy.toFixed(1)}*(t/${D.toFixed(3)})`;
  if (seg.shake) {
    x += `+7*sin(2*PI*t*3.3)+3*sin(2*PI*t*7.1)`;
    y += `+5*sin(2*PI*t*2.7)`;
  }
  return { cw, ch, x: `max(0\\,min(${maxX}\\,${x}))`, y: `max(0\\,min(${maxY}\\,${y}))` };
}

const CUT_ENC = [
  "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2",
];

/** 1 カットを out/<job>/cuts/cNNN.mp4 に書き出す。 */
async function renderCut(job, seg, k) {
  const p = jobPaths(job);
  const out = path.join(p.cuts, `c${String(k).padStart(3, "0")}.mp4`);
  const dur = seg.outSec;
  const fcFile = path.join(p.cuts, `fc_c${String(k).padStart(3, "0")}.txt`);

  if (seg.kind === "card") {
    const fc = [
      `[0:v]settb=AVTB,fps=${FPS},setsar=1,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[v]`,
      `[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`,
    ].join(";\n");
    fs.writeFileSync(fcFile, fc, "utf8");
    await ffmpeg([
      "-f", "lavfi", "-i", `color=c=${seg.color}:s=${W}x${H}:r=${FPS}:d=${(dur + 0.2).toFixed(3)}`,
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.2).toFixed(3)}`,
      "-/filter_complex", rel(fcFile),
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
    return out;
  }

  if (seg.kind === "still") {
    const f = frames(dur, FPS);
    const kb = kenBurns(seg.kb, f);
    const fc = [
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=iw*4:ih*4,` +
        `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${f}:s=${W}x${H}:fps=${FPS},` +
        `settb=AVTB,setsar=1,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[v]`,
      `[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`,
    ].join(";\n");
    fs.writeFileSync(fcFile, fc, "utf8");
    await ffmpeg([
      "-loop", "1", "-t", (dur + 0.3).toFixed(3), "-i", rel(seg.img),
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.3).toFixed(3)}`,
      "-/filter_complex", rel(fcFile),
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
    return out;
  }

  // --- video ---------------------------------------------------------------
  const inA = seg.srcIn;
  const inB = seg.srcIn + seg.srcLen;
  const slow = seg.slow ?? 1;
  const c = cropExpr(seg);
  const played = seg.srcLen * slow; // trim 後に実際に得られる尺
  const pad = Math.max(0, dur - played);

  const vparts = [
    `[0:v]trim=${inA.toFixed(3)}:${inB.toFixed(3)},setpts=(PTS-STARTPTS)${slow !== 1 ? `*${slow}` : ""}`,
    `fps=${FPS}`,
    `scale=${W}:${H}:flags=lanczos:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
  ];
  if (c) {
    vparts.push(`crop=w=${c.cw}:h=${c.ch}:x='${c.x}':y='${c.y}'`);
    vparts.push(`scale=${W}:${H}:flags=lanczos`);
  }
  if (pad > 0.01) vparts.push(`tpad=stop_mode=clone:stop_duration=${(pad + 0.2).toFixed(3)}`);
  vparts.push(`settb=AVTB,setsar=1,format=yuv420p`, `trim=0:${dur.toFixed(3)}`, `setpts=PTS-STARTPTS[v]`);

  const lines = [vparts.join(",")];

  if (seg.hasAudio) {
    // 映像と同じ trim 区間の環境音を使う（カットしても「そのカットの音」になる）
    const aparts = [
      `[0:a]atrim=${inA.toFixed(3)}:${inB.toFixed(3)},asetpts=PTS-STARTPTS`,
      `aresample=48000`,
      `aformat=sample_fmts=fltp:channel_layouts=stereo`,
    ];
    // スローは atempo（0.5 以上なので SLOW_FACTOR<=2.0 で有効）
    if (slow !== 1) aparts.push(`atempo=${(1 / slow).toFixed(4)}`);
    if (Math.abs(seg.gainDb) > 0.1) aparts.push(`volume=${seg.gainDb.toFixed(2)}dB`);
    aparts.push(`apad`, `atrim=0:${dur.toFixed(3)}`, `asetpts=N/SR/TB[a]`);
    lines.push(aparts.join(","));
    fs.writeFileSync(fcFile, lines.join(";\n"), "utf8");
    await ffmpeg([
      "-i", rel(seg.src),
      "-/filter_complex", rel(fcFile),
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
  } else {
    lines.push(`[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`);
    fs.writeFileSync(fcFile, lines.join(";\n"), "utf8");
    await ffmpeg([
      "-i", rel(seg.src),
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.3).toFixed(3)}`,
      "-/filter_complex", rel(fcFile),
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
  }
  return out;
}

// ---------------------------------------------------------------- 最終合成
function bgmFile(job) {
  const p = jobPaths(job);
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const f = path.join(p.dir, `bgm.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  }
  return null;
}

/** グレード → ブルーム → グレイン → ASS → レターボックス（quality-research §D-1）。 */
function lookFilter(inLabel, assRel, outLabel) {
  return [
    `${inLabel}scale=${W}:${H}:flags=lanczos,fps=${FPS},` +
      `curves=r='0/0.00 0.5/0.52 1/1.00':g='0/0.005 0.5/0.50 1/0.995':b='0/0.030 0.5/0.48 1/0.95',` +
      `eq=contrast=1.06:saturation=1.10,vignette=PI/5[base]`,
    // blend は RGB で（YUV のままだとマゼンタ化）
    `[base]format=gbrp,split=2[b1][b2]`,
    // ブルームは 1/4 に落としてから blur（見た目は同等で大幅に速い）
    `[b2]curves=all='0/0 0.72/0 1/1',scale=iw/4:ih/4,gblur=sigma=7,scale=${W}:${H}[bl]`,
    `[b1][bl]blend=all_mode=screen:all_opacity=0.30,format=yuv420p[bloomed]`,
    `[bloomed]noise=alls=5:allf=t+u,` +
      `ass=f=${assRel},` +
      `drawbox=x=0:y=0:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `drawbox=x=0:y=ih-${BAR}:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `settb=AVTB,fps=${FPS},setsar=1,format=yuv420p${outLabel}`,
  ];
}

/** ナレーションのトレーラー処理チェーン（quality-research §C-4）。 */
const NAR_CHAIN =
  `highpass=f=70,equalizer=f=115:t=q:w=1.0:g=4,equalizer=f=330:t=q:w=1.2:g=-3,` +
  `equalizer=f=3800:t=q:w=1.6:g=3,` +
  `acompressor=threshold=0.08:ratio=4:attack=8:release=180:makeup=2,` +
  `aecho=0.9:0.85:38:0.12,alimiter=limit=0.94`;

/** セリフ = 「現場の声」。小部屋の残響と低域カット（gap-analysis 1-8）。 */
const DLG_CHAIN =
  `highpass=f=120,equalizer=f=2600:t=q:w=1.4:g=2,` +
  `acompressor=threshold=0.10:ratio=3.5:attack=6:release=140:makeup=2,` +
  `aecho=0.8:0.7:20|40:0.25|0.15,alimiter=limit=0.94`;

/** button = 「素の声」。演出を足さない（軽い整音だけ）。 */
const BTN_CHAIN = `highpass=f=90,acompressor=threshold=0.12:ratio=2.5:attack=10:release=180:makeup=1,alimiter=limit=0.94`;

async function compose(job, plan, cutFiles) {
  const p = jobPaths(job);
  const lines = [];
  const N = cutFiles.length;
  const assRel = rel(p.ass);
  const bgm = bgmFile(job);
  const total = plan.total;

  // --- 入力インデックス ---------------------------------------------------
  const narBase = N;
  const dlgBase = narBase + plan.nar.length;
  const btnBase = dlgBase + plan.dlg.length;
  const bgmIdx = btnBase + plan.btn.length;

  // --- 各カットを揃える ---------------------------------------------------
  plan.segs.forEach((seg, k) => {
    const d = seg.outSec.toFixed(3);
    lines.push(
      `[${k}:v]trim=0:${d},setpts=PTS-STARTPTS,settb=AVTB,fps=${FPS},setsar=1,format=yuv420p[cv${k}]`
    );
    lines.push(
      `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `apad,atrim=0:${d},asetpts=N/SR/TB[ca${k}]`
    );
  });

  // --- concat（xfade があれば 2 グループに分けて 1 箇所だけ繋ぐ） ----------
  const X = plan.xfadeAfter;
  const cat = (from, to, tag) => {
    const idx = [];
    for (let k = from; k <= to; k++) idx.push(k);
    if (idx.length === 1) {
      lines.push(`[cv${idx[0]}]null[gv${tag}]`);
      lines.push(`[ca${idx[0]}]anull[ga${tag}]`);
    } else {
      lines.push(`${idx.map((k) => `[cv${k}]`).join("")}concat=n=${idx.length}:v=1:a=0[gv${tag}]`);
      lines.push(`${idx.map((k) => `[ca${k}]`).join("")}concat=n=${idx.length}:v=0:a=1[ga${tag}]`);
    }
    return idx.reduce((a, k) => a + plan.segs[k].outSec, 0);
  };

  if (X >= 0) {
    const d0 = cat(0, X, "0");
    cat(X + 1, N - 1, "1");
    const off = (d0 - plan.xfadeSec).toFixed(3);
    // CLAUDE.md: xfade の前に各入力を settb/fps/format/setsar で必ず揃える。
    // （片方が concat・片方が単一クリップだと timebase が 1/30 と 1/1000000 で食い違い
    //   "First input link main timebase do not match" でグラフ構築に失敗する）
    for (const g of ["0", "1"]) {
      lines.push(`[gv${g}]settb=AVTB,fps=${FPS},format=yuv420p,setsar=1[xv${g}]`);
    }
    lines.push(`[xv0][xv1]xfade=transition=fade:duration=${plan.xfadeSec.toFixed(3)}:offset=${off}[vcat]`);
    lines.push(`[ga0][ga1]acrossfade=d=${plan.xfadeSec.toFixed(3)}:c1=tri:c2=tri[acat]`);
  } else {
    cat(0, N - 1, "0");
    lines.push(`[gv0]null[vcat]`);
    lines.push(`[ga0]anull[acat]`);
  }

  // --- 映像のルック -------------------------------------------------------
  lines.push(...lookFilter("[vcat]", assRel, "[v]"));

  // --- 音: 環境音レーン ---------------------------------------------------
  lines.push(
    `[acat]atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      `highpass=f=40,treble=g=-2:f=7000,volume=${AMBIENT_VOL}[ambv]`
  );

  // --- 音: ナレレーン -----------------------------------------------------
  plan.nar.forEach((e, k) => {
    const ms = Math.round(e.at * 1000);
    lines.push(
      `[${narBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}[nr${k}]`
    );
  });
  if (plan.nar.length === 0) {
    // 案 B でナレが 1 本も無いジョブでもグラフが成立するようにする
    lines.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[narv]`);
  } else {
    if (plan.nar.length === 1) lines.push(`[nr0]anull[narmix]`);
    else lines.push(`${plan.nar.map((_, k) => `[nr${k}]`).join("")}amix=inputs=${plan.nar.length}:normalize=0:duration=longest[narmix]`);
    lines.push(`[narmix]${NAR_CHAIN},volume=${NAR_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[narv]`);
  }

  // --- 音: セリフレーン ---------------------------------------------------
  let dlgLabel = null;
  if (plan.dlg.length) {
    plan.dlg.forEach((e, k) => {
      const ms = Math.round(e.at * 1000);
      lines.push(
        `[${dlgBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `adelay=${ms}|${ms}[dl${k}]`
      );
    });
    if (plan.dlg.length === 1) lines.push(`[dl0]anull[dlgmix]`);
    else lines.push(`${plan.dlg.map((_, k) => `[dl${k}]`).join("")}amix=inputs=${plan.dlg.length}:normalize=0:duration=longest[dlgmix]`);
    lines.push(`[dlgmix]${DLG_CHAIN},volume=${DLG_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[dlgv]`);
    dlgLabel = "[dlgv]";
  }

  // --- 音: button レーン（素の声。残響は付けない）--------------------------
  let btnLabel = null;
  if (plan.btn.length) {
    const e = plan.btn[0];
    const ms = Math.round(e.at * 1000);
    lines.push(
      `[${btnBase}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}[btn0]`
    );
    lines.push(`[btn0]${BTN_CHAIN},volume=${BTN_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[btnv]`);
    btnLabel = "[btnv]";
  }

  // --- ダッキングのキー（ナレ + セリフ） -----------------------------------
  lines.push(`[narv]asplit=2[nar_main][nar_key]`);
  if (dlgLabel) {
    lines.push(`${dlgLabel}asplit=2[dlg_main][dlg_key]`);
    lines.push(`[nar_key][dlg_key]amix=inputs=2:normalize=0:duration=longest[duckkey]`);
  } else {
    lines.push(`[nar_key]anull[duckkey]`);
  }
  lines.push(`[duckkey]asplit=2[key_amb][key_bgm]`);

  // 環境音は「ナレ中だけ −6dB 程度」（ratio を浅くして主役級を保つ）
  lines.push(`[ambv][key_amb]sidechaincompress=threshold=0.05:ratio=3.5:attack=15:release=320:makeup=1[ambduck]`);

  // --- 音: BGM ------------------------------------------------------------
  const mixIn = ["[ambduck]", "[nar_main]"];
  if (dlgLabel) mixIn.push("[dlg_main]");
  if (btnLabel) mixIn.push(btnLabel);
  if (bgm) {
    const bgmDur = await probeDuration(bgm);
    const loop = bgmDur < total ? `aloop=loop=-1:size=${Math.round(bgmDur * 48000)},` : "";
    lines.push(
      `[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${loop}` +
        `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,volume=${BGM_VOL},` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(3)}:d=2.5[bgmv]`
    );
    lines.push(`[bgmv][key_bgm]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350[bgmduck]`);
    mixIn.push("[bgmduck]");
  } else {
    lines.push(`[key_bgm]anullsink`);
  }

  // --- 最終段: amix → loudnorm → alimiter → stopdown 無音 → aresample -----
  // stopdown（黒＋完全無音）と telop_timing: on_silence の区間を全レーンまとめて落とす
  const gate = (plan.silences ?? [plan.silence])
    .map((sl) => `volume=enable='between(t\\,${sl.start.toFixed(3)}\\,${sl.end.toFixed(3)})':volume=0`)
    .join(",");
  lines.push(
    `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,` +
      `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      `loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.95,${gate},aresample=48000[aout]`
  );

  fs.writeFileSync(p.fc, lines.join(";\n"), "utf8");

  const args = [];
  for (const c of cutFiles) args.push("-i", rel(c));
  for (const e of plan.nar) args.push("-i", rel(e.file));
  for (const e of plan.dlg) args.push("-i", rel(e.file));
  for (const e of plan.btn) args.push("-i", rel(e.file));
  if (bgm) args.push("-i", rel(bgm));
  args.push(
    "-/filter_complex", rel(p.fc),
    "-map", "[v]", "-map", "[aout]",
    "-t", total.toFixed(3),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    rel(p.trailer)
  );
  await ffmpeg(args);
  return { bgm };
}

// ---------------------------------------------------------------- エントリ
export async function render(job, { force = false } = {}) {
  const t0 = Date.now();
  const p = ensureDirs(job, "scenes", "telop", "cuts", "dlg");
  const view = enrichedView(readScript(job));

  console.log(`[render] タイムライン設計（${view.scenes.length} シーン / enriched=${view.enriched}）`);
  const plan = await buildPlan(job, view);

  const nCut = plan.segs.filter((s) => s.kind !== "card").length;
  const nCard = plan.segs.length - nCut;
  console.log(
    `  カット ${nCut} / カード ${nCard} / 合計 ${plan.total.toFixed(2)}s` +
      (plan.xfadeAfter >= 0 ? ` / xfade 1箇所 (${plan.xfadeSec.toFixed(2)}s)` : " / xfade なし")
  );
  for (const [k, s] of plan.segs.entries()) {
    const label =
      s.kind === "card"
        ? `card(${s.color})`
        : s.kind === "still"
        ? "still"
        : `video src ${s.srcIn.toFixed(2)}-${(s.srcIn + s.srcLen).toFixed(2)} z=${s.zoom}${s.shake ? " shake" : ""}${s.slow !== 1 ? ` slow x${s.slow}` : ""}`;
    console.log(`   c${String(k).padStart(3, "0")} @${s.absStart.toFixed(2)} ${s.outSec.toFixed(2)}s ${label}`);
  }
  console.log(`  ナレ: ${plan.nar.map((e) => `s${e.n}@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)`).join(", ")}`);
  console.log(`  セリフ: ${plan.dlg.map((e) => `s${e.n}@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)「${e.text}」`).join(", ") || "(なし)"}`);
  console.log(`  button: ${plan.btn.map((e) => `@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)「${e.text}」`).join(", ") || "(なし)"}`);
  console.log(`  無音区間: ${plan.silences.map((sl) => `${sl.start.toFixed(2)}〜${sl.end.toFixed(2)}s`).join(", ")}`);

  // --- テロップ ASS -------------------------------------------------------
  fs.writeFileSync(p.ass, buildAss(plan.ass), "utf8");
  console.log(`[render] テロップ ${rel(p.ass)}（${plan.ass.length} イベント）`);

  // --- カット別レンダ -----------------------------------------------------
  // 設計が少しでも変わるとカットの内容が変わるので、既存キャッシュはプラン一致時のみ使う。
  const planKey = JSON.stringify(plan.segs.map((s) => ({ ...s, absStart: undefined })));
  const keyFile = path.join(p.cuts, "plan.json");
  const reuse =
    !force && fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8") === planKey;
  if (!reuse) fs.rmSync(p.cuts, { recursive: true, force: true });
  fs.mkdirSync(p.cuts, { recursive: true });

  const ts = Date.now();
  const cutFiles = [];
  for (const [k, seg] of plan.segs.entries()) {
    const f = path.join(p.cuts, `c${String(k).padStart(3, "0")}.mp4`);
    if (reuse && fs.existsSync(f) && fs.statSync(f).size > 0) cutFiles.push(f);
    else cutFiles.push(await renderCut(job, seg, k));
  }
  fs.writeFileSync(keyFile, planKey, "utf8");
  console.log(`[render] カット別レンダ ${cutFiles.length}本 (${((Date.now() - ts) / 1000).toFixed(1)}s)${reuse ? " ※一部再利用" : ""}`);

  // --- 最終合成 -----------------------------------------------------------
  const tc = Date.now();
  const info = await compose(job, plan, cutFiles);
  console.log(`[render] 最終合成 (${((Date.now() - tc) / 1000).toFixed(1)}s)`);

  const sec = (Date.now() - t0) / 1000;
  logEvent(job, {
    step: "render",
    ok: true,
    sec: Number(sec.toFixed(2)),
    total_sec: Number(plan.total.toFixed(2)),
    cuts: nCut,
    cards: nCard,
    dialogue: plan.dlg.length,
    button: plan.btn.length,
    ambient_vol: AMBIENT_VOL,
    bgm: info.bgm ? path.basename(info.bgm) : null,
  });

  console.log(`[render] ${p.trailer}`);
  console.log(`  尺 ${plan.total.toFixed(2)}s / カット ${nCut} / カード ${nCard} / セリフ ${plan.dlg.length} / 所要 ${sec.toFixed(1)}s`);
  return { file: p.trailer, sec, total: plan.total, plan, ...info };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await render(job, { force });
}
