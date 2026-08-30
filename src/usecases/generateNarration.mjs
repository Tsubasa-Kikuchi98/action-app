// ③ ナレーション & セリフ: script.json → out/<job>/nar/sN.wav ・ out/<job>/dlg/sN.wav ・ dlg/button.wav
//
// - ナレーション: gpt-4o-mini-tts（既定 voice cedar / wav）。instructions は openai.fm 公式形式
//   （`ラベル:` ＋ 空行区切り）の共通ブロック ＋ scene_type 別ブロックで組む（quality-research §C）。
// - セリフ（dialogue）: ナレとは**別の声**で生成する。「現場で切迫して発する一言」の演技指示。
// - ffprobe で実尺を測り nar_sec / dlg_sec を書き戻す。シーン尺 duration_sec も従来どおり補正する
//   （Veo の 4/6/8 秒制約に合わせた丸め。render の表示尺は render 側が nar_sec から再計算する）。
import path from "node:path";
import { enrichedView } from "../domain/script/index.mjs";
import { VEO_STEPS, TAIL_PAD, roundSceneSec, roundingEnabled } from "../domain/script/rounding.mjs";
import {
  narrationInstructions, dialogueInstructions, buttonInstructions, dialogueVoice,
} from "../domain/prompts/ttsInstructions.mjs";
import { fmtUSD } from "../domain/pricing.mjs";

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
async function trimSilence(media, files, file) {
  if ((process.env.TTS_TRIM ?? "on").toLowerCase() === "off") return;
  const tmp = file.replace(/\.wav$/i, ".trim.wav");
  await media.ffmpeg(["-i", file, "-af", TRIM_FILTER, "-c:a", "pcm_s16le", tmp]);
  if (files.exists(tmp) && files.size(tmp) > 1024) files.rename(tmp, file);
  else if (files.exists(tmp)) files.remove(tmp);
}

/** 1 本 TTS を生成してファイルに書く。 */
async function tts(deps, job, { file, text, voice, instructions, step, meta }) {
  const { speech, store, media, files, model } = deps;
  return store.timed(
    job,
    step,
    async () => {
      const buf = await speech.speak({
        model,
        voice,
        text,
        instructions,
        speed: Number(process.env.TTS_SPEED ?? 1.25),
        label: step,
      });
      files.write(file, buf);
      await trimSilence(media, files, file);
      // TTS は usage が返らないので、課金は「生成した音声の実尺 × 単価/分」で見積もる
      return {
        result: buf,
        usage: { audio_sec: Number((await media.probeDuration(file)).toFixed(2)), chars: text.length },
        model,
      };
    },
    meta
  );
}

/**
 * @param {object} deps { speech, store, media, model }
 */
export async function generateNarration(deps, job, { force = false } = {}) {
  const { store, media, files, model } = deps;
  const p = store.ensureDirs(job, "nar", "dlg");
  const raw = store.readScript(job);
  const view = enrichedView(raw);
  const data = raw; // 書き戻す先は元データ（拡張フィールドを壊さない）
  const voice = process.env.TTS_VOICE ?? "cedar";
  const round = roundingEnabled();
  const speed = Number(process.env.TTS_SPEED ?? 1.25);

  // nolan はナレーションが無く、セリフは Veo が口パク付きで喋る（TTS では作らない）。
  // 尺も台本の 3 / 4 / 3 秒をそのまま使うので、4/6/8 への丸めも行わない。
  if (view.style === "nolan") {
    console.log("[narration] style=nolan: ナレーションもセリフも TTS では作りません（声は Veo クリップの中）");
    for (const [i, scene] of data.scenes.entries()) {
      const n = i + 1;
      scene.nar_sec = 0;
      scene.base_sec = scene.base_sec ?? scene.duration_sec ?? 3;
      delete scene.dlg_sec;
      for (const f of [path.join(p.nar, `s${n}.wav`), path.join(p.dlg, `s${n}.wav`)]) {
        if (files.exists(f)) files.remove(f);
      }
      console.log(`  s${n}: [${view.scenes[i].scene_type}] セリフ「${view.scenes[i].dialogue || "(なし)"}」→ Veo / scene ${scene.duration_sec}s`);
    }
    delete data.button_sec;
    const btn = path.join(p.dlg, "button.wav");
    if (files.exists(btn)) files.remove(btn);
    store.writeScript(job, data);
    const t = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
    console.log(`[narration] 合計シーン尺 ${t.toFixed(1)}s / 推定 $0.0000（API 未使用）`);
    return { data, cost: 0 };
  }

  const dlgCount = view.scenes.filter((s) => s.dialogue).length;
  console.log(
    `[narration] ${model} / nar voice=${voice} / speed=${speed} / wav / ` +
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
      if (files.exists(file)) files.remove(file);
      console.log(`  s${n}: [${v.scene_type}] ナレなし → scene ${scene.duration_sec}s`);
    } else {
      if (force || !files.ready(file)) {
        const r = await tts(deps, job, {
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

      const narSec = await media.probeDuration(file);
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
      if (force || !files.ready(dlgFile)) {
        const r = await tts(deps, job, {
          file: dlgFile,
          text: v.dialogue,
          voice: dv,
          instructions: dialogueInstructions(v.scene_type),
          step: "tts-dialogue",
          meta: { scene: n, kind: "dialogue", voice: dv, speaker: v.speaker },
        });
        cost += r.cost;
      }
      scene.dlg_sec = Number((await media.probeDuration(dlgFile)).toFixed(2));
      console.log(`      セリフ「${v.dialogue}」 voice=${dv} ${scene.dlg_sec}s`);
    } else {
      delete scene.dlg_sec;
      // 台本からセリフが消えた場合は古い wav を残さない（render が拾ってしまうため）
      if (files.exists(dlgFile)) files.remove(dlgFile);
    }
  }

  // --- button_line（タイトル後の落ち）-------------------------------------
  // シーンには属さないので dlg/button.wav に置く。render がタイトルカードの後に鳴らす。
  const btnFile = path.join(p.dlg, "button.wav");
  if (view.button_line) {
    const bv = dialogueVoice("male_mature", voice);
    if (force || !files.ready(btnFile)) {
      const r = await tts(deps, job, {
        file: btnFile,
        text: view.button_line,
        voice: bv,
        instructions: buttonInstructions(),
        step: "tts-button",
        meta: { kind: "button", voice: bv },
      });
      cost += r.cost;
    }
    data.button_sec = Number((await media.probeDuration(btnFile)).toFixed(2));
    console.log(`  button「${view.button_line}」 voice=${bv} ${data.button_sec}s`);
  } else {
    delete data.button_sec;
    if (files.exists(btnFile)) files.remove(btnFile);
  }

  store.writeScript(job, data);
  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`[narration] 合計シーン尺 ${total.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, cost };
}
