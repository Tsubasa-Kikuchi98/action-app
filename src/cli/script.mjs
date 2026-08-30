// CLI: ① 台本生成
// 使い方: node scripts/script.mjs "<エピソード文>" <job> [--style=narration|dialogue|nolan]
//         node scripts/script.mjs --dry-run [--style=nolan]（API を呼ばずスキーマとプロンプトだけ検証）
//         TRAILER_STYLE=nolan node scripts/script.mjs "<エピソード文>" <job>
import { parseArgs } from "./args.mjs";
import { createDeps } from "./deps.mjs";
import { STYLES, DEFAULT_STYLE } from "../domain/script/index.mjs";
import { buildScriptSchema, buildScriptSystemPrompt, validateSchema } from "../domain/prompts/scriptPrompt.mjs";
import { generateScript } from "../usecases/generateScript.mjs";

export async function main(argv) {
  const a = parseArgs(argv);
  const styleArg = a.value("style");
  const style = STYLES.includes(styleArg ?? "") ? styleArg : DEFAULT_STYLE;

  if (a.dryRun) {
    const schema = buildScriptSchema(style);
    const errs = validateSchema(schema);
    console.log("---- SYSTEM PROMPT ----");
    console.log(buildScriptSystemPrompt(style));
    console.log("\n---- JSON SCHEMA (strict) ----");
    console.log(JSON.stringify(schema, null, 2));
    console.log(`\n---- 検証 (style=${style}) ----`);
    if (errs.length) {
      for (const e of errs) console.error(`  NG ${e}`);
      process.exit(1);
    }
    console.log("  OK: strict モードで使える形です（API は呼んでいません）");
    process.exit(0);
  }

  const [episode, job = "demo1"] = a.positional;
  if (!episode) {
    console.error('usage: node scripts/script.mjs "<エピソード文>" <job> [--style=narration|dialogue|nolan]   /   node scripts/script.mjs --dry-run');
    process.exit(1);
  }
  await generateScript(createDeps().script, episode, job, { style });
}
