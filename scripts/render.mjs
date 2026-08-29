// 互換エントリ: 実装は src/cli/render.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/render.mjs ...）。
import { main } from "../src/cli/render.mjs";
await main(process.argv.slice(2));
