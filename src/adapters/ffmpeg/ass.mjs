// ASS（テロップ）ファイルの書き出し。文字列生成は domain/timeline/ass.mjs。
import fs from "node:fs";
import { buildAss } from "../../domain/timeline/ass.mjs";

/**
 * ASS イベントの配列を 1 枚の .ass に書き出す。
 * @param {string} file 出力先（絶対パス）
 * @param {object[]} events domain の ASS イベント
 * @returns {number} 書き出したイベント数
 */
export function writeAss(file, events) {
  fs.writeFileSync(file, buildAss(events), "utf8");
  return events.length;
}
