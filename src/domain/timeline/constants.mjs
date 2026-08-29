// ⑤ 合成のタイムライン定数（純粋な値・外部依存なし）。
// 演出の調整つまみはすべてここに集約し、env で上書きできるようにしてある。

export const W = 1920;
export const H = 1080;
export const FPS = 30;

// .ttc は face 0（游ゴシック Bold）のみ。font= は使わない（セグフォルト）。
export const FONT = "C\:/Windows/Fonts/YuGothB.ttc";
// 注: filtergraph 内で ass の fontsdir=C\:/Windows/Fonts はパースに失敗する
//（`No option name near '/Windows/Fonts'` = \: エスケープが効かない）。
// Windows のフォントは fontconfig が拾うので fontsdir は渡さない。
export const FONTNAME = "Yu Gothic";

// レターボックス 2.39:1（1920x804）→ 上下 138px の黒帯
export const BAR = Number(process.env.LETTERBOX ?? 138);

// カード類の尺（秒）
export const PRESENTS_SEC = Number(process.env.PRESENTS_SEC ?? 1.4);
export const INTER_SEC = Number(process.env.INTER_SEC ?? 1.05);
export const STOPDOWN_SEC = Number(process.env.STOPDOWN_SEC ?? 0.5); // タイトル直前の「無音の黒」
export const TITLE_SEC = Number(process.env.TITLE_SEC ?? 3.4);
export const REVIEW_SEC = Number(process.env.REVIEW_SEC ?? 1.0);   // 煽りテロップ（review_line）カード
export const BUTTON_MIN = Number(process.env.BUTTON_MIN ?? 1.0);   // （廃止）
export const END_CARD_SEC = Number(process.env.END_CARD_SEC ?? 2.0); // エンドカード「大ヒット上映中」等
export const BUTTON_MAX = Number(process.env.BUTTON_MAX ?? 1.4);
// telop_timing: on_silence で音を落とす長さ（テロップだけを見せる）
export const SILENT_TELOP_SEC = Number(process.env.SILENT_TELOP_SEC ?? 0.4);
export const FLASH_SEC = 2 / FPS; // 白フラッシュ 2 フレーム

// カット割りの下限とシーン尺の計算
export const MIN_CUT = 0.9;
export const MIN_SCENE = 2.0;
export const NAR_LEAD = 0.12; // シーン頭からナレ開始までの余白
export const NAR_TAIL = 0.45; // ナレ終わりからシーン終わりまでの余白
export const DLG_GAP = 0.20;  // ナレ終わり → セリフ開始
export const DLG_TAIL = 0.30;

// 音量（env で調整可）
// gap-analysis 1-2: 環境音は「ほぼ無音」→「主役級」に。0.25 → 0.9
export const AMBIENT_VOL = Number(process.env.AMBIENT_VOL ?? 0.9);
export const AMBIENT_TARGET_DB = Number(process.env.AMBIENT_TARGET_DB ?? -20); // クリップごとに mean をここへ揃える
export const NAR_VOL = Number(process.env.NAR_VOL ?? 1.0);
export const DLG_VOL = Number(process.env.DLG_VOL ?? 1.0);
export const BTN_VOL = Number(process.env.BTN_VOL ?? 1.0);
export const BGM_VOL = Number(process.env.BGM_VOL ?? 0.22);

// cold_open → setup の 1 箇所だけクロスディゾルブする（それ以外はハードカット）
export const XFADE_SEC = Number(process.env.XFADE_SEC ?? 0.45);

// 疑似寄り（crop+scale）の倍率。scene_type ごとにカット順で使う。
export const ZOOM_BY_TYPE = {
  cold_open: [1.06, 1.3],
  setup: [1.06, 1.4],
  turn: [1.06, 1.55, 1.3, 1.7],
  montage: [1.06, 1.7, 1.4, 1.8],
  resolve: [1.06, 1.45, 1.15, 1.3],
};
export const SHAKE_TYPES = new Set(["turn", "montage"]);

// 1 カットの最長（秒）。シーンが長いときはここを超えないようカット数を増やし、
// 「終盤ほどカットが短い」ランプ（quality-research 打ち手 #1）を必ず作る。
export const MAX_CUT_BY_TYPE = {
  cold_open: 3.2,
  setup: 2.8,
  turn: 2.2,
  montage: 1.7,
  resolve: 2.2,
};
export const MAX_CUTS_PER_SCENE = Number(process.env.MAX_CUTS_PER_SCENE ?? 6);

// テロップの最大表示秒（出しっぱなしにするとカットの速さが死ぬ）
export const TELOP_MAX_CUT_HEAD = Number(process.env.TELOP_MAX_CUT_HEAD ?? 2.0);
export const TELOP_MAX_AFTER_NAR = Number(process.env.TELOP_MAX_AFTER_NAR ?? 2.8);
export const SLOW_FACTOR = Number(process.env.SLOW_FACTOR ?? 1.8); // montage の 1 カットをスローに

/** 秒をフレーム境界にスナップ（concat のドリフト防止）。 */
export const snap = (sec) => Math.max(1, Math.round(sec * FPS)) / FPS;

/** 秒数を fps 換算のフレーム数に。 */
export const frames = (sec, fps = FPS) => Math.max(1, Math.round(sec * fps));
