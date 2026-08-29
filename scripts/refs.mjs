// 互換エントリ: 実装は src/cli/refs.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/refs.mjs ...）。
import { main } from "../src/cli/refs.mjs";
await main(process.argv.slice(2));
