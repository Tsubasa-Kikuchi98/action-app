// 互換エントリ: 実装は src/cli/script.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/script.mjs ...）。
import { main } from "../src/cli/script.mjs";
await main(process.argv.slice(2));
