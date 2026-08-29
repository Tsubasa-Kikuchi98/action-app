// 互換エントリ: 実装は src/cli/narration.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/narration.mjs ...）。
import { main } from "../src/cli/narration.mjs";
await main(process.argv.slice(2));
