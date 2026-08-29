// CLI: ①' 演出情報の付与（既存フィールドは変更しない）
// 使い方: node scripts/enrich.mjs <job> [--force] [--dry-run]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { enrichScript } from "../usecases/enrichScript.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await enrichScript(createDeps().script, a.job, { force: a.force, dryRun: a.dryRun });
}
