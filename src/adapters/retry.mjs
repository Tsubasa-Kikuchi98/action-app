// API 呼び出しの共通ユーティリティ（adapters 共通）。
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
