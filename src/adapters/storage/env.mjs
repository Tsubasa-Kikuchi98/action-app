// .env の読み込みとルートディレクトリの解決。
// 副作用（dotenv）を持つのはここ 1 箇所だけ。cli 層が最初に import する。
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリルート（src/adapters/storage/ から 3 つ上）。パッケージ時は asar の中を指す。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * 生成物（out/）と素材（assets/）の基準ディレクトリ。
 *
 * 既定はリポジトリルート。**exe（portable）で起動したときは書き込めない場所になる**ので、
 * Electron main（app/paths.mjs）が exe と同じフォルダ等を `TRAILER_ROOT` に入れてから
 * パイプラインを import する。CLI では従来どおり未設定＝リポジトリルート。
 */
export const ROOT = path.resolve(process.env.TRAILER_ROOT || REPO_ROOT);

// .env は ROOT → リポジトリルートの順に探す（先に見つかった値が勝つ。既存の process.env は上書きしない）。
for (const f of new Set([path.join(ROOT, ".env"), path.join(REPO_ROOT, ".env")])) {
  dotenv.config({ path: f, quiet: true });
}

/** ROOT からの相対パスをスラッシュ区切りで返す（filter 内の : エスケープを避ける）。 */
export const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/");

/** モデル名（env で差し替え可）。 */
export const MODELS = {
  script: process.env.SCRIPT_MODEL ?? "gpt-5.6-luna",
  image: process.env.IMG_MODEL ?? "gpt-image-2",
  tts: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
  // Phase 2: 動画生成（Google Gemini API）。品質を上げるなら veo-3.1-fast-generate-preview
  video: process.env.VEO_MODEL ?? "veo-3.1-lite-generate-preview",
};
