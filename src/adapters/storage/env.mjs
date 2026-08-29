// .env の読み込みとリポジトリルートの解決。
// 副作用（dotenv/config）を持つのはここ 1 箇所だけ。cli 層が最初に import する。
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリルート（src/adapters/storage/ から 3 つ上）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
