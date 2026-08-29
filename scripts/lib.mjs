// 各工程スクリプトの共通ライブラリ。
// - .env 読み込み / OpenAI クライアント
// - ffmpeg / ffprobe のパス解決（PATH → winget フォールバック）
// - out/<job>/ 以下のパス
// - usage / 所要秒のログ（out/<job>/log.jsonl に追記）
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- OpenAI
let _openai = null;
export function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY が未設定です（.env を確認してください）");
  }
  _openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ---------------------------------------------------------------- Gemini（Veo）
let _genai = null;
export function getGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY が未設定です（.env を確認してください）");
  }
  _genai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _genai;
}

// ---------------------------------------------------------------- モデル名
export const MODELS = {
  script: process.env.SCRIPT_MODEL ?? "gpt-5.6-luna",
  image: process.env.IMG_MODEL ?? "gpt-image-2",
  tts: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
  // Phase 2: 動画生成（Google Gemini API）。品質を上げるなら veo-3.1-fast-generate-preview
  video: process.env.VEO_MODEL ?? "veo-3.1-lite-generate-preview",
};

// 推定コスト用の単価（USD）。実請求額は OpenAI のダッシュボードで確認すること。
// ここでの値は「開発中の目安」で、env で上書きできる。
export const PRICES = {
  // テキスト: 100万トークンあたり
  "gpt-5.6-luna": {
    in: Number(process.env.PRICE_SCRIPT_IN ?? 1.25),
    out: Number(process.env.PRICE_SCRIPT_OUT ?? 10),
  },
  // TTS: 課金はトークンだが公式の目安は「音声 1 分あたり」なので実尺で見積もる。
  "gpt-4o-mini-tts": {
    perAudioMin: Number(process.env.PRICE_TTS_PER_MIN ?? 0.015),
  },
  // 画像: 1枚あたり（1536x1024 の概算）。quality で単価が変わるので usage.quality を見る。
  "gpt-image-2": {
    perImage: Number(process.env.PRICE_IMAGE_LOW ?? 0.016),
    perImageByQuality: {
      low: Number(process.env.PRICE_IMAGE_LOW ?? 0.016),
      medium: Number(process.env.PRICE_IMAGE_MEDIUM ?? 0.042),
      high: Number(process.env.PRICE_IMAGE_HIGH ?? 0.167),
    },
  },
  // 動画: 生成1秒あたり（Veo 3.1 Lite 720p は $0.05/秒・無料枠なし）
  "veo-3.1-lite-generate-preview": { perSec: Number(process.env.PRICE_VEO_LITE ?? 0.05) },
  "veo-3.1-fast-generate-preview": { perSec: Number(process.env.PRICE_VEO_FAST ?? 0.15) },
};

export function estimateCost(model, usage = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  if (p.perImage != null) {
    const unit = p.perImageByQuality?.[usage.quality] ?? p.perImage;
    return unit * (usage.images ?? 1);
  }
  if (p.perSec != null) return p.perSec * (usage.video_sec ?? 0);
  if (p.perAudioMin != null) return (p.perAudioMin * (usage.audio_sec ?? 0)) / 60;
  const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// ---------------------------------------------------------------- パス
export function jobDir(job) {
  if (!job) throw new Error("job 名が指定されていません");
  return path.join(ROOT, "out", job);
}

export function jobPaths(job) {
  const d = jobDir(job);
  return {
    dir: d,
    script: path.join(d, "script.json"),
    log: path.join(d, "log.jsonl"),
    img: path.join(d, "img"),
    vid: path.join(d, "vid"),
    nar: path.join(d, "nar"),
    dlg: path.join(d, "dlg"),
    telop: path.join(d, "telop"),
    scenes: path.join(d, "scenes"),
    cuts: path.join(d, "cuts"),
    ass: path.join(d, "telop.ass"),
    fc: path.join(d, "fc.txt"),
    trailer: path.join(d, "trailer.mp4"),
  };
}

export function ensureDirs(job, ...keys) {
  const p = jobPaths(job);
  fs.mkdirSync(p.dir, { recursive: true });
  for (const k of keys) fs.mkdirSync(p[k], { recursive: true });
  return p;
}

export function readScript(job) {
  const p = jobPaths(job);
  if (!fs.existsSync(p.script)) {
    throw new Error(`script.json がありません: ${p.script}\n先に scripts/script.mjs を実行してください`);
  }
  return JSON.parse(fs.readFileSync(p.script, "utf8"));
}

export function writeScript(job, data) {
  const p = jobPaths(job);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.script, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------- ログ
export function logEvent(job, entry) {
  const p = jobPaths(job);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.appendFileSync(p.log, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

/** API 呼び出しを計測してログに残す。fn は { result, usage, model } を返す。 */
export async function timed(job, step, fn, meta = {}) {
  const t0 = Date.now();
  try {
    const { result, usage, model } = await fn();
    const sec = (Date.now() - t0) / 1000;
    const cost = model ? estimateCost(model, usage ?? {}) : 0;
    logEvent(job, {
      step,
      ok: true,
      sec: Number(sec.toFixed(2)),
      model: model ?? null,
      usage: usage ?? null,
      cost_usd: Number(cost.toFixed(5)),
      ...meta,
    });
    return { result, usage, sec, cost };
  } catch (e) {
    const sec = (Date.now() - t0) / 1000;
    logEvent(job, { step, ok: false, sec: Number(sec.toFixed(2)), error: String(e?.message ?? e), ...meta });
    throw e;
  }
}

/** log.jsonl を集計して合計コスト・合計秒を返す。 */
export function summarizeLog(job) {
  const p = jobPaths(job);
  if (!fs.existsSync(p.log)) return { totalCost: 0, totalSec: 0, rows: [] };
  const rows = fs
    .readFileSync(p.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    totalCost: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    totalSec: rows.reduce((a, r) => a + (r.sec ?? 0), 0),
    rows,
  };
}

// ---------------------------------------------------------------- ffmpeg
const WINGET_BIN = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin"
);

/** PATH → winget フォールバックの順に実行ファイルを解決する。 */
function resolveBin(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(d, name + ext);
      try {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
      } catch {
        /* アクセスできない PATH 要素は無視 */
      }
    }
  }
  for (const ext of exts) {
    const f = path.join(WINGET_BIN, name + ext);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`${name} が見つかりません。PATH を通すか winget で ffmpeg を導入してください。`);
}

let _ffmpeg = null;
let _ffprobe = null;
export const ffmpegPath = () => (_ffmpeg ??= resolveBin("ffmpeg"));
export const ffprobePath = () => (_ffprobe ??= resolveBin("ffprobe"));

/** 子プロセスを実行して { code, stdout, stderr } を返す（shell は使わない）。 */
export function run(bin, args, { cwd = ROOT, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn(bin, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    ps.stdout.on("data", (b) => { out += b; });
    ps.stderr.on("data", (b) => { err += b; if (!quiet) process.stderr.write(b); });
    ps.on("error", reject);
    ps.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

/** ffmpeg を実行。失敗時は stderr を表示して例外を投げる。 */
export async function ffmpeg(args, opts = {}) {
  const r = await run(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);
  if (r.code !== 0) {
    console.error("---- ffmpeg stderr ----");
    console.error(r.stderr.trim());
    console.error("---- ffmpeg args ----");
    console.error(args.join(" "));
    throw new Error(`ffmpeg が失敗しました (exit ${r.code})`);
  }
  return r;
}

/** メディアの尺（秒）を ffprobe で取得。 */
export async function probeDuration(file) {
  const r = await run(ffprobePath(), [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  const v = parseFloat(r.stdout.trim());
  if (!Number.isFinite(v)) throw new Error(`尺を取得できません: ${file}\n${r.stderr}`);
  return v;
}

/**
 * volumedetect で mean/max ボリューム（dBFS）を測る。
 * 音声ストリームが無い場合は null を返す。区間を測るときは ss / to（秒）を渡す。
 */
export async function probeVolume(file, { ss = null, to = null } = {}) {
  const pre = [];
  if (ss != null) pre.push("-ss", String(ss));
  if (to != null) pre.push("-to", String(to));
  const r = await run(ffmpegPath(), [
    "-hide_banner", "-nostdin",
    ...pre,
    "-i", file,
    "-map", "0:a:0?",
    "-af", "volumedetect",
    "-f", "null", "-",
  ]);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!mean) return null;
  return { mean: parseFloat(mean[1]), max: max ? parseFloat(max[1]) : null };
}

/** 動画の要約（解像度 / fps / コーデック / 尺）。 */
export async function probeSummary(file) {
  const r = await run(ffprobePath(), [
    "-v", "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,size",
    "-of", "json",
    file,
  ]);
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------- ユーティリティ
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 429 / 5xx を指数バックオフでリトライ（既定: 最大3回リトライ）。 */
export async function withRetry(fn, { tries = 4, base = 2000, label = "" } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = e?.status ?? e?.response?.status ?? 0;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || i === tries - 1) throw e;
      const wait = base * 2 ** i;
      console.warn(`  [retry] ${label} status=${status} → ${wait / 1000}s 待機 (${i + 1}/${tries - 1})`);
      await sleep(wait);
    }
  }
  throw last;
}

/** ffmpeg の filter/drawtext 用に絶対パスをエスケープ（C:/... → C\:/...）。 */
export const escFilterPath = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");

/** 秒数を fps 換算のフレーム数に。 */
export const frames = (sec, fps = 30) => Math.max(1, Math.round(sec * fps));

export const fmtUSD = (n) => `$${n.toFixed(4)}`;

/** ミリ秒を "12.3s" 形式に。 */
export const fmtSec = (sec) => `${sec.toFixed(1)}s`;

/** そのモジュールが `node scripts/xxx.mjs` として直接実行されたかを判定（Windows 対応）。 */
export function isMain(importMetaUrl) {
  try {
    const self = path.resolve(fileURLToPath(importMetaUrl));
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return self.toLowerCase() === argv1.toLowerCase();
  } catch {
    return false;
  }
}
