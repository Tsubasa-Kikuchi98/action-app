// 固定キャストと固定ロケーション（domain）。
// 外部依存なし。台本プロンプト・画像プロンプト・基準画像・Veo プロンプトが共有する。
//
// 固定キャスト（2026-08-30 決定）。声を持つのはこの 3 人だけ。それ以外の登場人物は無言。
export const CAST = {
  hero:   { jp: "主人公（若手の男性社員）", role: "失敗をする当事者。前に出て動く",
            en: "the protagonist: a Japanese man in his mid-20s, short black hair, white shirt with sleeves rolled up, no tie, lanyard ID card" },
  senpai: { jp: "先輩（30 代前半の女性社員）", role: "失敗に最初に気づく。冷静に状況を掴む",
            en: "the senior colleague: a Japanese woman in her early 30s, shoulder-length dark hair tied back, dark navy blazer over a light blouse" },
  boss:   { jp: "上司（50 代の男性社員）", role: "責任を負い、指示を出し、外部へ連絡する",
            en: "the boss: a Japanese man in his 50s, gray-streaked hair, dark suit, no glasses, calm heavy presence" },
};
export const SPEAKERS = ["none", "hero", "senpai", "boss"];

// 固定ロケーション（2026-08-30 決定）。シーン画像は 5 枚を並列生成するため、
// 舞台を自由記述にすると「同じオフィス」が毎回別の部屋になる。
// キーで指定させ、assets/refs/loc_<key>.png（基準プレート）を参照として添付して見た目を固定する。
export const LOCATIONS = {
  office: {
    jp: "オープンオフィス",
    en: "a modern Japanese open-plan office: rows of desks with dual monitors, glass partitions, an exposed ceiling with linear light strips, cool teal-blue ambient light, floor-to-ceiling windows showing a night city skyline",
  },
  meeting: {
    jp: "会議室",
    en: "a corporate meeting room: one long table with black chairs, a glass wall onto the office floor, horizontal blinds, a wall-mounted display, a warm desk lamp against cool ceiling light",
  },
  server: {
    jp: "サーバールーム",
    en: "a data-centre server room: rows of black server racks with blue LED indicators, cold haze in the air, a heavy metal door, a raised floor and overhead cable trays",
  },
  corridor: {
    jp: "オフィスの廊下",
    en: "a long office corridor: a polished floor reflecting the ceiling lights, doors along both sides, a green emergency exit sign, dim lighting with one strip flickering, deep perspective toward a far door",
  },
  home: {
    jp: "自宅（暗い寝室・机）",
    en: "a small dark Japanese bedroom at night: an unmade bed, a low desk with a laptop and a charging phone, curtains half open with rain on the window, only a faint blue glow lighting the room",
  },
};
export const LOCATION_KEYS = Object.keys(LOCATIONS);
export const locationDescription = (k) => LOCATIONS[k]?.en ?? "";

/** scene_type から推定する既定ロケーション（location を持たない旧 script.json 用）。 */
export const DEFAULT_LOCATION = {
  cold_open: "office",
  setup: "office",
  turn: "office",
  montage: "corridor",
  resolve: "meeting",
};
export const defaultLocation = (type) => DEFAULT_LOCATION[type] ?? "office";

/** 旧台本の話者キーを新キャストへ。 */
export const LEGACY_SPEAKER = { male_young: "hero", female_young: "senpai", female_mature: "senpai", male_mature: "boss" };

/** characters[] を画像／Veo プロンプト用の英語の外見記述に。 */
export const castDescription = (keys = []) =>
  (Array.isArray(keys) ? keys : []).filter((k) => CAST[k]).map((k) => CAST[k].en).join("; ");
