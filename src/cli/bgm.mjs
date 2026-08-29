// CLI: ④ BGM
// 使い方: node scripts/bgm.mjs <job> [--force]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { prepareBgm } from "../usecases/prepareBgm.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await prepareBgm(createDeps().bgm, a.job, { force: a.force });
}
