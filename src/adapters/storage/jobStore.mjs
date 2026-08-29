// out/<job>/ のパス解決・script.json の読み書き・log.jsonl への追記（JobStore ポートの実装）。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";
import { estimateCost } from "../../domain/pricing.mjs";

export { ROOT };

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

/** ファイルが存在して中身があるか。 */
export const fileReady = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
