// 互換エントリ: 実装は src/cli/run.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/run.mjs ...）。
import { main } from "../src/cli/run.mjs";
await main(process.argv.slice(2));
