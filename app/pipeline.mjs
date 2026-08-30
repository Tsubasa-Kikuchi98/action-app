// デスクトップアプリ用のパイプライン実行。
//
// src/ は一切変更しないので、進捗は「usecases を runPipeline と同じ順序・条件で自分で呼び、
// 工程の開始・終了をイベントにする」方式で取る。工程内部の細かい進捗（Veo の n/3 本、
// 画像の枚数、費用）は **JobStore ポートの timed() をラップ**して拾う。
// timed() は API 呼び出しごとに 1 回呼ばれ、{ sec, cost } を返すので、
// ここを通せば log.jsonl を読み直さずに費用と件数が積算できる。
import path from "node:path";
import { createDeps, ROOT } from "../src/cli/deps.mjs";
import { isEnriched } from "../src/domain/script/index.mjs";
import { generateScript } from "../src/usecases/generateScript.mjs";
import { enrichScript } from "../src/usecases/enrichScript.mjs";
import { prepareRefs } from "../src/usecases/prepareRefs.mjs";
import { generateImages } from "../src/usecases/generateImages.mjs";
import { generateNarration } from "../src/usecases/generateNarration.mjs";
import { generateVideos } from "../src/usecases/generateVideos.mjs";
import { prepareBgm } from "../src/usecases/prepareBgm.mjs";
import { prepareSfx } from "../src/usecases/prepareSfx.mjs";
import { renderTrailer } from "../src/usecases/renderTrailer.mjs";
import { applyMocks } from "./mock.mjs";

export { ROOT };

/** 画面に出す工程行（順序どおり）。②と③' は並列に走るので同時に「実行中」になる。 */
export const APP_STEPS = [
  { id: "script", label: "① 台本" },
  { id: "refs", label: "⓪ 基準画像" },
  { id: "images", label: "② シーン画像" },
  { id: "audio", label: "③' 音声 / BGM / 効果音" },
  { id: "video", label: "③ 動画（Veo）" },
  { id: "render", label: "⑤ 合成" },
];

/** log.jsonl の step 名 → 画面の工程行。 */
const STEP_OF_LOG = {
  script: "script", enrich: "script",
  ref_char: "refs", ref_loc: "refs",
  image: "images",
  tts: "audio", "tts-dialogue": "audio", "tts-button": "audio", bgm: "audio", sfx: "audio",
  video: "video",
};

/** モックかどうか（環境変数 TRAILER_MOCK）。 */
export const isMock = () => ["1", "true", "on", "yes"].includes(String(process.env.TRAILER_MOCK ?? "").toLowerCase());

export class CancelledError extends Error {
  constructor() {
    super("中止しました");
    this.name = "CancelledError";
  }
}

/** ジョブ名の既定値（job-YYYYMMDD-HHmm）。 */
export function suggestJobName(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `job-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 画面から来たジョブ名を安全な形に落とす（ディレクトリ名になるため）。 */
export function sanitizeJob(job) {
  const s = String(job ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "").slice(0, 60);
  return s || suggestJobName();
}

/** deps 内のすべての「.store を持つサブ依存」に差し替えた store を配る。 */
function replaceStore(deps, store) {
  deps.store = store;
  for (const v of Object.values(deps)) {
    if (v && typeof v === "object" && "store" in v) v.store = store;
  }
  return deps;
}

/** console.* を横取りして onLog に流す。戻り値を呼ぶと元に戻る。 */
function captureConsole(onLog) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const fmt = (args) =>
    args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
      .join(" ");
  console.log = (...a) => { orig.log(...a); onLog("info", fmt(a)); };
  console.warn = (...a) => { orig.warn(...a); onLog("warn", fmt(a)); };
  console.error = (...a) => { orig.error(...a); onLog("error", fmt(a)); };
  return () => Object.assign(console, orig);
}

/**
 * ①〜⑤ を順に実行し、工程ごとの進捗をイベントで通知する。
 *
 * @param {object} opts
 * @param {string} opts.episode  エピソード文
 * @param {string} opts.job      ジョブ名（out/<job>/）
 * @param {string} opts.style    narration | dialogue | nolan
 * @param {boolean} [opts.force] 既存の中間生成物を作り直す
 * @param {boolean} [opts.stills] ③ 動画をスキップして静止画 Ken Burns にする
 * @param {(ev: object) => void} opts.onEvent
 * @param {() => boolean} [opts.shouldCancel] true を返したら以後の工程を止める
 */
export async function runAppPipeline({
  episode, job, style = "nolan", force = false, stills = false,
  onEvent = () => {}, shouldCancel = () => false,
}) {
  const mock = isMock();
  const deps = mock ? applyMocks(createDeps()) : createDeps();
  const base = deps.store; // 素の JobStore ポート（timed をラップする元）

  const t0 = Date.now();
  const perStep = new Map(APP_STEPS.map((s) => [s.id, { sec: 0, cost: 0, calls: 0 }]));
  let totalCost = 0;
  let current = "script";
  let veoDone = 0;
  let veoTotal = 0;

  // --- timed() のラップ: API 1 本ごとに費用と件数を拾う -----------------------
  const store = {
    ...base,
    timed: async (j, stepName, fn, meta) => {
      const r = await base.timed(j, stepName, fn, meta);
      const id = STEP_OF_LOG[stepName] ?? current;
      const acc = perStep.get(id);
      if (acc) { acc.cost += r.cost ?? 0; acc.calls += 1; }
      totalCost += r.cost ?? 0;
      if (stepName === "video") {
        veoDone += 1;
        onEvent({ type: "progress", id: "video", done: veoDone, total: veoTotal });
      }
      onEvent({ type: "cost", id, cost: acc?.cost ?? 0, total: totalCost });
      return r;
    },
  };
  replaceStore(deps, store);

  const restore = captureConsole((level, text) => onEvent({ type: "log", level, text, step: current }));

  const check = () => { if (shouldCancel()) throw new CancelledError(); };

  /** 1 工程を実行して開始・終了イベントを出す。 */
  const step = async (id, fn) => {
    check();
    current = id;
    const ts = Date.now();
    onEvent({ type: "step", id, status: "running" });
    try {
      const r = await fn();
      const sec = (Date.now() - ts) / 1000;
      const acc = perStep.get(id);
      acc.sec = sec;
      onEvent({
        type: "step", id,
        status: r?.skipped ? "skipped" : "done",
        sec, cost: acc.cost, detail: r?.detail ?? "",
      });
      return r;
    } catch (e) {
      const sec = (Date.now() - ts) / 1000;
      perStep.get(id).sec = sec;
      if (e instanceof CancelledError) {
        onEvent({ type: "step", id, status: "cancelled", sec, cost: perStep.get(id).cost });
      } else {
        onEvent({ type: "step", id, status: "failed", sec, cost: perStep.get(id).cost, detail: String(e?.message ?? e) });
      }
      throw e;
    }
  };

  onEvent({ type: "start", job, style, mock, root: ROOT });

  try {
    // ① 台本（＋ ①' 演出。通常は script が演出まで出すのでスキップされる）
    await step("script", async () => {
      await generateScript(deps.script, episode, job, { style });
      if (isEnriched(store.readScript(job))) console.log("[enrich] skip (台本が既に演出情報を持っています)");
      else await enrichScript(deps.script, job);
      const data = store.readScript(job);
      veoTotal = data.scenes.length;
      onEvent({ type: "progress", id: "video", done: 0, total: veoTotal });
      onEvent({ type: "script", title: data.title, tagline: data.tagline, scenes: data.scenes.length });
      return { detail: `${data.title} / ${data.scenes.length} シーン` };
    });

    // ⓪ 基準画像（assets/refs/。不足分だけ生成し、ジョブ横断で使い回す）
    await step("refs", async () => {
      const need = deps.refs.refsNeededForScript(store.readScript(job));
      const r = await prepareRefs(deps.refsUseCase, { ...need, force: false });
      const made = r.results.filter((x) => !x.skipped).length;
      return { skipped: made === 0, detail: made ? `${made} 枚を生成` : "既存を再利用" };
    });

    // ② 画像 ‖ ③' ナレ + ④ BGM + ⑥ 効果音（runPipeline と同じ並列グループ）
    check();
    const pImages = step("images", async () => {
      const r = await generateImages(deps.image, job, { force });
      const made = r.results.filter((x) => !x.skipped).length;
      return { detail: `${made} 枚を生成 / ${r.results.length - made} 枚スキップ` };
    });
    const pAudio = step("audio", async () => {
      const [, bgm] = await Promise.all([
        generateNarration(deps.speech, job, { force }),
        prepareBgm(deps.bgm, job, { force }),
        prepareSfx(deps.sfx, {}),
      ]);
      return { detail: `BGM: ${bgm?.source ?? "?"}` };
    });
    const settled = await Promise.allSettled([pImages, pAudio]);
    const bad = settled.find((s) => s.status === "rejected");
    if (bad) throw bad.reason;

    // ③ 動画（Veo）: 起点画像と確定した尺の両方に依存するので並列グループの後
    await step("video", async () => {
      if (stills) return { skipped: true, detail: "--stills（静止画 Ken Burns）" };
      const r = await generateVideos(deps.video, job, { force, stills });
      return { detail: `動画 ${r?.videoCount ?? 0} / 静止画 ${r?.stillCount ?? 0}` };
    });

    // ⑤ 合成（尺が変わっている可能性があるので常に作り直す）
    const out = path.join(ROOT, "out", job, "trailer.mp4");
    await step("render", async () => {
      await renderTrailer(deps.render, job, { force: true });
      return { detail: path.relative(ROOT, out).replace(/\\/g, "/") };
    });

    const info = await deps.media.probeSummary(out).catch(() => null);
    const v = info?.streams?.find((s) => s.codec_type === "video") ?? {};
    const wall = (Date.now() - t0) / 1000;
    onEvent({
      type: "done",
      job, file: out, wall, totalCost, mock,
      summary: info
        ? `${v.width}x${v.height} / ${Number(info.format.duration).toFixed(2)}s / ` +
          `${(Number(info.format.size) / 1024 / 1024).toFixed(1)}MB`
        : "",
    });
    return { job, file: out, wall, totalCost };
  } catch (e) {
    const cancelled = e instanceof CancelledError;
    onEvent({
      type: cancelled ? "cancelled" : "error",
      job,
      message: String(e?.message ?? e),
      wall: (Date.now() - t0) / 1000,
      totalCost,
    });
    throw e;
  } finally {
    restore();
  }
}
