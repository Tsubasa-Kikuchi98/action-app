// 配布用に ffmpeg / ffprobe を build/ffmpeg/ へコピーする（npm run prepare:ffmpeg）。
//
// exe 版は「Node も ffmpeg も入っていない PC」で動かすのが目的なので、
// electron-builder の extraResources で resources/ffmpeg/ に同梱する。
// 探索順は src/adapters/ffmpeg/exec.mjs の resolveBin と同じ考え方:
//   FFMPEG_DIR（明示） → PATH → winget の Gyan.FFmpeg パッケージ
//
// バイナリ自体は git 管理外（.gitignore の build/ffmpeg/）。配布 PC ごとに用意する必要はなく、
// ビルドする PC に ffmpeg があればよい。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "build", "ffmpeg");
const NAMES = ["ffmpeg", "ffprobe"];
const EXE = process.platform === "win32" ? ".exe" : "";

/** winget（Gyan.FFmpeg）の bin ディレクトリを探す。バージョン番号は固定しない。 */
function wingetBins() {
  const base = path.join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft", "WinGet", "Packages"
  );
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const pkg of fs.readdirSync(base).filter((n) => n.startsWith("Gyan.FFmpeg"))) {
    const dir = path.join(base, pkg);
    for (const build of fs.readdirSync(dir).filter((n) => n.startsWith("ffmpeg-"))) {
      const bin = path.join(dir, build, "bin");
      if (fs.existsSync(bin)) out.push(bin);
    }
  }
  return out;
}

/** ffmpeg / ffprobe が両方そろっているディレクトリを返す。 */
function findBinDir() {
  const cands = [
    ...(process.env.FFMPEG_DIR ? [process.env.FFMPEG_DIR] : []),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...wingetBins(),
  ];
  for (const d of cands) {
    try {
      if (NAMES.every((n) => fs.existsSync(path.join(d, n + EXE)))) return d;
    } catch { /* 読めない PATH 要素は無視 */ }
  }
  return null;
}

const src = findBinDir();
if (!src) {
  console.error(
    "ffmpeg / ffprobe が見つかりません。\n" +
    "  winget install Gyan.FFmpeg  で導入するか、FFMPEG_DIR に bin ディレクトリを指定してください。"
  );
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
for (const n of NAMES) {
  const from = path.join(src, n + EXE);
  const to = path.join(DEST, n + EXE);
  fs.copyFileSync(from, to);
  console.log(`[prepare:ffmpeg] ${to}  (${(fs.statSync(to).size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`[prepare:ffmpeg] 取得元: ${src}`);
