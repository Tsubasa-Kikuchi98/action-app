// 台本ドメインの語彙と既定値（外部依存なし）。
// script / enrich / render / narration / video が共有する「型と既定」。

// 既存 5 種（narration / dialogue）＋ nolan 専用 3 種。
// nolan は「先輩が気づく → 主人公がもがく → 上司が動き出す」の 3 枚だけで構成するため、
// 既存の cold_open…resolve を流用せず専用の役割名を持たせる（構成が混ざらないようにする）。
export const SCENE_TYPES = [
  "cold_open", "setup", "turn", "montage", "resolve",
  "discover", "struggle", "mobilize",
];

/** nolan（style: "nolan"）で使うシーン種別。順序もこのとおり固定。 */
export const NOLAN_SCENE_TYPES = ["discover", "struggle", "mobilize"];

/** nolan の各シーンで喋る人物（1 シーン 1 人・固定）。 */
export const NOLAN_SPEAKER_BY_TYPE = { discover: "senpai", struggle: "hero", mobilize: "boss" };

/** nolan の各シーンの尺（秒）。Veo は 8 秒生成し、前半だけを使う。 */
export const NOLAN_DURATION = { discover: 3, struggle: 4, mobilize: 3 };

// on_silence = 環境音とナレを一瞬だけ落として「テロップだけ」を見せる（render が 0.4 秒ゲートする）
export const TELOP_TIMINGS = ["cut_head", "after_narration", "on_silence"];

/**
 * 台本の型。
 * narration = 案 A（ナレ主導・既定） / dialogue = 案 B（セリフ・テロップ主導）
 * nolan     = 3 カット・ナレなし・カード主導（クリストファー・ノーラン作品の予告の形）
 */
export const STYLES = ["narration", "dialogue", "nolan"];
export const DEFAULT_STYLE = STYLES.includes(process.env.TRAILER_STYLE ?? "") ? process.env.TRAILER_STYLE : "narration";

/** Phase 2: 全シーンを Veo で動画化するため 5 シーン構成（env SCENE_COUNT で上書き可）。 */
export const SCENE_COUNT = Number(process.env.SCENE_COUNT ?? 5);

/** nolan は 3 シーン固定（カット 1 / 2 / 3）。それ以外は SCENE_COUNT。 */
export const NOLAN_SCENE_COUNT = 3;
export const sceneCountFor = (style) => (style === "nolan" ? NOLAN_SCENE_COUNT : SCENE_COUNT);

/** ナレーションの合計字数の上限（trailer-structure §9-2）。超えたら warn する。 */
export const NAR_TOTAL_MAX = Number(process.env.NAR_TOTAL_MAX ?? 80);

/** セリフの上限。案 A は 3 本、案 B は 4 本（拒絶／号砲／息継ぎ／落ち）。 */
export const MAX_DIALOGUE = Number(process.env.MAX_DIALOGUE ?? 3);
export const maxDialogue = (style) =>
  style === "dialogue" ? Math.max(4, MAX_DIALOGUE) : style === "nolan" ? NOLAN_SCENE_COUNT : MAX_DIALOGUE;

/** scene_type ごとの cut_count 上限（trailer-structure §9: montage だけ 6 まで）。 */
// nolan は「1 クリップ 1 カット・分割しない」ので上限 1。
export const CUT_CAP = {
  cold_open: 4, setup: 4, turn: 4, montage: 6, resolve: 4,
  discover: 1, struggle: 1, mobilize: 1,
};
export const cutCap = (type) => CUT_CAP[type] ?? 4;

/** duration_sec の既定ランプ（trailer-structure §9: montage を最長にする）。 */
export const DURATION_RAMP = [6, 4, 4, 6, 4];

/** Veo が受け付けるシーン尺（秒）。narration.mjs がナレ実尺をここに丸め上げる。 */
export const VEO_STEPS = [4, 6, 8];

/** 惹句師 関根忠郎の禁句（trailer-structure §4 / §9-4）。検出したら warn するが削除はしない。 */
export const FORBIDDEN_WORDS = ["感動", "衝撃", "絆", "涙", "愛", "奇跡", "最高傑作", "今世紀最大", "全米が泣いた"];

/** テキスト中の禁句を返す。 */
export function findForbidden(text) {
  const t = String(text ?? "");
  return FORBIDDEN_WORDS.filter((w) => t.includes(w));
}

/** scene_type ごとの既定カット数（quality-research §A: 1,1,2,3,3）。 */
export const DEFAULT_CUT_COUNT = {
  cold_open: 1,
  setup: 1,
  turn: 2,
  montage: 3,
  resolve: 2,
  discover: 1,
  struggle: 1,
  mobilize: 1,
};

/** scene_type ごとの既定テロップタイミング。 */
export const DEFAULT_TELOP_TIMING = {
  cold_open: "after_narration",
  setup: "after_narration",
  turn: "cut_head",
  montage: "cut_head",
  resolve: "after_narration",
  // nolan はカット内に文字を一切出さない（テロップはカードだけ）
  discover: "cut_head",
  struggle: "cut_head",
  mobilize: "cut_head",
};

/** scene_type ごとの Veo 既定カメラ語彙（quality-research §B）。 */
export const DEFAULT_CAMERA_BEAT = {
  cold_open: "slow dolly in, wide shot",
  setup: "handheld push-in, medium shot",
  turn: "low-angle tracking shot, shallow depth of field",
  montage: "fast crane rising, wide shot",
  resolve: "slow pull-back crane, wide shot",
  // nolan: カメラは静か。据え置きか、ごく遅いドリーだけ（手ブレ・急ズームは使わない）
  discover: "locked-off symmetrical wide shot, eye level",
  struggle: "very slow dolly in, centered medium shot",
  mobilize: "locked-off low-angle wide shot, eye level",
};

/** index（0 始まり）と総シーン数から scene_type を推定する（旧 script.json 用）。 */
export function guessSceneType(i, n) {
  if (i === 0) return "cold_open";
  if (i === n - 1) return "resolve";
  if (n <= 3) return "turn";
  const r = (i - 1) / (n - 2); // 中間シーンの位置 0..1
  if (r < 0.34) return "setup";
  if (r < 0.67) return "turn";
  return "montage";
}
