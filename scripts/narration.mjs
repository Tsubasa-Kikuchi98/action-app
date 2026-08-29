// ③ ナレーション & セリフ: script.json → out/<job>/nar/sN.wav ・ out/<job>/dlg/sN.wav ・ out/<job>/dlg/button.wav
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
export const NARRATION_COMMON = `Voice Affect: A Japanese TV movie-trailer announcer — bright, forward, and high-energy. Voice placed high and forward in the mask, not down in the chest. Big projection, as if calling across a packed theater.

Tone: Excited, urgent, and larger-than-life. Every line is an announcement. Absolutely serious about the content — never mocking, never sleepy, never conversational, never monotone.

Pacing: Very fast and punchy — noticeably faster than normal speech. Attack each phrase hard and immediately. Pauses only where "……" appears, and keep them short and tense. Never drag a syllable.

Intonation: Strongly melodic and dynamic. Swing the pitch widely: leap UP on the key noun or number of each line, then drop sharply for the ending. Alternate loud and soft within a single sentence. No two consecutive phrases at the same pitch or volume. Think of a sports announcer calling a decisive play.

Pronunciation: Crisp consonants, bright vowels, clear Japanese diction. Sentence endings land hard and clean, never trailing off.

Punctuation: "……" is a short, charged breath — the pitch drops into it and springs back out of it. A period is a sharp, complete stop.`;

// scene_type 別ブロック。全体を高テンションに保ちつつ、序盤→終盤で熱量をさらに上げる。
const NARRATION_BY_TYPE = {
  cold_open: `Emphasis: Bright and inviting, like the opening of a summer blockbuster spot. Energy already high, but with a smile in the voice. Lean into the time-setting words.

Emotion: Anticipation. Something big is about to be announced.`,
  setup: `Emphasis: Snap the pivot word ("しかし") hard and lift the pitch right after it. Faster than the opening.

Emotion: Alarm breaking through the excitement — the announcer has just seen the twist.`,
  turn: `Emphasis: Hit every number and noun like a drum. Rapid-fire, almost breathless, pitch high.

Emotion: Peak intensity. This is the moment the audience must not look away from.`,
  montage: `Emphasis: Maximum drive. Ride the rhythm of the cuts — short, hammering phrases, rising pitch to the end.

Emotion: Thrill of the counter-attack. Loud, fast, exhilarated.`,
  resolve: `Emphasis: Highest energy of the whole piece, then a hard, clean stop on the last word. Pitch peaks on the final phrase.

Emotion: Cliffhanger. Nothing is resolved — sell the question, not the answer.`,
};

export function narrationInstructions(sceneType) {
  const extra = NARRATION_BY_TYPE[sceneType] ?? NARRATION_BY_TYPE.setup;
  return `${NARRATION_COMMON}\n\n${extra}`;
}

/**
 * button_line（タイトル後の落ち）の演技指示。
 * ここだけは「予告の声」を降ろして、現実に戻った素の一言にする（笑いの落差はここで作る）。
 */
export function buttonInstructions() {
  return `Voice Affect: An ordinary person in an ordinary office. No trailer voice at all — the performance drops completely.

Tone: Flat, tired, matter-of-fact. Slightly deflated. Absolutely not dramatic.

Pacing: Normal conversational speed. One short line, then stop.

Emotion: Resignation. The crisis is over and the paperwork is not.

Pronunciation: Everyday spoken Japanese, relaxed and unprojected.

Punctuation: End plainly. No emphasis, no held vowels, no reverb-worthy finish.`;
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
  hero:   ["echo", "verse"],      // 若手男性
  senpai: ["nova", "marin"],      // 30 代前半女性
  boss:   ["onyx", "ash"],        // 50 代男性
  // 旧台本互換
  male_young: ["echo", "verse"], female_young: ["nova", "marin"], female_mature: ["nova", "marin"], male_mature: ["onyx", "ash"],
  none: ["echo", "onyx"],
};

export function dialogueVoice(speaker, narVoice) {
  const cands = SPEAKER_VOICES[speaker] ?? SPEAKER_VOICES.none;
  return cands.find((v) => v !== narVoice) ?? "echo";
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
            speed: Number(process.env.TTS_SPEED ?? 1.25),
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
  const speed = Number(process.env.TTS_SPEED ?? 1.25);

  const dlgCount = view.scenes.filter((s) => s.dialogue).length;
  console.log(
    `[narration] ${MODELS.tts} / nar voice=${voice} / speed=${speed} / wav / ` +
      `ナレ ${view.scenes.filter((s) => s.narration).length}件 + セリフ ${dlgCount}件` +
      `${view.button_line ? " + button 1件" : ""} / ` +
      `尺の丸め: ${round ? VEO_STEPS.join("/") + "s" : "off（連続値）"}`
  );

  let cost = 0;
  for (const [i, scene] of data.scenes.entries()) {
    const n = i + 1;
    const v = view.scenes[i];
    const file = path.join(p.nar, `s${n}.wav`);

    // --- ナレーション -----------------------------------------------------
    // 案 B（style: "dialogue"）はナレが 2 本しかない。narration が空のシーンは
    // TTS を作らず nar_sec = 0 として、シーン尺は台本の duration_sec（既定 4）に任せる。
    if (!String(scene.narration ?? "").trim()) {
      scene.nar_sec = 0;
      scene.base_sec = scene.base_sec ?? scene.duration_sec ?? 4;
      scene.duration_sec = round ? roundSceneSec(scene.base_sec) : scene.base_sec;
      if (fs.existsSync(file)) fs.rmSync(file);
      console.log(`  s${n}: [${v.scene_type}] ナレなし → scene ${scene.duration_sec}s`);
    } else {
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
    }

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

  // --- button_line（タイトル後の落ち）-------------------------------------
  // シーンには属さないので dlg/button.wav に置く。render がタイトルカードの後に鳴らす。
  const btnFile = path.join(p.dlg, "button.wav");
  if (view.button_line) {
    const bv = dialogueVoice("male_mature", voice);
    if (force || !fs.existsSync(btnFile) || fs.statSync(btnFile).size === 0) {
      const r = await tts(job, {
        file: btnFile,
        text: view.button_line,
        voice: bv,
        instructions: buttonInstructions(),
        step: "tts-button",
        meta: { kind: "button", voice: bv },
      });
      cost += r.cost;
    }
    data.button_sec = Number((await probeDuration(btnFile)).toFixed(2));
    console.log(`  button「${view.button_line}」 voice=${bv} ${data.button_sec}s`);
  } else {
    delete data.button_sec;
    if (fs.existsSync(btnFile)) fs.rmSync(btnFile);
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
