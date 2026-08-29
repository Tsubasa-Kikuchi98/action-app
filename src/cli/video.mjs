// CLI: ③ 動画生成（Veo）
// 使い方: node scripts/video.mjs <job> [--force] [--stills] [--dry-run]
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { generateVideos } from "../usecases/generateVideos.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  await generateVideos(createDeps().video, a.job, { force: a.force, stills: a.stills, dryRun: a.dryRun });
}
