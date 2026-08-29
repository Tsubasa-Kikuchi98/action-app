// CLI: ② 画像生成
// 使い方: node scripts/images.mjs <job> [--force]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { generateImages } from "../usecases/generateImages.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await generateImages(createDeps().image, a.job, { force: a.force });
}
