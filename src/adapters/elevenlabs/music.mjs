// BGM 生成（ElevenLabs Music API）。
//   POST /v1/music  { prompt, music_length_ms, model_id, force_instrumental }
// レスポンスは mp3 バイナリ。
import { available, postAudio } from "./client.mjs";

/** MusicGenerator ポートの実装。 */
export const musicGenerator = {
  available,

  /**
   * @param {{prompt: string, lengthMs?: number, modelId?: string, label?: string}} args
   * @returns {Promise<{buffer: Buffer, headers: object, ext: string, model: string}>}
   */
  async generate({ prompt, lengthMs = 20000, modelId = "music_v2", label = "bgm" }) {
    const body = {
      prompt,
      music_length_ms: Math.round(lengthMs),
      model_id: modelId,
      force_instrumental: true,
      output_format: process.env.ELEVENLABS_MUSIC_FORMAT ?? "mp3_44100_128",
    };
    const r = await postAudio("/v1/music", body, { label: `ElevenLabs Music(${label})` });
    return { ...r, ext: "mp3", model: modelId };
  },
};
