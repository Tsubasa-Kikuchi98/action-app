// ④ BGM: out/<job>/bgm.<ext>
//
// 優先順位（style: "nolan" 以外）:
//   1. assets/bgm/ に mp3/wav があればコピー（Phase 1 の既定）
//   2. ELEVENLABS_API_KEY があれば ElevenLabs Music API で生成
//   3. どちらも無ければ ffmpeg の合成音でプレースホルダを作る（動作確認用）
//
// nolan は「刻む時計 ＋ 低音の金管 ＋ 旋律を持たない緊張」でなければ成立しないので、
// **ElevenLabs を最優先**にし、キーが無いときだけ assets → 合成音に落ちる。
import path from "node:path";
import { enrichedView } from "../domain/script/index.mjs";
import { musicSpec } from "../domain/prompts/sfxPrompts.mjs";

/** out/<job>/bgm.* が既にあればそのパスを返す。 */
function existingBgm(store, files, job) {
  const p = store.paths(job);
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const f = path.join(p.dir, `bgm.${ext}`);
    if (files.ready(f)) return f;
  }
  return null;
}

/** assets/bgm/ の最初の音源ファイル。 */
function assetBgm(files, bgmDir) {
  if (!files.exists(bgmDir)) return null;
  const f = files
    .list(bgmDir)
    .filter((n) => /\.(mp3|wav|m4a|ogg)$/i.test(n))
    .sort()[0];
  return f ? path.join(bgmDir, f) : null;
}

/** ElevenLabs Music API でインストを生成する（要 ELEVENLABS_API_KEY）。 */
async function fromElevenLabs(deps, job, spec) {
  const { music, store, files } = deps;
  const out = path.join(store.paths(job).dir, "bgm.mp3");
  const { result } = await store.timed(
    job,
    "bgm",
    async () => {
      const r = await music.generate({ prompt: spec.prompt, lengthMs: spec.lengthMs, label: job });
      // 実消費クレジットはレスポンスヘッダにしか出ないので usage にそのまま残す
      return { result: r, usage: { music_length_ms: spec.lengthMs, bytes: r.buffer.length, headers: r.headers }, model: null };
    },
    { source: "elevenlabs", model_id: "music_v2", prompt: spec.prompt }
  );
  files.write(out, result.buffer);
  return out;
}

/** ffmpeg の合成音でプレースホルダ BGM（60秒）を作る。 */
async function synthesize(store, media, job) {
  const p = store.paths(job);
  const out = path.join(p.dir, "bgm.wav");
  const t0 = Date.now();
  // 可聴域のプレースホルダ: 短調のパッド(220/262/330Hz + トレモロ) + 0.5秒ごとのキック + 4秒ごとのヒット(ノイズ)
  const pad = "aevalsrc=(0.18*sin(2*PI*220*t)+0.14*sin(2*PI*261.6*t)+0.12*sin(2*PI*329.6*t)+0.10*sin(2*PI*110*t))*(0.75+0.25*sin(2*PI*5.5*t)):s=48000:d=60";
  const kick = "sine=frequency=58:sample_rate=48000:duration=60";
  const hit = "anoisesrc=color=brown:sample_rate=48000:duration=60:amplitude=0.9";
  const fc = [
    `[0:a]volume=1.0[pd]`,
    // キック: 0.5秒周期、速い減衰。後半ほど強く（盛り上げ）
    `[1:a]volume='(0.5+0.4*t/60)*exp(-14*mod(t\,0.5))':eval=frame[kk]`,
    // ヒット: 4秒ごとにノイズを短く鳴らす
    `[2:a]lowpass=f=1200,volume='0.9*exp(-5*mod(t\,4))':eval=frame[ht]`,
    `[pd][kk][ht]amix=inputs=3:normalize=0:duration=longest,` +
      `afade=t=in:st=0:d=1.5,afade=t=out:st=57:d=3,` +
      `aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[a]`,
  ].join(";");

  await media.ffmpeg([
    "-f", "lavfi", "-i", pad,
    "-f", "lavfi", "-i", kick,
    "-f", "lavfi", "-i", hit,
    "-filter_complex", fc,
    "-map", "[a]", "-t", "60",
    out,
  ]);
  store.logEvent(job, {
    step: "bgm",
    ok: true,
    sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    source: "synth",
  });
  return out;
}

/**
 * @param {object} deps { store, media, bgmDir }
 */
export async function prepareBgm(deps, job, { force = false } = {}) {
  const { store, media, files, music, bgmDir } = deps;
  store.ensureDirs(job);

  if (!force) {
    const cur = existingBgm(store, files, job);
    if (cur) {
      console.log(`[bgm] skip (既存): ${cur}`);
      return { file: cur, source: "cached" };
    }
  }

  // 台本があれば style を見る（nolan は専用のプロンプトで完成尺ぴったりに作る）
  let style = "narration";
  try {
    style = enrichedView(store.readScript(job)).style;
  } catch {
    /* 台本より先に BGM を作る場合は既定のまま */
  }
  // nolan の完成尺は約 20 秒（カード 8.4s + カット 10s + 無音 0.4s）。env で伸ばせる。
  const spec = musicSpec(style, Number(process.env.NOLAN_BGM_SEC ?? 20));
  const apiFirst = style === "nolan";

  const tryApi = async () => {
    if (!music?.available?.()) return null;
    try {
      const out = await fromElevenLabs(deps, job, spec);
      console.log(`[bgm] ElevenLabs Music API で生成: ${out}（${(spec.lengthMs / 1000).toFixed(1)}s）`);
      console.log(`  prompt: ${spec.prompt}`);
      return { file: out, source: "elevenlabs" };
    } catch (e) {
      console.warn(`[bgm] ElevenLabs 失敗 → フォールバック: ${e.message}`);
      store.logEvent(job, { step: "bgm", ok: false, source: "elevenlabs", error: String(e?.message ?? e) });
      return null;
    }
  };

  if (apiFirst) {
    const r = await tryApi();
    if (r) return r;
  }

  const asset = assetBgm(files, bgmDir);
  if (asset) {
    const ext = path.extname(asset).slice(1).toLowerCase();
    const out = path.join(store.paths(job).dir, `bgm.${ext}`);
    files.copy(asset, out);
    store.logEvent(job, { step: "bgm", ok: true, sec: 0, source: "assets", from: asset });
    console.log(`[bgm] assets/bgm からコピー: ${out}`);
    return { file: out, source: "assets" };
  }

  if (!apiFirst) {
    const r = await tryApi();
    if (r) return r;
  }

  const out = await synthesize(store, media, job);
  console.log(`[bgm] プレースホルダ（ffmpeg 合成音）を生成: ${out}`);
  console.log("  ※ 本番は assets/bgm/ にフリー BGM を置くか ELEVENLABS_API_KEY を設定してください");
  return { file: out, source: "synth" };
}
