// ⓪ 基準画像（リファレンス）の生成・管理
// 使い方:
//   node scripts/refs.mjs --chars                     全キャラのキャラクターシート
//   node scripts/refs.mjs --chars=hero,boss           一部だけ
//   node scripts/refs.mjs --locs office,meeting       指定ロケの基準プレート
//   node scripts/refs.mjs --locs all                  全ロケ
//   node scripts/refs.mjs --job lambda                その台本が必要とする分だけ
//   共通フラグ: --force（既存を作り直す） --dry-run（プロンプトだけ表示）
//
// なぜ必要か:
//   シーン画像は 5 枚を並列生成するので、そのままだと同じ「主人公」でも顔・服が毎回変わり、
//   同じ「オフィス」でも部屋が別物になる。先に**ジョブ横断で使い回す基準画像**を作り、
//   images.mjs が images/edits に参照として毎回添付することで見た目を揃える。
//
// 出力先は out/<job>/ ではなく assets/refs/（git 管理外・全ジョブ共通）。
//   assets/refs/char_hero.png   … 同一人物の「正面バストアップ／斜め 45 度／全身」を 1 枚に横並び
//   assets/refs/loc_office.png  … 人物なしのロケーション基準プレート
// usage / コストは out/_refs/log.jsonl に追記する。
import fs from "node:fs";
import path from "node:path";
import { CAST, LOCATIONS, LOCATION_KEYS, enrichedView } from "./enrich.mjs";
import {
  ROOT, getOpenAI, MODELS, readScript, timed, withRetry, fmtUSD, isMain,
} from "./lib.mjs";

/** 基準画像の置き場（ジョブ横断で再利用するので out/ ではなく assets/ に置く）。 */
export const REFS_DIR = path.join(ROOT, "assets", "refs");

/** 基準画像は「顔が再現できること」が全てなので、開発中でも medium を既定にする。 */
export const REFS_QUALITY = process.env.REFS_QUALITY ?? "medium";
export const REFS_SIZE = process.env.REFS_SIZE ?? "1536x1024";

/** 基準画像を記録するログ用の疑似ジョブ名（out/_refs/log.jsonl）。 */
const REFS_JOB = "_refs";

export const charRefPath = (key) => path.join(REFS_DIR, `char_${key}.png`);
export const locRefPath = (key) => path.join(REFS_DIR, `loc_${key}.png`);

const exists = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
export const hasCharRef = (key) => exists(charRefPath(key));
export const hasLocRef = (key) => exists(locRefPath(key));

// ---------------------------------------------------------------- プロンプト
// 文字を描かせないこと・人物を入れないことは gpt-image-2 が破りがちなので、
// 肯定形（plain clean backdrop / an empty room）と否定形の両方を書く。
const NO_TEXT =
  "clean unmarked surfaces, no text, no letters, no numbers, no captions, no labels, no logos, no watermark, no borders, no frame";

/** キャラクターシート（同一人物の 3 ビューを 1 枚に）。 */
export function buildCharPrompt(key) {
  const c = CAST[key];
  if (!c) throw new Error(`未知のキャラクター: ${key}（${Object.keys(CAST).join(" / ")}）`);
  return [
    "A character reference sheet for a film production, laid out as one wide image with three views side by side, left to right:",
    "(1) a front-facing bust portrait, (2) a three-quarter 45-degree bust portrait, (3) a full-body standing shot.",
    "It is the same person in three views: identical face, identical hairstyle, identical clothing and identical build in all three views.",
    `Subject: ${c.en}.`,
    "Photorealistic contemporary Japan, sharp focus, neutral colour, flat even studio lighting from the front, a plain smooth medium-grey backdrop behind the whole frame, neutral relaxed expression, arms at the sides, empty backdrop with no props and no furniture.",
    NO_TEXT + ".",
  ].join(" ");
}

/** ロケーションの基準プレート（人物なしのワイド）。 */
export function buildLocPrompt(key) {
  const l = LOCATIONS[key];
  if (!l) throw new Error(`未知のロケーション: ${key}（${LOCATION_KEYS.join(" / ")}）`);
  return [
    `A location reference plate for a film production: a wide establishing shot of ${l.en}.`,
    "The room is empty of people; not a single person is visible anywhere in the frame.",
    "Photorealistic, cinematic, wide-angle, eye-level, the whole room readable in one frame, anamorphic lens, film grain,",
    "and this is the master plate: the lighting direction, colour temperature, furniture and props here define how this place looks in every later shot.",
    NO_TEXT + ".",
  ].join(" ");
}

// ---------------------------------------------------------------- 生成
async function generateRef({ kind, key, file, prompt, force }) {
  if (!force && exists(file)) {
    console.log(`  ${kind}:${key} skip (既存 ${path.basename(file)})`);
    return { kind, key, file, skipped: true, cost: 0 };
  }
  const openai = getOpenAI();
  const { result, sec, cost } = await timed(
    REFS_JOB,
    `ref_${kind}`,
    async () => {
      const res = await withRetry(
        () =>
          openai.images.generate({
            model: MODELS.image,
            prompt,
            size: REFS_SIZE,
            quality: REFS_QUALITY,
            n: 1,
          }),
        { label: `ref ${kind}:${key}` }
      );
      return {
        result: res,
        usage: { ...(res.usage ?? {}), images: 1, quality: REFS_QUALITY },
        model: MODELS.image,
      };
    },
    { kind, key }
  );

  const item = result.data?.[0];
  if (!item) throw new Error(`${kind}:${key} 画像が返りませんでした`);
  const buf = item.b64_json
    ? Buffer.from(item.b64_json, "base64")
    : Buffer.from(await (await fetch(item.url)).arrayBuffer());
  fs.mkdirSync(REFS_DIR, { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`  ${kind}:${key} → ${file} (${(buf.length / 1024).toFixed(0)}KB, ${sec.toFixed(1)}s, ${fmtUSD(cost)})`);
  return { kind, key, file, skipped: false, cost, sec };
}

/**
 * 不足している基準画像だけを生成する。
 * @param {{chars?: string[], locs?: string[], force?: boolean, dryRun?: boolean}} opts
 */
export async function ensureRefs({ chars = [], locs = [], force = false, dryRun = false } = {}) {
  const charKeys = chars.filter((k) => CAST[k]);
  const locKeys = locs.filter((k) => LOCATIONS[k]);
  const jobs = [
    ...charKeys.map((k) => ({ kind: "char", key: k, file: charRefPath(k), prompt: buildCharPrompt(k) })),
    ...locKeys.map((k) => ({ kind: "loc", key: k, file: locRefPath(k), prompt: buildLocPrompt(k) })),
  ];

  if (dryRun) {
    for (const j of jobs) {
      console.log(`\n--- ${j.kind}:${j.key} → ${path.relative(ROOT, j.file)} ---`);
      console.log(j.prompt);
    }
    console.log(`\n[refs --dry-run] ${jobs.length}枚 / ${MODELS.image} / ${REFS_SIZE} / ${REFS_QUALITY}（API は呼んでいません）`);
    return { results: [], cost: 0, dryRun: true };
  }

  if (!jobs.length) {
    console.log("[refs] 生成対象がありません（--chars / --locs / --job を指定してください）");
    return { results: [], cost: 0 };
  }

  const todo = jobs.filter((j) => force || !exists(j.file));
  console.log(
    `[refs] ${MODELS.image} / ${REFS_SIZE} / ${REFS_QUALITY} / ` +
      `キャラ ${charKeys.length} + ロケ ${locKeys.length} 中 ${todo.length}枚を生成`
  );

  // 参照画像は枚数が少ないので全部並列で問題ない（Tier1 は 5枚/分）。
  const results = await Promise.all(jobs.map((j) => generateRef({ ...j, force })));
  const cost = results.reduce((a, r) => a + r.cost, 0);
  const made = results.filter((r) => !r.skipped).length;
  console.log(`[refs] 生成 ${made}枚 / スキップ ${results.length - made}枚 / 推定 ${fmtUSD(cost)}`);
  return { results, cost };
}

// ---------------------------------------------------------------- 台本との連携
/** 台本が必要とするキャラ／ロケのキーを重複なく集める。 */
export function refsNeededForScript(data) {
  const view = enrichedView(data);
  const chars = new Set();
  const locs = new Set();
  for (const s of view.scenes) {
    for (const c of s.characters ?? []) if (CAST[c]) chars.add(c);
    if (LOCATIONS[s.location]) locs.add(s.location);
  }
  return { chars: [...chars], locs: [...locs] };
}

/**
 * 1 シーンに添付する参照画像のパス一覧を返す（キャラ最大 3 枚 ＋ ロケ 1 枚）。
 * 存在しないものは黙って落とす（1 枚も無ければ images.mjs が generations にフォールバックする）。
 */
export function sceneRefs(scene) {
  const chars = (scene.characters ?? []).filter((k) => CAST[k]).slice(0, 3).filter(hasCharRef);
  const loc = LOCATIONS[scene.location] && hasLocRef(scene.location) ? scene.location : null;
  return {
    chars,
    loc,
    files: [...chars.map(charRefPath), ...(loc ? [locRefPath(loc)] : [])],
  };
}

// ---------------------------------------------------------------- CLI
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const value = (name) => {
    const a = flag(name);
    if (!a) return null;
    return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
  };
  const listOf = (raw, all) =>
    raw === "" || raw === "all" ? all : raw.split(",").map((s) => s.trim()).filter(Boolean);

  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  let chars = [];
  let locs = [];

  const jobRaw = value("job");
  const jobPos = args.find((a) => !a.startsWith("--"));
  const job = jobRaw || jobPos;
  if (job) {
    const need = refsNeededForScript(readScript(job));
    chars = need.chars;
    locs = need.locs;
    console.log(`[refs] job=${job} → キャラ ${chars.join(",") || "-"} / ロケ ${locs.join(",") || "-"}`);
  }
  const cRaw = value("chars");
  if (cRaw !== null) chars = [...new Set([...chars, ...listOf(cRaw, Object.keys(CAST))])];
  const lRaw = value("locs");
  if (lRaw !== null) locs = [...new Set([...locs, ...listOf(lRaw, LOCATION_KEYS)])];

  if (!chars.length && !locs.length) {
    console.error(
      "usage: node scripts/refs.mjs [--chars[=hero,senpai,boss]] [--locs=office,meeting|all] [--job <job>] [--force] [--dry-run]"
    );
    process.exit(1);
  }
  await ensureRefs({ chars, locs, force, dryRun });
}
