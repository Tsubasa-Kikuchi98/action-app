// ③ ナレーション & セリフ: script.json → out/<job>/nar/sN.wav ・ out/<job>/dlg/sN.wav
// 使い方: node scripts/narration.mjs <job> [--force]
//
// - ナレーション: gpt-4o-mini-tts（既定 voice cedar / wav）。instructions は openai.fm 公式形式
//   （`ラベル:` ＋ 空行区切り）の共通ブロック ＋ scene_type 別ブロックで組む（quality-research §C）。
// - セリフ（dialogue）: ナレとは**別の声**で生成する。「現場で切迫して発する一言」の演技指示。
// - ffprobe で実尺を測り nar_sec / dlg_sec を書き戻す。シーン尺 duration_sec も従来どおり補正する
//   （Veo の 4/6/8 秒制約に合わせた丸め。render の表示尺は render 側が nar_sec から再計算する）。
import fs from "node:fs";
import path from "node:path";
import {
  getOpenAI, MODELS, ensureDirs, readScript, writeScript,
  timed, withRetry, probeDuration, ffmpeg, fmtUSD, isMain,
} from "./lib.mjs";
import { enrichedView } from "./enrich.mjs";

// gpt-4o-mini-tts は前後に 0.2〜1.0 秒の無音を付けてくる。
// 「……」で作った**文中の間は残したまま**、前後だけ削って尺の無駄を消す
// （尺が縮む＝カットランプに使える時間が増える）。
const SILENCE_DB = process.env.TTS_TRIM_DB ?? "-45dB";
const TRIM_FILTER =
  `silenceremove=start_periods=1:start_duration=0:start_threshold=${SILENCE_DB}:detection=peak,` +
  `areverse,` +
  `silenceremove=start_periods=1:start_duration=0:start_threshold=${SILENCE_DB}:detection=peak,` +
  `areverse,apad=pad_dur=0.08`;

/** wav の前後の無音を落として上書きする。 */
async function trimSilence(file) {
  if ((process.env.TTS_TRIM ?? "on").toLowerCase() === "off") return;
  const tmp = file.replace(/\.wav$/i, ".trim.wav");
  await ffmpeg(["-i", file, "-af", TRIM_FILTER, "-c:a", "pcm_s16le", tmp]);
  if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) fs.renameSync(tmp, file);
  else if (fs.existsSync(tmp)) fs.rmSync(tmp);
}

// ---------------------------------------------------------------- 演技指示
// openai.fm の公式プリセットはすべて「ラベル: 内容」を空行で区切る形式。
// 共通ブロック（全シーン同一）— 映画予告ナレーターの声そのものを定義する。
export const NARRATION_COMMON = `Voice Affect: Deep, resonant and gravelly; a seasoned movie-trailer narrator with a heavy chest voice that sits low in the room.

Tone: Dark, ominous and monumental. Absolutely serious — never cheerful, never conversational.

Pronunciation: Low in the register. Consonants land hard and clean; vowels are held and full-bodied.

Punctuation: Ellipses (……) mark deliberate silence — hold them fully before continuing. A period is a hard, complete stop, not a comma.`;

// scene_type 別ブロック（quality-research §C の案）。囁き → 加速 → 張る の緩急を作る。
export const NARRATION_BY_TYPE = {
  cold_open: `Pacing: Very slow and restrained. Let the first words hang in the air.

Emotion: Cold stillness before anything has gone wrong. Almost a whisper, but never weak.

Emphasis: Lean on the time and the place. Everything else stays flat and quiet.`,
  setup: `Pacing: Slow, with a forward lean. Each phrase pulls slightly ahead of the last.

Emotion: Dawning unease. Something is beginning to move.

Emphasis: Push on the turn word — the moment the situation changes.`,
  turn: `Pacing: Tightening and clipped. Minimal pauses; do not let the line breathe.

Emotion: Contained alarm held just under the surface. Pressure, not panic.

Emphasis: Hit the threat itself hard, then cut the line short.`,
  montage: `Pacing: Slow and immovable, but dense — every syllable carries weight.

Emotion: Steel-hard resolve. The counter-attack has begun.

Emphasis: Drive through the verb of action and land on it.`,
  resolve: `Pacing: Extremely slow and monumental. Leave a long silence before the final words.

Emotion: Exhausted gravity with one last spark of defiance. Do not sound relieved — nothing is finished.

Emphasis: Let the final phrase drop to the bottom of the register and stop dead.`,
};

/** シーンに与える instructions を組み立てる。 */
export function narrationInstructions(sceneType) {
  const extra = NARRATION_BY_TYPE[sceneType] ?? NARRATION_BY_TYPE.setup;
  return `${NARRATION_COMMON}\n\n${extra}`;
}

/** セリフの演技指示。scene_type で強度を変える。 */
export function dialogueInstructions(sceneType) {
  const intensity =
    {
      turn: `Emotion: Urgent and clipped — a warning thrown across a room. Volume is raised but controlled.`,
      montage: `Emotion: Shouted over noise. Hard, commanding, no hesitation.`,
      resolve: `Emotion: Low and spent, close to the microphone. Nearly a whisper, but absolutely certain.`,
    }[sceneType] ?? `Emotion: Urgent and clipped, thrown across a room.`;
  return `Voice Affect: A character inside the scene, not a narrator. Real, unpolished, caught mid-action.

Tone: Direct address to another person who is right there. Never announce, never perform.

Pacing: Fast. One breath, one line, then stop.

${intensity}

Pronunciation: Natural spoken Japanese, slightly rough at the edges.

Punctuation: End hard. No trailing softness.`;
}

/** speaker → TTS voice。ナレーション voice とは必ず別の声にする。 */
export const SPEAKER_VOICES = {
  male_young: ["ash", "onyx"],
  male_mature: ["onyx", "ash"],
  female_young: ["nova", "shimmer"],
  female_mature: ["shimmer", "nova"],
  none: ["ash", "onyx"],
};

export function dialogueVoice(speaker, narVoice) {
  const cands = SPEAKER_VOICES[speaker] ?? SPEAKER_VOICES.none;
  return cands.find((v) => v !== narVoice) ?? "ash";
}

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

/** 1 本 TTS を生成してファイルに書く。 */
async function tts(job, { file, text, voice, instructions, step, meta }) {
  const openai = getOpenAI();
  return timed(
    job,
    step,
    async () => {
      const res = await withRetry(
        () =>
          openai.audio.speech.create({
            model: MODELS.tts,
            voice,
            input: text,
            instructions,
            // quality-research §5: speed は公式見解が矛盾。1.0 に戻し速度は Pacing: で制御する。
            speed: Number(process.env.TTS_SPEED ?? 1.0),
            response_format: "wav",
          }),
        { label: step }
      );
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      await trimSilence(file);
      // TTS は usage が返らないので、課金は「生成した音声の実尺 × 単価/分」で見積もる
      return {
        result: buf,
        usage: { audio_sec: Number((await probeDuration(file)).toFixed(2)), chars: text.length },
        model: MODELS.tts,
      };
    },
    meta
  );
}

export async function generateNarration(job, { force = false } = {}) {
  const p = ensureDirs(job, "nar", "dlg");
  const raw = readScript(job);
  const view = enrichedView(raw);
  const data = raw; // 書き戻す先は元データ（拡張フィールドを壊さない）
  const voice = process.env.TTS_VOICE ?? "cedar";
  const round = roundingEnabled();
  const speed = Number(process.env.TTS_SPEED ?? 1.0);

  const dlgCount = view.scenes.filter((s) => s.dialogue).length;
  console.log(
    `[narration] ${MODELS.tts} / nar voice=${voice} / speed=${speed} / wav / ` +
      `ナレ ${data.scenes.length}件 + セリフ ${dlgCount}件 / ` +
      `尺の丸め: ${round ? VEO_STEPS.join("/") + "s" : "off（連続値）"}`
  );

  let cost = 0;
  for (const [i, scene] of data.scenes.entries()) {
    const n = i + 1;
    const v = view.scenes[i];
    const file = path.join(p.nar, `s${n}.wav`);

    // --- ナレーション -----------------------------------------------------
    if (force || !fs.existsSync(file) || fs.statSync(file).size === 0) {
      const r = await tts(job, {
        file,
        text: scene.narration,
        voice,
        instructions: narrationInstructions(v.scene_type),
        step: "tts",
        meta: { scene: n, kind: "narration", scene_type: v.scene_type },
      });
      cost += r.cost;
    } else {
      console.log(`  s${n}: skip (既存)`);
    }

    const narSec = await probeDuration(file);
    scene.nar_sec = Number(narSec.toFixed(2));
    const before = scene.base_sec ?? scene.duration_sec;
    scene.base_sec = before;
    const need = Math.max(before, narSec + TAIL_PAD);
    scene.duration_sec = round ? roundSceneSec(need) : Number(need.toFixed(2));
    const mark = scene.duration_sec !== before ? ` → ${scene.duration_sec}s に補正` : "";
    console.log(`  s${n}: [${v.scene_type}] nar ${narSec.toFixed(2)}s / scene ${before}s${mark}`);

    // --- セリフ -----------------------------------------------------------
    const dlgFile = path.join(p.dlg, `s${n}.wav`);
    if (v.dialogue) {
      const dv = dialogueVoice(v.speaker, voice);
      if (force || !fs.existsSync(dlgFile) || fs.statSync(dlgFile).size === 0) {
        const r = await tts(job, {
          file: dlgFile,
          text: v.dialogue,
          voice: dv,
          instructions: dialogueInstructions(v.scene_type),
          step: "tts-dialogue",
          meta: { scene: n, kind: "dialogue", voice: dv, speaker: v.speaker },
        });
        cost += r.cost;
      }
      scene.dlg_sec = Number((await probeDuration(dlgFile)).toFixed(2));
      console.log(`      セリフ「${v.dialogue}」 voice=${dv} ${scene.dlg_sec}s`);
    } else {
      delete scene.dlg_sec;
      // 台本からセリフが消えた場合は古い wav を残さない（render が拾ってしまうため）
      if (fs.existsSync(dlgFile)) fs.rmSync(dlgFile);
    }
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
