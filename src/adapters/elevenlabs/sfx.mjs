// 効果音生成（ElevenLabs Sound Generation API）。
//   POST /v1/sound-generation  { text, duration_seconds, prompt_influence }
// レスポンスは mp3 バイナリ。
import { available, postAudio } from "./client.mjs";

/** SoundGenerator ポートの実装。 */
export const soundGenerator = {
  available,

  /**
   * @param {{text: string, durationSec?: number, promptInfluence?: number, label?: string}} args
   * @returns {Promise<{buffer: Buffer, headers: object, ext: string}>}
   */
  async generate({ text, durationSec = 1.2, promptInfluence = 0.6, label = "sfx" }) {
    const body = {
      text,
      duration_seconds: Number(durationSec.toFixed(2)),
      prompt_influence: promptInfluence,
      output_format: process.env.ELEVENLABS_SFX_FORMAT ?? "mp3_44100_128",
    };
    const r = await postAudio("/v1/sound-generation", body, { label: `ElevenLabs SFX(${label})` });
    return { ...r, ext: "mp3" };
  },
};
