// assets/refs/ の基準画像（キャラクターシート・ロケーションプレート）の置き場。
// ジョブ横断で使い回すので out/<job>/ ではなく assets/ に置く（git 管理外）。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";
import { CAST, LOCATIONS } from "../../domain/cast.mjs";
import { enrichedView } from "../../domain/script/index.mjs";

/** 基準画像の置き場。 */
export const REFS_DIR = path.join(ROOT, "assets", "refs");

/** 基準画像は「顔が再現できること」が全てなので、開発中でも medium を既定にする。 */
export const REFS_QUALITY = process.env.REFS_QUALITY ?? "medium";
export const REFS_SIZE = process.env.REFS_SIZE ?? "1536x1024";

/** 基準画像を記録するログ用の疑似ジョブ名（out/_refs/log.jsonl）。 */
export const REFS_JOB = "_refs";

export const charRefPath = (key) => path.join(REFS_DIR, `char_${key}.png`);
export const locRefPath = (key) => path.join(REFS_DIR, `loc_${key}.png`);

export const exists = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
export const hasCharRef = (key) => exists(charRefPath(key));
export const hasLocRef = (key) => exists(locRefPath(key));

/** 基準画像を書き出す（ディレクトリは自動作成）。 */
export function writeRef(file, buf) {
  fs.mkdirSync(REFS_DIR, { recursive: true });
  fs.writeFileSync(file, buf);
}

/** 台本が必要とするキャラ／ロケのキーを重複なく集める。 */
export function refsNeededForScript(data) {
  const view = enrichedView(data);
  const chars = new Set();
  const locs = new Set();
  for (const s of view.scenes) {
    for (const c of s.characters ?? []) if (CAST[c]) chars.add(c);
    if (LOCATIONS[s.location]) locs.add(s.location);
  }
  return { chars: [...chars], locs: [...locs] };
}

/**
 * 1 シーンに添付する参照画像のパス一覧を返す（キャラ最大 3 枚 ＋ ロケ 1 枚）。
 * 存在しないものは黙って落とす（1 枚も無ければ generateImages が generations にフォールバックする）。
 */
export function sceneRefs(scene) {
  const chars = (scene.characters ?? []).filter((k) => CAST[k]).slice(0, 3).filter(hasCharRef);
  const loc = LOCATIONS[scene.location] && hasLocRef(scene.location) ? scene.location : null;
  return {
    chars,
    loc,
    files: [...chars.map(charRefPath), ...(loc ? [locRefPath(loc)] : [])],
  };
}
