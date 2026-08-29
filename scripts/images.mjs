// 互換エントリ: 実装は src/cli/images.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/images.mjs ...）。
import { main } from "../src/cli/images.mjs";
await main(process.argv.slice(2));
