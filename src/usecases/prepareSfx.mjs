// ⑥ 効果音（SFX）: assets/sfx/<name>.wav
//
// nolan のカードは「文字が出た瞬間に低音が来る」ことが命なので、ブラームを先に作って
// **ジョブ横断で使い回す**（生成のたびに音が変わると比較ができないため）。
//
// 優先順位:
//   1. 既存の assets/sfx/<name>.wav（--force で作り直す）
//   2. ELEVENLABS_API_KEY があれば Sound Generation API（mp3 → wav に変換）
//   3. キーが無い / 失敗したら ffmpeg の合成ブラーム（低音サインの減衰 ＋ ノイズのアタック）
//
// 生成した mp3 は 48kHz ステレオ wav に変換し、**頭の無音を落とす**（カード開始と同時に鳴らすため）。
import path from "node:path";
import { SFX_SPECS } from "../domain/prompts/sfxPrompts.mjs";

/** ログ用の疑似ジョブ名（out/_sfx/log.jsonl）。 */
export const SFX_JOB = "_sfx";

// 頭の無音を落として 48kHz ステレオに揃える。ブラームはアタックが立つので peak 判定でよい。
const CLEAN =
  "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak," +
  "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,alimiter=limit=0.95";

/** mp3 などを 48kHz ステレオ wav に変換しつつ頭の無音を落とす。 */
async function toWav(media, src, dst) {
  await media.ffmpeg(["-i", src, "-af", CLEAN, "-c:a", "pcm_s16le", dst]);
  return dst;
}

/** ffmpeg の合成ブラーム（低音サインの減衰 ＋ ノイズのアタック）。 */
async function synthesize(media, spec, dst) {
  const d = spec.durationSec;
  // 55Hz の基音 + 110Hz の倍音を指数減衰させ、頭に短いノイズのアタックを重ねる
  const low = `aevalsrc='0.95*sin(2*PI*55*t)*exp(-2.6*t)+0.45*sin(2*PI*110*t)*exp(-4.2*t)+0.20*sin(2*PI*82.5*t)*exp(-3.4*t)':s=48000:d=${d}`;
  const atk = `anoisesrc=color=brown:sample_rate=48000:duration=${d}:amplitude=0.9`;
  const fc = [
    `[0:a]volume=1.0[lo]`,
    `[1:a]lowpass=f=900,volume='0.8*exp(-22*t)':eval=frame[at]`,
    `[lo][at]amix=inputs=2:normalize=0:duration=longest,` +
      `afade=t=out:st=${(d - 0.15).toFixed(2)}:d=0.15,` +
      `alimiter=limit=0.95,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[a]`,
  ].join(";");
  await media.ffmpeg([
    "-f", "lavfi", "-i", low,
    "-f", "lavfi", "-i", atk,
    "-filter_complex", fc,
    "-map", "[a]", "-t", String(d),
    dst,
  ]);
  return dst;
}

/**
 * 不足している効果音だけを作る。
 * @param {object} deps { sound, store, media, files, sfxDir }
 * @param {{force?: boolean, dryRun?: boolean, names?: string[]}} opts
 */
export async function prepareSfx(deps, { force = false, dryRun = false, names = null } = {}) {
  const { sound, store, media, files, sfxDir } = deps;
  const specs = names?.length ? SFX_SPECS.filter((s) => names.includes(s.name)) : SFX_SPECS;

  if (dryRun) {
    for (const s of specs) {
      console.log(`\n--- ${s.name} (${s.durationSec}s / prompt_influence ${s.promptInfluence}) ---`);
      console.log(s.text);
    }
    console.log(`\n[sfx --dry-run] ${specs.length}本（API は呼んでいません）`);
    return { results: [], dryRun: true };
  }

  files.mkdir(sfxDir);
  const useApi = sound.available();
  console.log(`[sfx] ${specs.length}本 / 生成元: ${useApi ? "ElevenLabs Sound Generation" : "ffmpeg 合成音（ELEVENLABS_API_KEY 未設定）"}`);

  const results = [];
  for (const spec of specs) {
    const out = path.join(sfxDir, `${spec.name}.wav`);
    if (!force && files.ready(out)) {
      console.log(`  ${spec.name}: skip (既存)`);
      results.push({ name: spec.name, file: out, source: "cached", skipped: true });
      continue;
    }

    let source = "synth";
    if (useApi) {
      try {
        const { result } = await store.timed(
          SFX_JOB,
          "sfx",
          async () => {
            const r = await sound.generate({
              text: spec.text,
              durationSec: spec.durationSec,
              promptInfluence: spec.promptInfluence,
              label: spec.name,
            });
            // 実消費クレジットはレスポンスヘッダにしか出ないので、そのまま usage に残す
            return { result: r, usage: { duration_seconds: spec.durationSec, bytes: r.buffer.length, headers: r.headers }, model: null };
          },
          { name: spec.name, provider: "elevenlabs", prompt_influence: spec.promptInfluence }
        );
        const tmp = path.join(sfxDir, `_${spec.name}.mp3`);
        files.write(tmp, result.buffer);
        await toWav(media, tmp, out);
        files.remove(tmp);
        source = "elevenlabs";
      } catch (e) {
        console.warn(`  ${spec.name}: ElevenLabs 失敗 → 合成音にフォールバック: ${e.message}`);
        store.logEvent(SFX_JOB, { step: "sfx", ok: false, name: spec.name, error: String(e?.message ?? e) });
      }
    }
    if (source === "synth") {
      await synthesize(media, spec, out);
      store.logEvent(SFX_JOB, { step: "sfx", ok: true, name: spec.name, source: "synth", sec: 0 });
    }

    const sec = await media.probeDuration(out);
    console.log(`  ${spec.name}: ${out} (${sec.toFixed(2)}s, ${(files.size(out) / 1024).toFixed(0)}KB, ${source})`);
    results.push({ name: spec.name, file: out, source, sec, skipped: false });
  }

  const made = results.filter((r) => !r.skipped).length;
  console.log(`[sfx] 生成 ${made}本 / スキップ ${results.length - made}本 → ${sfxDir}`);
  return { results, cost: 0 };
}
