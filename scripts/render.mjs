// ⑤ 合成: 画像 + テロップ + ナレーション + BGM → out/<job>/trailer.mp4
// 使い方: node scripts/render.mjs <job> [--force]
//
// 手順:
//   1. シーン別レンダ  … scenes/sN.mp4
//        motion:"video" … vid/sN.mp4 を 1080p 化 + drawtext + ナレ + Veo 環境音（ダッキング）
//        motion:"still" … img/sN.png + Ken Burns + drawtext + ナレ（Phase 1 と同じ経路）
//   2. タイトルカード  … 黒背景 + title + COMING SOON → scenes/title.mp4
//   3. 最終合成        … xfade チェーン + BGM ダッキング + loudnorm → trailer.mp4
//
// ffmpeg / Windows の注意（CLAUDE.md 準拠）:
//   - fontfile は 'C\:/Windows/Fonts/YuGothB.ttc'（font= は使わない）
//   - テロップは textfile + expansion=none で渡す
//   - filter_complex は文字列生成 → fc.txt → `-/filter_complex fc.txt`
//   - zoompan の前に scale=iw*4:ih*4、fps=30 と s=1920x1080 を明示
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, ensureDirs, readScript, jobPaths, ffmpeg, probeDuration, probeSummary,
  frames, logEvent, isMain,
} from "./lib.mjs";

const W = 1920;
const H = 1080;
const FPS = 30;
const FONT = "C\\:/Windows/Fonts/YuGothB.ttc"; // .ttc は face 0（游ゴシック Bold）のみ
const TITLE_SEC = 2.5; // Phase 2: 全体 20 秒前後に合わせて短縮

// Veo 同梱音声（環境音レーン）の音量。ナレーションでサイドチェイン・ダッキングする。
const AMBIENT_VOL = Number(process.env.AMBIENT_VOL ?? 0.25);

// ---------------------------------------------------------------- 小道具
/** ROOT からの相対パスをスラッシュ区切りで返す（filter 内の : エスケープを避ける）。 */
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/");

/** drawtext 用のテキストファイルを書く（末尾改行なし）。 */
function writeTelop(file, text) {
  fs.writeFileSync(file, String(text).replace(/[\r\n]+/g, " ").trim(), "utf8");
  return rel(file);
}

/** Ken Burns（zoompan）の式。シーンごとに4パターンで変化をつける。 */
function kenBurns(i, f) {
  const c = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  switch (i % 4) {
    case 0: // ズームイン・中央
      return { z: `1+0.12*on/${f}`, x: c.x, y: c.y };
    case 1: // ズームアウト・中央
      return { z: `1.12-0.12*on/${f}`, x: c.x, y: c.y };
    case 2: // ズームイン・右へパン
      return { z: `1+0.10*on/${f}`, x: `(iw-iw/zoom)*on/${f}`, y: c.y };
    default: // ズームアウト・左へパン
      return { z: `1.12-0.10*on/${f}`, x: `(iw-iw/zoom)*(1-on/${f})`, y: c.y };
  }
}

/** テロップのフェードイン / フェードアウト（alpha 式）。 */
const alphaExpr = (dur, fin = 0.5, fout = 0.4) =>
  `if(lt(t,${fin}),t/${fin},if(gt(t,${(dur - fout).toFixed(3)}),max(0,(${dur.toFixed(3)}-t)/${fout}),1))`;

// ---------------------------------------------------------------- 1. シーン
/** テロップ drawtext（[bg] → [v]）。静止画・動画で共通。 */
const telopFilter = (telopFile, dur) =>
  `[bg]drawtext=fontfile='${FONT}':textfile='${telopFile}':expansion=none:` +
  `fontsize=72:fontcolor=white:` +
  `shadowcolor=black@0.85:shadowx=4:shadowy=4:` +
  `x=(w-text_w)/2:y=h-210:` +
  `alpha='${alphaExpr(dur)}',format=yuv420p[v]`;

/** ナレーション入力（[idx:a] → label）。少し間を置き、シーン尺いっぱいまで無音で埋める。 */
const narFilter = (idx, dur, label) =>
  `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
  `adelay=250|250,apad,atrim=0:${dur},asetpts=N/SR/TB${label}`;

/** ffmpeg を叩いてシーン mp4 を書き出す（全シーンで同じエンコード設定に揃える）。 */
async function encodeScene(inputs, fcFile, out, dur) {
  await ffmpeg([
    ...inputs,
    "-/filter_complex", rel(fcFile),
    "-map", "[v]", "-map", "[a]",
    "-t", String(dur),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    rel(out),
  ]);
  return out;
}

/** 動画シーン: vid/sN.mp4（Veo 720p/24fps）→ 1080p/30fps + テロップ + ナレ + 環境音。 */
async function renderVideoScene(job, scene, i, vid, nar, out) {
  const p = jobPaths(job);
  const n = i + 1;
  const dur = scene.duration_sec;

  // クリップが尺より短ければ最後のフレームを clone で伸ばす
  const clipSec = await probeDuration(vid);
  const pad = Math.max(0, dur - clipSec);
  const info = await probeSummary(vid);
  const hasAudio = (info.streams ?? []).some((st) => st.codec_type === "audio");

  const telopFile = writeTelop(path.join(p.telop, `s${n}.txt`), scene.telop);

  const lines = [
    // 720p → 1080p（lanczos）。settb/fps/format/setsar は xfade 前提に合わせて統一する。
    `[0:v]scale=${W}:${H}:flags=lanczos:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `settb=AVTB,fps=${FPS},format=yuv420p,setsar=1,` +
      `trim=0:${dur},setpts=PTS-STARTPTS` +
      (pad > 0 ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : "") +
      `[bg]`,
    telopFilter(telopFile, dur),
  ];

  if (hasAudio) {
    // ナレを asplit してサイドチェイン用に分岐（CLAUDE.md の注意点）
    lines.push(narFilter(1, dur, "[nar]"));
    lines.push(`[nar]asplit=2[nar_main][nar_sc]`);
    lines.push(
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `apad,atrim=0:${dur},asetpts=N/SR/TB,volume=${AMBIENT_VOL}[amb]`
    );
    lines.push(`[amb][nar_sc]sidechaincompress=threshold=0.03:ratio=8:attack=10:release=300[ambduck]`);
    lines.push(
      `[ambduck][nar_main]amix=inputs=2:normalize=0:duration=longest,` +
        `atrim=0:${dur},asetpts=N/SR/TB[a]`
    );
  } else {
    lines.push(narFilter(1, dur, "[a]"));
  }

  const fcFile = path.join(p.dir, `fc_s${n}.txt`);
  fs.writeFileSync(fcFile, lines.join(";\n"), "utf8");

  return encodeScene(["-i", rel(vid), "-i", rel(nar)], fcFile, out, dur);
}

/** 静止画シーン: img/sN.png + Ken Burns + テロップ + ナレ（Phase 1 と同じ）。 */
async function renderStillScene(job, scene, i, img, nar, out) {
  const p = jobPaths(job);
  const n = i + 1;
  const dur = scene.duration_sec;
  const f = frames(dur, FPS);
  const kb = kenBurns(i, f);
  const telopFile = writeTelop(path.join(p.telop, `s${n}.txt`), scene.telop);

  const fc = [
    // 画像 → 16:9 に切り出し → 4倍に拡大（zoompan のジッター防止）→ Ken Burns
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `scale=iw*4:ih*4,` +
      `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${f}:s=${W}x${H}:fps=${FPS},` +
      `settb=AVTB,setsar=1[bg]`,
    telopFilter(telopFile, dur),
    narFilter(1, dur, "[a]"),
  ].join(";\n");

  const fcFile = path.join(p.dir, `fc_s${n}.txt`);
  fs.writeFileSync(fcFile, fc, "utf8");

  return encodeScene(["-loop", "1", "-i", rel(img), "-i", rel(nar)], fcFile, out, dur);
}

/** motion に応じて動画 / 静止画のどちらかでシーンを書き出す。戻り値は実際に使った経路。 */
async function renderScene(job, scene, i) {
  const p = jobPaths(job);
  const n = i + 1;
  const img = path.join(p.img, `s${n}.png`);
  const vid = path.join(p.vid, `s${n}.mp4`);
  const nar = path.join(p.nar, `s${n}.wav`);
  const out = path.join(p.scenes, `s${n}.mp4`);
  if (!fs.existsSync(nar)) throw new Error(`ナレーションがありません: ${nar}（scripts/narration.mjs を先に）`);

  // motion が無い旧 script.json（Phase 1）は静止画扱い。動画指定でもクリップが無ければ静止画に落とす。
  const useVideo = scene.motion === "video" && fs.existsSync(vid) && fs.statSync(vid).size > 0;
  if (useVideo) {
    await renderVideoScene(job, scene, i, vid, nar, out);
    return "video";
  }
  if (!fs.existsSync(img)) throw new Error(`画像がありません: ${img}（scripts/images.mjs を先に）`);
  await renderStillScene(job, scene, i, img, nar, out);
  return "still";
}

// ---------------------------------------------------------------- 2. タイトル
async function renderTitle(job, title) {
  const p = jobPaths(job);
  const out = path.join(p.scenes, "title.mp4");
  const titleFile = writeTelop(path.join(p.telop, "title.txt"), title);
  const comingFile = writeTelop(path.join(p.telop, "coming.txt"), "C O M I N G   S O O N");

  const fadeIn = `if(lt(t,0.6),t/0.6,1)`;
  const fc = [
    `[0:v]drawtext=fontfile='${FONT}':textfile='${titleFile}':expansion=none:` +
      `fontsize=132:fontcolor=white:shadowcolor=black@0.6:shadowx=3:shadowy=3:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-50:alpha='${fadeIn}',` +
      `drawtext=fontfile='${FONT}':textfile='${comingFile}':expansion=none:` +
      `fontsize=46:fontcolor=white@0.85:` +
      `x=(w-text_w)/2:y=h/2+90:alpha='if(lt(t,1.2),max(0,(t-0.6)/0.6),1)',` +
      `setsar=1,format=yuv420p[v]`,
    `[1:a]atrim=0:${TITLE_SEC},asetpts=N/SR/TB[a]`,
  ].join(";\n");

  const fcFile = path.join(p.dir, "fc_title.txt");
  fs.writeFileSync(fcFile, fc, "utf8");

  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=${TITLE_SEC}`,
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${TITLE_SEC}`,
    "-/filter_complex", rel(fcFile),
    "-map", "[v]", "-map", "[a]",
    "-t", String(TITLE_SEC),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    rel(out),
  ]);
  return out;
}

// ---------------------------------------------------------------- 3. 最終合成
/** クリップ間のトランジション定義（クリップ数 - 1 個）。 */
function transitions(nClips) {
  const t = [];
  for (let k = 0; k < nClips - 1; k++) {
    if (k === nClips - 2) t.push({ name: "fadeblack", dur: 0.6 }); // タイトル直前
    else if (k % 2 === 1) t.push({ name: "fadewhite", dur: 0.16 }); // フラッシュ
    else t.push({ name: "fade", dur: 0.5 });
  }
  return t;
}

function bgmFile(job) {
  const p = jobPaths(job);
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const f = path.join(p.dir, `bgm.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  }
  return null;
}

async function compose(job, clips) {
  const p = jobPaths(job);
  const durs = [];
  for (const c of clips) durs.push(await probeDuration(c));

  const tr = transitions(clips.length);
  const trSum = tr.reduce((a, t) => a + t.dur, 0);
  const total = durs.reduce((a, d) => a + d, 0) - trSum;

  // offset = Σクリップ長 − Σトランジション長（プログラム計算）
  const offsets = [];
  let acc = durs[0];
  for (let k = 0; k < tr.length; k++) {
    offsets.push(acc - tr[k].dur);
    acc += durs[k + 1] - tr[k].dur;
  }

  const bgm = bgmFile(job);
  const lines = [];

  // --- 映像: 各入力を揃えてから xfade チェーン ---
  clips.forEach((_, i) => {
    lines.push(`[${i}:v]settb=AVTB,fps=${FPS},format=yuv420p,setsar=1[v${i}]`);
  });
  let cur = "[v0]";
  tr.forEach((t, k) => {
    const outLabel = k === tr.length - 1 ? "[vout]" : `[x${k}]`;
    lines.push(
      `${cur}[v${k + 1}]xfade=transition=${t.name}:duration=${t.dur}:offset=${offsets[k].toFixed(3)}${outLabel}`
    );
    cur = outLabel;
  });

  // --- 音声: シーン音声をトランジション分だけ詰めて concat ---
  clips.forEach((_, i) => {
    const len = i < tr.length ? durs[i] - tr[i].dur : durs[i];
    lines.push(
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=0:${len.toFixed(3)},asetpts=N/SR/TB[a${i}]`
    );
  });
  lines.push(`${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[narall]`);

  let audioOut = "[narall]";
  if (bgm) {
    const bgmIdx = clips.length;
    const bgmDur = await probeDuration(bgm);
    const loop = bgmDur < total ? `aloop=loop=-1:size=${Math.round(bgmDur * 48000)},` : "";
    lines.push(`[narall]asplit=2[nar_main][nar_sc]`);
    lines.push(
      `[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${loop}` +
        `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,volume=0.5,` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(3)}:d=2.5[bgmv]`
    );
    // ナレーションでサイドチェイン・ダッキング
    lines.push(`[bgmv][nar_sc]sidechaincompress=threshold=0.035:ratio=8:attack=15:release=350[bgmduck]`);
    lines.push(
      `[bgmduck][nar_main]amix=inputs=2:normalize=0:duration=longest,` +
        `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`
    );
    audioOut = "[aout]";
  } else {
    lines.push(`[narall]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
    audioOut = "[aout]";
  }

  fs.writeFileSync(p.fc, lines.join(";\n"), "utf8");

  const args = [];
  for (const c of clips) args.push("-i", rel(c));
  if (bgm) args.push("-i", rel(bgm));
  args.push(
    "-/filter_complex", rel(p.fc),
    "-map", "[vout]", "-map", audioOut,
    "-t", total.toFixed(3),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    rel(p.trailer)
  );
  await ffmpeg(args);
  return { total, durs, tr, offsets, bgm };
}

// ---------------------------------------------------------------- エントリ
export async function render(job, { force = false } = {}) {
  const t0 = Date.now();
  const p = ensureDirs(job, "scenes", "telop");
  const data = readScript(job);

  const nVideo = data.scenes.filter((s) => s.motion === "video").length;
  console.log(`[render] シーン別レンダ ${data.scenes.length}件（動画 ${nVideo} / 静止画 ${data.scenes.length - nVideo}）`);
  const clips = [];
  for (const [i, scene] of data.scenes.entries()) {
    const out = path.join(p.scenes, `s${i + 1}.mp4`);
    if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) {
      console.log(`  s${i + 1}: skip (既存)`);
    } else {
      const ts = Date.now();
      const mode = await renderScene(job, scene, i);
      console.log(`  s${i + 1}: [${mode}] ${scene.duration_sec}s (${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    }
    clips.push(out);
  }

  const titleMp4 = path.join(p.scenes, "title.mp4");
  if (!force && fs.existsSync(titleMp4) && fs.statSync(titleMp4).size > 0) {
    console.log("  title: skip (既存)");
  } else {
    await renderTitle(job, data.title);
    console.log(`  title: "${data.title}" + COMING SOON (${TITLE_SEC}s)`);
  }
  clips.push(titleMp4);

  console.log("[render] 最終合成 (xfade + BGM ダッキング + loudnorm)");
  const info = await compose(job, clips);
  const sec = (Date.now() - t0) / 1000;
  logEvent(job, {
    step: "render",
    ok: true,
    sec: Number(sec.toFixed(2)),
    total_sec: Number(info.total.toFixed(2)),
    video_scenes: nVideo,
    still_scenes: data.scenes.length - nVideo,
    bgm: info.bgm ? path.basename(info.bgm) : null,
  });

  console.log(`[render] ${p.trailer}`);
  console.log(`  尺: ${info.total.toFixed(2)}s / クリップ ${info.durs.map((d) => d.toFixed(2)).join(", ")}`);
  console.log(`  transition: ${info.tr.map((t, k) => `${t.name}@${info.offsets[k].toFixed(2)}`).join(", ")}`);
  console.log(`  所要 ${sec.toFixed(1)}s`);
  return { file: p.trailer, sec, ...info };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await render(job, { force });
}
