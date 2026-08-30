// 配布形態（開発 / portable exe）ごとのパス解決と、API キーの保存先。
//
// パイプライン（src/adapters/storage/env.mjs）は `TRAILER_ROOT` を見て out/ と assets/ の基準を決める。
// ここはそれを **pipeline.mjs を import する前に** 確定させるための Electron 側のブートストラップ。
//
//   開発（npm run app）        : ROOT = リポジトリルート（従来どおり）
//   portable exe               : ROOT = exe と同じフォルダ（PORTABLE_EXECUTABLE_DIR）
//   exe 隣に書けない場合        : ROOT = app.getPath("userData")（Program Files 等に置かれたとき）
//
// exe には基準画像・効果音・BGM を extraResources で同梱しているので、
// 初回起動時に ROOT/assets/ が空なら同梱物からコピーする（以後はユーザーのものを使う）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

// 開発起動（npm run app）でも userData を %APPDATA%\action-app\ に揃える。
// 既定だと未パッケージ時は %APPDATA%\Electron\ になり、exe 版と設定の置き場がずれる。
app.setName("action-app");

/** exe に同梱したリソース（resources/）。開発時は null。 */
export const bundledDir = () => (app.isPackaged ? process.resourcesPath : null);

/** 書き込めるディレクトリかどうかを実際に試して確かめる。 */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** out/ と assets/ を置く基準ディレクトリを決める。 */
function resolveRoot() {
  if (process.env.TRAILER_ROOT) return path.resolve(process.env.TRAILER_ROOT);
  if (!app.isPackaged) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // portable exe は起動のたびに一時フォルダへ展開されるので、exe 自身の場所は
  // PORTABLE_EXECUTABLE_DIR から取る（nsis 等で無い場合は exe のフォルダ）。
  const beside = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  if (writable(beside)) return beside;
  return app.getPath("userData");
}

/** 同梱の assets/<sub>/ を ROOT/assets/<sub>/ にコピーする（既にあるファイルは触らない）。 */
function seedAssets(root) {
  const src = bundledDir() && path.join(bundledDir(), "assets");
  if (!src || !fs.existsSync(src)) return [];
  const copied = [];
  for (const sub of fs.readdirSync(src, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const from = path.join(src, sub.name);
    const to = path.join(root, "assets", sub.name);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      const dst = path.join(to, f);
      if (fs.existsSync(dst)) continue;
      fs.copyFileSync(path.join(from, f), dst);
      copied.push(path.join(sub.name, f));
    }
  }
  return copied;
}

/**
 * ROOT を確定して `TRAILER_ROOT` に入れ、必要なら素材を配置する。
 * **pipeline.mjs（= src/adapters/storage/env.mjs）を import する前に 1 度だけ呼ぶこと。**
 */
export function bootstrapPaths() {
  const root = resolveRoot();
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  process.env.TRAILER_ROOT = root;
  const copied = seedAssets(root);
  if (copied.length) console.log(`[paths] 同梱素材を配置しました: ${copied.length} 個 → ${path.join(root, "assets")}`);
  console.log(`[paths] ROOT=${root} packaged=${app.isPackaged}`);
  return { root, copied };
}

// ------------------------------------------------------------------ API キー
/** 設定画面で扱うキー。required は未設定だと生成が失敗するもの。 */
export const CONFIG_KEYS = [
  { key: "OPENAI_API_KEY", label: "OpenAI API キー", required: true, note: "台本・画像・ナレーション" },
  { key: "GEMINI_API_KEY", label: "Gemini API キー", required: true, note: "動画生成（Veo）。未設定でも「動画をスキップ」なら生成できます" },
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API キー", required: false, note: "BGM・効果音（任意。未設定なら合成音）" },
];

const configFile = () => path.join(app.getPath("userData"), "config.json");

/** userData/config.json を読む（無ければ空）。 */
export function readConfig() {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** キーがどこから来たかを覚えておく（画面の表示用）。 */
const source = new Map();

/**
 * config.json の値を process.env に流し込む。
 * **`.env` が優先**（dotenv が既に入れた値は上書きしない）ので、
 * これは env.mjs を読み込んだ後に呼ぶこと。
 */
export function applyConfigEnv() {
  const cfg = readConfig();
  for (const { key } of CONFIG_KEYS) {
    if (process.env[key]) {
      source.set(key, "env");
      continue;
    }
    const v = String(cfg[key] ?? "").trim();
    if (v) {
      process.env[key] = v;
      source.set(key, "config");
    } else {
      source.delete(key);
    }
  }
}

/** 設定画面に返す状態（値そのものは末尾 4 文字だけ見せる）。 */
export function configStatus() {
  return {
    file: configFile(),
    keys: CONFIG_KEYS.map((k) => {
      const v = process.env[k.key] ?? "";
      return {
        ...k,
        set: Boolean(v),
        masked: v ? `${"•".repeat(Math.min(12, Math.max(0, v.length - 4)))}${v.slice(-4)}` : "",
        source: source.get(k.key) ?? null,
      };
    }),
  };
}

/**
 * 設定画面からの保存。config.json に書き、その場で process.env にも反映する
 * （再起動なしで次の生成から効く）。空文字はキーの削除として扱う。
 */
export function saveConfig(values = {}) {
  const cfg = readConfig();
  for (const { key } of CONFIG_KEYS) {
    if (!(key in values)) continue;
    const v = String(values[key] ?? "").trim();
    if (v) {
      cfg[key] = v;
      process.env[key] = v;
      source.set(key, "config");
    } else {
      delete cfg[key];
      delete process.env[key];
      source.delete(key);
    }
  }
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return configStatus();
}
