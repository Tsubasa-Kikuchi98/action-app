// 互換エントリ: 実装は src/cli/sfx.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/sfx.mjs ...）。
import { main } from "../src/cli/sfx.mjs";
await main(process.argv.slice(2));
