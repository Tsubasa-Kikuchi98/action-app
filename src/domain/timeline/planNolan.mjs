// nolan（style: "nolan"）のタイムライン設計（純関数）。
//
// 構成は「カード ↔ カット」の交互だけ。既存の 5 シーン構成と違い、
//   - **カットは分割しない**（1 クリップ 1 カット）。疑似寄り・手ブレ・スロー・白フラッシュは使わない
//   - **xfade は使わない**（ハードカットのみ）
//   - **カット内に文字を出さない**（テロップ・画面内テロップ無し。文字はカードだけ）
//   - ナレーション／セリフのレーンは使わない（声は Veo クリップの中に入っている）
//   - カードの表示開始と同時に **SFX（ブラーム）** を鳴らす → plan.sfx[]
//
//   提供カード → カット1 → カード① → カット2 → カード② → カット3 → 無音の黒 → タイトル → エンドカード
import {
  NOLAN_PRESENTS_SEC, NOLAN_CARD_SEC, NOLAN_STOPDOWN_SEC, NOLAN_TITLE_SEC, NOLAN_END_SEC,
  NOLAN_MIN_SCENE, SFX_LEAD, snap, nolanCenterX,
} from "./constants.mjs";

/**
 * @param {object} view enrichedView() を通した台本（style: "nolan"）
 * @param {Array<object>} src 各シーンの実測情報（renderTrailer が ffprobe で作る）
 * @returns {object} planTimeline と同じ形（+ sfx[]）
 */
export function planNolan(view, src) {
  const segs = [];
  const ass = [];
  const sfx = [];
  const silences = [];

  let t = 0;
  const push = (seg) => {
    seg.outSec = snap(seg.outSec);
    seg.absStart = t;
    t += seg.outSec;
    segs.push(seg);
    return seg;
  };

  /** 黒カード 1 枚（＋任意で SFX）。sfx の名前は assets/sfx/<name>.wav に対応する。 */
  const card = (outSec, { sfxName = null } = {}) => {
    const c = push({ kind: "card", color: "black", outSec });
    if (sfxName) sfx.push({ name: sfxName, at: Math.max(0, c.absStart - SFX_LEAD), card: segs.length - 1 });
    return c;
  };
  // 中間カードは 2 枚とも同じ音にすると型が見えるので、ブラームを 2 種類で交互に鳴らす。
  const CARD_SFX = ["braam", "braam2"];
  let cardNo = 0;

  // --- 提供カード「IFTC 提供」 --------------------------------------------
  if (view.presents) {
    const c = card(NOLAN_PRESENTS_SEC);
    ass.push({
      style: "PresentsNolan", start: c.absStart + 0.05, end: c.absStart + c.outSec,
      tags: `{\\pos(${nolanCenterX("PresentsNolan")},540)\\fad(300,260)}`, text: view.presents,
    });
  }

  // --- 本編（カット ↔ カード） --------------------------------------------
  const inter = view.interstitials.map((it) => ({ ...it }));
  for (const m of src) {
    const D = snap(Math.max(m.s.duration_sec ?? NOLAN_MIN_SCENE, NOLAN_MIN_SCENE));
    // 1 クリップ 1 カット。zoom / shake / slow / drift は一切かけない（据え置きのまま出す）。
    const seg = m.useVideo
      ? {
          kind: "video", src: m.vid, hasAudio: m.hasAudio, gainDb: m.gainDb,
          // srcIn は renderTrailer が「セリフを喋っている区間」から決める（無ければ頭から）
          srcIn: m.srcIn ?? 0,
          srcLen: Math.min(D, Math.max(0.1, m.clipSec - (m.srcIn ?? 0))),
          outSec: D, zoom: 1, shake: false, slow: 1, drift: { x: 0, y: 0 },
          fadeIn: 0, fadeOut: 0,
        }
      : { kind: "still", img: m.img, outSec: D, kb: segs.length };
    push(seg);

    // 中間カード（表示と同時にブラーム）
    for (const it of inter.filter((x) => x.after_scene === m.n)) {
      const c = card(NOLAN_CARD_SEC, { sfxName: CARD_SFX[cardNo++ % CARD_SFX.length] });
      ass.push({
        style: "CardNolan", start: c.absStart, end: c.absStart + c.outSec,
        tags: `{\\pos(${nolanCenterX("CardNolan")},540)\\fad(120,200)}`, text: it.text,
      });
    }
  }

  // --- 無音の黒 → タイトル ------------------------------------------------
  const stop = card(NOLAN_STOPDOWN_SEC);
  const silence = { start: stop.absStart, end: stop.absStart + stop.outSec };
  silences.push(silence);

  // タイトルだけは「吸い込み → ヒット」で文字を立ち上げる
  const title = card(NOLAN_TITLE_SEC, { sfxName: "riser" });
  const T0 = title.absStart;
  const T1 = T0 + title.outSec;
  ass.push({
    style: "TitleNolan", start: T0, end: T1,
    tags: `{\\pos(${nolanCenterX("TitleNolan")},${view.tagline ? 508 : 540})\\fad(200,320)}`, text: view.title,
  });
  if (view.tagline) {
    ass.push({
      style: "TitleSubNolan", start: T0 + 0.5, end: T1,
      tags: `{\\pos(${nolanCenterX("TitleSubNolan")},622)\\fad(320,320)}`, text: view.tagline,
    });
  }

  // --- エンドカード -------------------------------------------------------
  {
    const e = card(NOLAN_END_SEC);
    ass.push({
      style: "EndNolan", start: e.absStart + 0.1, end: e.absStart + e.outSec,
      tags: `{\\pos(${nolanCenterX("EndNolan")},540)\\fad(200,300)}`, text: view.release_line || "近日公開",
    });
  }

  const total = segs.reduce((a, s) => a + s.outSec, 0);
  return {
    segs, nar: [], dlg: [], btn: [], sfx, ass, total,
    xfadeAfter: -1, xfadeSec: 0,
    silence, silences, src, style: "nolan",
  };
}
