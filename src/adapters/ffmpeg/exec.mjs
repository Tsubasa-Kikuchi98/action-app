// ffmpeg / ffprobe の実行と計測（MediaTool ポートの実装）。
// PATH → winget フォールバックの順に実行ファイルを解決する。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../storage/env.mjs";

const WINGET_BIN = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin"
);

/** PATH → winget フォールバックの順に実行ファイルを解決する。 */
export function resolveBin(name) {
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

/**
 * 音声を一定長の窓に切って窓ごとの RMS（dB）を返す。ffmpeg 1 回で済ませる。
 *   asetnsamples で窓を作り、astats を窓ごとにリセットして ametadata で吐かせる。
 * @param {string} file
 * @param {{windowSec?: number, af?: string}} opts af は astats の前に挟むフィルタ（帯域制限など）
 * @returns {Promise<Array<{t: number, rms: number}>>} 音声が無ければ空配列
 */
export async function probeLevels(file, { windowSec = 0.4, af = "" } = {}) {
  const n = Math.max(1, Math.round(48000 * windowSec));
  const chain = [
    "aresample=48000",
    af,
    `asetnsamples=n=${n}:p=0`,
    "astats=metadata=1:reset=1",
    "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
  ].filter(Boolean).join(",");
  const r = await run(ffmpegPath(), [
    "-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0?", "-af", chain, "-f", "null", "-",
  ]);
  const out = [];
  // frame:0    pts:0       pts_time:0
  // lavfi.astats.Overall.RMS_level=-32.123
  let t = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /pts_time:([-0-9.]+)/.exec(line);
    if (m) { t = parseFloat(m[1]); continue; }
    const v = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (v && t != null) {
      out.push({ t, rms: v[1] === "-inf" ? -100 : parseFloat(v[1]) });
      t = null;
    }
  }
  return out;
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

/** ffmpeg の filter/drawtext 用に絶対パスをエスケープ（C:/... → C\:/...）。 */
export const escFilterPath = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
