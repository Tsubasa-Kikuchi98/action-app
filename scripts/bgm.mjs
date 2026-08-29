// ④ BGM: out/<job>/bgm.<ext>
// 使い方: node scripts/bgm.mjs <job> [--force]
//
// 優先順位:
//   1. assets/bgm/ に mp3/wav があればコピー（Phase 1 の既定）
//   2. ELEVENLABS_API_KEY があれば ElevenLabs Music API で生成
//   3. どちらも無ければ ffmpeg の合成音でプレースホルダを作る（動作確認用）
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDirs, ffmpeg, logEvent, jobPaths, isMain } from "./lib.mjs";

const BGM_DIR = path.join(ROOT, "assets", "bgm");
const MUSIC_PROMPT =
  "Epic cinematic movie trailer score. Deep braams, low pulsing drone, tense ostinato strings, " +
  "building percussion hits, rising tension into a triumphant climax. Fully instrumental, no vocals.";

/** out/<job>/bgm.* が既にあればそのパスを返す。 */
function existingBgm(job) {
  const p = jobPaths(job);
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const f = path.join(p.dir, `bgm.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  }
  return null;
}

/** assets/bgm/ の最初の音源ファイル。 */
function assetBgm() {
  if (!fs.existsSync(BGM_DIR)) return null;
  const f = fs
    .readdirSync(BGM_DIR)
    .filter((n) => /\.(mp3|wav|m4a|ogg)$/i.test(n))
    .sort()[0];
  return f ? path.join(BGM_DIR, f) : null;
}

/** ElevenLabs Music API で 45 秒のインストを生成する（要 ELEVENLABS_API_KEY）。 */
async function fromElevenLabs(job) {
  const p = jobPaths(job);
  const out = path.join(p.dir, "bgm.mp3");
  const t0 = Date.now();
  const res = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: MUSIC_PROMPT,
      music_length_ms: 45000,
      model_id: "music_v2",
      force_instrumental: true,
      output_format: "mp3_44100_128",
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs Music API 失敗 (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  logEvent(job, {
    step: "bgm",
    ok: true,
    sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    source: "elevenlabs",
    model: "music_v2",
  });
  return out;
}

/** ffmpeg の合成音でプレースホルダ BGM（60秒）を作る。 */
async function synthesize(job) {
  const p = jobPaths(job);
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

  await ffmpeg([
    "-f", "lavfi", "-i", pad,
    "-f", "lavfi", "-i", kick,
    "-f", "lavfi", "-i", hit,
    "-filter_complex", fc,
    "-map", "[a]", "-t", "60",
    out,
  ]);
  logEvent(job, {
    step: "bgm",
    ok: true,
    sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    source: "synth",
  });
  return out;
}

export async function prepareBgm(job, { force = false } = {}) {
  ensureDirs(job);

  if (!force) {
    const cur = existingBgm(job);
    if (cur) {
      console.log(`[bgm] skip (既存): ${cur}`);
      return { file: cur, source: "cached" };
    }
  }

  const asset = assetBgm();
  if (asset) {
    const ext = path.extname(asset).slice(1).toLowerCase();
    const out = path.join(jobPaths(job).dir, `bgm.${ext}`);
    fs.copyFileSync(asset, out);
    logEvent(job, { step: "bgm", ok: true, sec: 0, source: "assets", from: asset });
    console.log(`[bgm] assets/bgm からコピー: ${out}`);
    return { file: out, source: "assets" };
  }

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const out = await fromElevenLabs(job);
      console.log(`[bgm] ElevenLabs Music API で生成: ${out}`);
      return { file: out, source: "elevenlabs" };
    } catch (e) {
      console.warn(`[bgm] ElevenLabs 失敗 → 合成音にフォールバック: ${e.message}`);
    }
  }

  const out = await synthesize(job);
  console.log(`[bgm] プレースホルダ（ffmpeg 合成音）を生成: ${out}`);
  console.log("  ※ 本番は assets/bgm/ にフリー BGM を置くか ELEVENLABS_API_KEY を設定してください");
  return { file: out, source: "synth" };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await prepareBgm(job, { force });
}
