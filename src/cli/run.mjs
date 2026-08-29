// CLI: ①〜⑤ の一気通貫
// 使い方: node scripts/run.mjs "<エピソード文>" <job> [--force] [--skip-script] [--stills]
//         npm run trailer -- "<エピソード文>" demo1
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { runPipeline } from "../usecases/runPipeline.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  const [episode, job = "demo1"] = a.positional;
  if (!episode) {
    console.error('usage: node scripts/run.mjs "<エピソード文>" <job> [--force] [--skip-script] [--stills]');
    process.exit(1);
  }
  await runPipeline(createDeps(), episode, job, {
    force: a.force,
    skipScript: a.skipScript,
    stills: a.stills,
  });
}
