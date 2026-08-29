// ③ ナレーション: script.json の narration → out/<job>/nar/s1..s6.wav
// 使い方: node scripts/narration.mjs <job> [--force]
//
// gpt-4o-mini-tts（voice: cedar / wav）で生成し、ffprobe で実尺を測って
// scenes[i].duration_sec = max(duration_sec, nar_sec + 0.6) に補正して書き戻す。
import fs from "node:fs";
import path from "node:path";
import {
  getOpenAI, MODELS, ensureDirs, readScript, writeScript,
  timed, withRetry, probeDuration, fmtUSD, isMain,
} from "./lib.mjs";

// 映画予告ナレーターの演技指示。
export const TTS_INSTRUCTIONS = `ハリウッド映画の予告編ナレーター。
声色: 低く重厚なバリトン。胸で響かせ、力強く張る。
話速: やや速め。テンポよく畳みかけ、間延びさせない。1文を一気に言い切る。
間: 句読点と「…」で短く一拍だけ。文末は力強く言い切って落とす。
感情: 高揚感と緊迫感。抑揚を大きく、盛り上がりに向けて熱量を上げる。`;

// ナレ後の余白（秒）。シーン尺はこの分だけナレより長くする。
const TAIL_PAD = 0.6;

// Phase 2: Veo が受け付ける尺は 4 / 6 / 8 秒のみ。ナレ実尺 + TAIL_PAD をこの中に丸め上げる。
// SCENE_ROUND=off で Phase 1 相当の連続値に戻す（--stills 運用など）。
export const VEO_STEPS = [4, 6, 8];
const roundingEnabled = () => (process.env.SCENE_ROUND ?? "on").toLowerCase() !== "off";

/** sec 以上で最小の許容尺を返す（超過分は最大値でクランプ）。 */
export function roundSceneSec(sec) {
  const max = Number(process.env.VEO_MAX_SEC ?? VEO_STEPS[VEO_STEPS.length - 1]);
  const steps = VEO_STEPS.filter((v) => v <= max);
  return steps.find((v) => v >= sec - 1e-6) ?? steps[steps.length - 1];
}

export async function generateNarration(job, { force = false } = {}) {
  const openai = getOpenAI();
  const p = ensureDirs(job, "nar");
  const data = readScript(job);
  const voice = process.env.TTS_VOICE ?? "cedar";
  const round = roundingEnabled();

  console.log(
    `[narration] ${MODELS.tts} / voice=${voice} / wav / ${data.scenes.length}件 / ` +
      `尺の丸め: ${round ? VEO_STEPS.join("/") + "s" : "off（連続値）"}`
  );

  let cost = 0;
  for (const [i, scene] of data.scenes.entries()) {
    const n = i + 1;
    const file = path.join(p.nar, `s${n}.wav`);

    if (force || !fs.existsSync(file) || fs.statSync(file).size === 0) {
      const r = await timed(
        job,
        "tts",
        async () => {
          const res = await withRetry(
            () =>
              openai.audio.speech.create({
                model: MODELS.tts,
                voice,
                input: scene.narration,
                instructions: TTS_INSTRUCTIONS,
                speed: Number(process.env.TTS_SPEED ?? 1.15),
                response_format: "wav",
              }),
            { label: `tts s${n}` }
          );
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(file, buf);
          // TTS は usage が返らないので入力文字数からトークンを概算する
          return {
            result: buf,
            usage: { input_tokens: Math.ceil(scene.narration.length / 2), chars: scene.narration.length },
            model: MODELS.tts,
          };
        },
        { scene: n }
      );
      cost += r.cost;
    } else {
      console.log(`  s${n}: skip (既存)`);
    }

    // 実尺を測ってシーン尺を補正
    const narSec = await probeDuration(file);
    scene.nar_sec = Number(narSec.toFixed(2));
    // 台本の元尺を base_sec に保持（再実行時にナレが短くなったら尺も縮められるように）
    const before = scene.base_sec ?? scene.duration_sec;
    scene.base_sec = before;
    const need = Math.max(before, narSec + TAIL_PAD);
    scene.duration_sec = round ? roundSceneSec(need) : Number(need.toFixed(2));
    const mark = scene.duration_sec !== before ? ` → ${scene.duration_sec}s に補正` : "";
    console.log(`  s${n}: nar ${narSec.toFixed(2)}s / scene ${before}s${mark}`);
  }

  writeScript(job, data);
  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`[narration] 合計シーン尺 ${total.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, cost };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await generateNarration(job, { force });
}
