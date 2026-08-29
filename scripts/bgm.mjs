// 互換エントリ: 実装は src/cli/bgm.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/bgm.mjs ...）。
import { main } from "../src/cli/bgm.mjs";
await main(process.argv.slice(2));
