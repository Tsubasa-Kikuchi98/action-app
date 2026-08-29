// CLI: ⑤ 合成
// 使い方: node scripts/render.mjs <job> [--force]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { renderTrailer } from "../usecases/renderTrailer.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await renderTrailer(createDeps().render, a.job, { force: a.force });
}
