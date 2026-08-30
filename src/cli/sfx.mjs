// CLI: ⑥ 効果音（ブラーム）
// 使い方:
//   node scripts/sfx.mjs                     不足している効果音だけ作る（assets/sfx/）
//   node scripts/sfx.mjs --names=braam,riser 一部だけ
//   node scripts/sfx.mjs --force             既存を作り直す
//   node scripts/sfx.mjs --dry-run           プロンプトだけ表示（API は呼ばない）
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { prepareSfx } from "../usecases/prepareSfx.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  const raw = a.value("names");
  const names = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  await prepareSfx(createDeps().sfx, { force: a.force, dryRun: a.dryRun, names });
}
