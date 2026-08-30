// Electron main プロセス（ESM）。
//
// 役割は 3 つだけ:
//   1. ウィンドウを 1 枚出す（contextIsolation: true / nodeIntegration: false / preload 経由のみ）
//   2. app/pipeline.mjs を呼び、工程イベントを webContents に流す
//   3. 完成した mp4 と過去ジョブを renderer に見せる（media:// カスタムスキーム）
//
// パイプライン本体（src/usecases）は main プロセスの中で直接 import して動かす。
// 子プロセスにしないのは、log.jsonl や中間生成物の扱いを CLI とまったく同じにするため。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } from "electron";
import { bootstrapPaths, applyConfigEnv, configStatus, saveConfig } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// out/ 以下のメディアを renderer に見せるための専用スキーム。
// file:// を直接読ませるより許可範囲を絞れる（out/ の外は 403）。
protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

// ROOT（out/ と assets/ の置き場）は pipeline を import する前に確定させる。
// 開発ならリポジトリルート、portable exe なら exe と同じフォルダ。
const boot = bootstrapPaths();
let ROOT = boot.root;
let pipeline = null;

/** パイプライン一式は .env の読み込みを伴うので、app.whenReady 後に遅延 import する。 */
async function loadPipeline() {
  if (!pipeline) {
    pipeline = await import("./pipeline.mjs");
    ROOT = pipeline.ROOT;
    // .env（env.mjs の dotenv）が読まれた後に config.json を足す。.env が優先。
    applyConfigEnv();
  }
  return pipeline;
}

// ------------------------------------------------------------- 実行中の状態
/** 同時に 1 本しか走らせない。 */
let running = null;
let cancelRequested = false;

// ------------------------------------------------------------------ 過去ジョブ
const MEDIA_EXT = new Set([".mp4", ".png", ".jpg", ".wav", ".mp3"]);

function listJobs() {
  const outDir = path.join(ROOT, "out");
  if (!fs.existsSync(outDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(outDir)) {
    if (name.startsWith("_")) continue; // out/_refs, out/_sfx, out/_mock は作業用
    const file = path.join(outDir, name, "trailer.mp4");
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) continue;
    const st = fs.statSync(file);
    let title = "";
    try {
      title = JSON.parse(fs.readFileSync(path.join(outDir, name, "script.json"), "utf8")).title ?? "";
    } catch { /* script.json が無い / 壊れているジョブは題名なしで出す */ }
    rows.push({
      job: name,
      title,
      mtime: st.mtimeMs,
      sizeMb: Number((st.size / 1024 / 1024).toFixed(1)),
      url: mediaUrl(name),
    });
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

const mediaUrl = (job) => `media://local/out/${encodeURIComponent(job)}/trailer.mp4?t=${Date.now()}`;

// ------------------------------------------------------------------ ウィンドウ
function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#12161c",
    title: "action-app — 予告編ジェネレーター",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(HERE, "renderer", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  await loadPipeline();

  // media://local/<ROOT からの相対パス> → out/ 以下のファイルだけを返す。
  protocol.handle("media", async (req) => {
    try {
      const u = new URL(req.url);
      const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      const abs = path.resolve(ROOT, relPath);
      const outDir = path.join(ROOT, "out");
      if (!abs.startsWith(outDir + path.sep)) return new Response("forbidden", { status: 403 });
      if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) return new Response("forbidden", { status: 403 });
      if (!fs.existsSync(abs)) return new Response("not found", { status: 404 });
      return net.fetch(pathToFileURL(abs).toString());
    } catch (e) {
      return new Response(String(e?.message ?? e), { status: 500 });
    }
  });

  const win = createWindow();

  // 開発時の自動操作＋スクリーンショット（TRAILER_SHOT_DIR が指定されたときだけ）
  if (process.env.TRAILER_SHOT_DIR) {
    const { attach } = await import("./devshot.mjs");
    attach(win, process.env.TRAILER_SHOT_DIR);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ------------------------------------------------------------------ IPC
ipcMain.handle("app:defaults", async () => {
  const { suggestJobName, isMock, APP_STEPS } = await loadPipeline();
  return {
    job: suggestJobName(),
    mock: isMock(),
    root: ROOT,
    steps: APP_STEPS,
    styles: ["nolan", "narration"],
    running: Boolean(running),
    version: app.getVersion(),
    packaged: app.isPackaged,
    config: configStatus(),
  };
});

// ------------------------------------------------------------------ 設定（API キー）
ipcMain.handle("app:config", () => configStatus());

ipcMain.handle("app:config-save", (_e, values) => {
  try {
    return { ok: true, config: saveConfig(values ?? {}) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle("app:jobs", () => listJobs());

ipcMain.handle("app:script", (_e, job) => {
  const f = path.join(ROOT, "out", String(job ?? ""), "script.json");
  if (!fs.existsSync(f)) return { ok: false, error: `script.json がありません: ${f}` };
  try {
    return { ok: true, json: JSON.parse(fs.readFileSync(f, "utf8")), path: f };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle("app:open-folder", async (_e, job) => {
  const dir = path.join(ROOT, "out", String(job ?? ""));
  if (!fs.existsSync(dir)) return { ok: false, error: `フォルダがありません: ${dir}` };
  const file = path.join(dir, "trailer.mp4");
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else await shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle("app:cancel", () => {
  if (!running) return { ok: false };
  cancelRequested = true;
  return { ok: true };
});

ipcMain.handle("app:generate", async (e, opts = {}) => {
  const { runAppPipeline, sanitizeJob, isMock } = await loadPipeline();
  if (running) return { ok: false, error: "すでに生成中です" };

  const episode = String(opts.episode ?? "").trim();
  if (!episode) return { ok: false, error: "エピソード文が空です" };
  const job = sanitizeJob(opts.job);
  const style = ["nolan", "narration", "dialogue"].includes(opts.style) ? opts.style : "nolan";

  const wc = e.sender;
  const send = (ev) => { if (!wc.isDestroyed()) wc.send("pipeline:event", ev); };

  cancelRequested = false;
  running = (async () => {
    try {
      await runAppPipeline({
        episode, job, style,
        force: Boolean(opts.force),
        stills: Boolean(opts.stills),
        onEvent: send,
        shouldCancel: () => cancelRequested,
      });
    } catch {
      /* エラーは onEvent で通知済み。ここでは握って UI の操作を戻すだけ */
    } finally {
      running = null;
      cancelRequested = false;
      send({ type: "finished", job, url: mediaUrl(job), jobs: listJobs() });
    }
  })();

  return { ok: true, job, mock: isMock() };
});

ipcMain.handle("app:error-dialog", (_e, message) => {
  dialog.showErrorBox("action-app", String(message ?? ""));
});
