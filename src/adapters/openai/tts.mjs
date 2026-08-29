// SpeechGenerator ポートの実装: gpt-4o-mini-tts。
import { getOpenAI } from "./client.mjs";
import { withRetry } from "../retry.mjs";

/**
 * @param {{model: string, voice: string, text: string, instructions: string, speed: number, label?: string}} req
 * @returns {Promise<Buffer>} wav のバイト列
 */
export async function speak({ model, voice, text, instructions, speed, label = "tts" }) {
  const openai = getOpenAI();
  const res = await withRetry(
    () =>
      openai.audio.speech.create({
        model,
        voice,
        input: text,
        instructions,
        // quality-research §5: speed は公式見解が矛盾。1.0 に戻し速度は Pacing: で制御する。
        speed,
        response_format: "wav",
      }),
    { label }
  );
  return Buffer.from(await res.arrayBuffer());
}

export const speechGenerator = { speak };
