// CLI: ③' ナレーション・セリフ生成
// 使い方: node scripts/narration.mjs <job> [--force]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { generateNarration } from "../usecases/generateNarration.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await generateNarration(createDeps().speech, a.job, { force: a.force });
}
