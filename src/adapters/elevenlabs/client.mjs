// ElevenLabs API の共通クライアント（効果音・BGM）。
// キーが無い場合は available() が false を返し、usecase 側が ffmpeg 合成音にフォールバックする。
//
// 注意（2026-08-30 実機確認）: 発行されたキーは制限付きで /v1/user/subscription が
// missing_permissions を返すことがある。**残クレジットの確認 API に依存しないこと**。
const BASE = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";

export const apiKey = () => process.env.ELEVENLABS_API_KEY ?? "";
export const available = () => Boolean(apiKey());

/** レスポンスヘッダから課金に関わるものだけ拾う（実消費クレジットの記録用）。 */
export function costHeaders(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) {
    if (/cost|credit|character|quota|usage/i.test(k)) out[k] = v;
  }
  return out;
}

/**
 * JSON を POST して音声バイナリを受け取る。
 * エラー時は本文 JSON の detail.message を含めて throw する。
 * @returns {Promise<{buffer: Buffer, headers: object, contentType: string}>}
 */
export async function postAudio(path, body, { label = "elevenlabs" } = {}) {
  if (!available()) throw new Error("ELEVENLABS_API_KEY が未設定です");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      detail = j?.detail?.message ?? j?.detail?.status ?? j?.message ?? detail;
    } catch {
      /* JSON でなければ本文の先頭をそのまま出す */
    }
    throw new Error(`${label} 失敗 (${res.status}): ${detail}`);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    headers: costHeaders(res),
    contentType: res.headers.get("content-type") ?? "",
  };
}
