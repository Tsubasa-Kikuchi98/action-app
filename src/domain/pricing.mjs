// 単価表とコスト計算（純関数）。
// 実請求額は OpenAI / Google のダッシュボードで確認すること。
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

/** モデル名と usage から推定コスト（USD）を返す。 */
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

export const fmtUSD = (n) => `$${n.toFixed(4)}`;
