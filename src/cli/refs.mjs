// CLI: ⓪ 基準画像（キャラクターシート・ロケーションプレート）
// 使い方:
//   node scripts/refs.mjs --chars                     全キャラのキャラクターシート
//   node scripts/refs.mjs --chars=hero,boss           一部だけ
//   node scripts/refs.mjs --locs office,meeting       指定ロケの基準プレート
//   node scripts/refs.mjs --locs all                  全ロケ
//   node scripts/refs.mjs --job lambda                その台本が必要とする分だけ
//   共通フラグ: --force（既存を作り直す） --dry-run（プロンプトだけ表示）
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { CAST, LOCATION_KEYS } from "../domain/cast.mjs";
import { prepareRefs } from "../usecases/prepareRefs.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  const deps = createDeps();
  const listOf = (raw, all) =>
    raw === "" || raw === "all" ? all : raw.split(",").map((s) => s.trim()).filter(Boolean);

  let chars = [];
  let locs = [];

  const jobRaw = a.value("job");
  const jobPos = a.positional[0];
  const job = jobRaw || jobPos;
  if (job) {
    const need = deps.refs.refsNeededForScript(deps.store.readScript(job));
    chars = need.chars;
    locs = need.locs;
    console.log(`[refs] job=${job} → キャラ ${chars.join(",") || "-"} / ロケ ${locs.join(",") || "-"}`);
  }
  const cRaw = a.value("chars");
  if (cRaw !== null) chars = [...new Set([...chars, ...listOf(cRaw, Object.keys(CAST))])];
  const lRaw = a.value("locs");
  if (lRaw !== null) locs = [...new Set([...locs, ...listOf(lRaw, LOCATION_KEYS)])];

  if (!chars.length && !locs.length) {
    console.error(
      "usage: node scripts/refs.mjs [--chars[=hero,senpai,boss]] [--locs=office,meeting|all] [--job <job>] [--force] [--dry-run]"
    );
    process.exit(1);
  }
  await prepareRefs(deps.refsUseCase, { chars, locs, force: a.force, dryRun: a.dryRun });
}
