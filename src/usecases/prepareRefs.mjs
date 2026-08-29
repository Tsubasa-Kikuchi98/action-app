// ⓪ 基準画像（リファレンス）の生成・管理。
//
// なぜ必要か:
//   シーン画像は 5 枚を並列生成するので、そのままだと同じ「主人公」でも顔・服が毎回変わり、
//   同じ「オフィス」でも部屋が別物になる。先に**ジョブ横断で使い回す基準画像**を作り、
//   generateImages が images/edits に参照として毎回添付することで見た目を揃える。
//
// 出力先は out/<job>/ ではなく assets/refs/（git 管理外・全ジョブ共通）。
// usage / コストは out/_refs/log.jsonl に追記する。
import path from "node:path";
import { CAST, LOCATIONS, LOCATION_KEYS } from "../domain/cast.mjs";
import { buildCharPrompt, buildLocPrompt } from "../domain/prompts/refsPrompt.mjs";
import { fmtUSD } from "../domain/pricing.mjs";

async function generateRef(deps, { kind, key, file, prompt, force }) {
  const { image, store, refs, model, quality, size, root, job } = deps;
  if (!force && refs.exists(file)) {
    console.log(`  ${kind}:${key} skip (既存 ${path.basename(file)})`);
    return { kind, key, file, skipped: true, cost: 0 };
  }
  const { result, sec, cost } = await store.timed(
    job,
    `ref_${kind}`,
    async () => {
      const res = await image.generate({ model, prompt, size, quality, label: `ref ${kind}:${key}` });
      return {
        result: res,
        usage: { ...(res.usage ?? {}), images: 1, quality },
        model,
      };
    },
    { kind, key }
  );

  const buf = result.buffer;
  refs.write(file, buf);
  console.log(`  ${kind}:${key} → ${file} (${(buf.length / 1024).toFixed(0)}KB, ${sec.toFixed(1)}s, ${fmtUSD(cost)})`);
  return { kind, key, file, skipped: false, cost, sec };
}

/**
 * 不足している基準画像だけを生成する。
 * @param {object} deps { image, store, refs, model, quality, size, root, job }
 * @param {{chars?: string[], locs?: string[], force?: boolean, dryRun?: boolean}} opts
 */
export async function prepareRefs(deps, { chars = [], locs = [], force = false, dryRun = false } = {}) {
  const { refs, model, quality, size, root } = deps;
  const charKeys = chars.filter((k) => CAST[k]);
  const locKeys = locs.filter((k) => LOCATIONS[k]);
  const jobs = [
    ...charKeys.map((k) => ({ kind: "char", key: k, file: refs.charRefPath(k), prompt: buildCharPrompt(k) })),
    ...locKeys.map((k) => ({ kind: "loc", key: k, file: refs.locRefPath(k), prompt: buildLocPrompt(k) })),
  ];

  if (dryRun) {
    for (const j of jobs) {
      console.log(`\n--- ${j.kind}:${j.key} → ${path.relative(root, j.file)} ---`);
      console.log(j.prompt);
    }
    console.log(`\n[refs --dry-run] ${jobs.length}枚 / ${model} / ${size} / ${quality}（API は呼んでいません）`);
    return { results: [], cost: 0, dryRun: true };
  }

  if (!jobs.length) {
    console.log("[refs] 生成対象がありません（--chars / --locs / --job を指定してください）");
    return { results: [], cost: 0 };
  }

  const todo = jobs.filter((j) => force || !refs.exists(j.file));
  console.log(
    `[refs] ${model} / ${size} / ${quality} / ` +
      `キャラ ${charKeys.length} + ロケ ${locKeys.length} 中 ${todo.length}枚を生成`
  );

  // 参照画像は枚数が少ないので全部並列で問題ない（Tier1 は 5枚/分）。
  const results = await Promise.all(jobs.map((j) => generateRef(deps, { ...j, force })));
  const cost = results.reduce((a, r) => a + r.cost, 0);
  const made = results.filter((r) => !r.skipped).length;
  console.log(`[refs] 生成 ${made}枚 / スキップ ${results.length - made}枚 / 推定 ${fmtUSD(cost)}`);
  return { results, cost };
}

export { LOCATION_KEYS };
