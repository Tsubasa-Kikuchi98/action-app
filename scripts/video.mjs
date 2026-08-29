// 互換エントリ: 実装は src/cli/video.mjs（クリーンアーキテクチャの cli 層）にあります。
// コマンドの使い方は従来どおり（node scripts/video.mjs ...）。
import { main } from "../src/cli/video.mjs";
await main(process.argv.slice(2));
