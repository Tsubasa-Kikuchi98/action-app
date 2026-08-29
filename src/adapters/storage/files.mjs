// FileStore ポートの実装。usecases が node:fs を直接触らずに済むようにする薄いラッパ。
// パス文字列の組み立て（node:path）は純粋な計算なので usecases でそのまま使ってよい。
import fs from "node:fs";

export const exists = (f) => fs.existsSync(f);
/** 存在して中身があるか（0 バイトの書きかけを弾く）。 */
export const ready = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
export const size = (f) => fs.statSync(f).size;
export const mtimeMs = (f) => fs.statSync(f).mtimeMs;

export const read = (f) => fs.readFileSync(f);
export const readText = (f) => fs.readFileSync(f, "utf8");
export const write = (f, data) => fs.writeFileSync(f, data);
export const writeText = (f, text) => fs.writeFileSync(f, text, "utf8");

export const remove = (f) => fs.rmSync(f);
export const removeDir = (d) => fs.rmSync(d, { recursive: true, force: true });
export const mkdir = (d) => fs.mkdirSync(d, { recursive: true });
export const rename = (a, b) => fs.renameSync(a, b);
export const copy = (a, b) => fs.copyFileSync(a, b);
export const list = (d) => fs.readdirSync(d);

/** @type {import("../../domain/script/types.mjs")} FileStore ポートとして usecases に渡す形。 */
export const fileStore = {
  exists, ready, size, mtimeMs,
  read, readText, write, writeText,
  remove, removeDir, mkdir, rename, copy, list,
};
