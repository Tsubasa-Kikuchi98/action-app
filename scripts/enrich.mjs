// 互換エントリ: 実装は src/cli/enrich.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/enrich.mjs ...）。
import { main } from "../src/cli/enrich.mjs";
await main(process.argv.slice(2));
