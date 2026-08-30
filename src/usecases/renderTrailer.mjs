// ⑤ 合成: クリップ / 画像 + テロップ + ナレ + セリフ + 環境音 + BGM → out/<job>/trailer.mp4
//
// 流れ:
//   1. 素材の実測（ffprobe）… 各シーンの尺・音声有無・環境音レベル
//   2. タイムライン設計（domain/timeline/plan.mjs, 純関数）
//   3. テロップ ASS 生成（domain/timeline/ass.mjs → adapters/ffmpeg/ass.mjs）
//   4. カット別レンダ … out/<job>/cuts/cNNN.mp4
//   5. 最終 1 パス   … concat（+ 1 箇所だけ xfade）→ ルック → 4 レーンの音を amix
import path from "node:path";
import { enrichedView } from "../domain/script/index.mjs";
import { planTimeline } from "../domain/timeline/plan.mjs";
import { AMBIENT_VOL, AMBIENT_TARGET_DB } from "../domain/timeline/constants.mjs";
import { detectVoiceSpan, pickSrcIn } from "../domain/timeline/voice.mjs";

// 発話区間の探索: 声の帯域だけ残して 0.4 秒窓で RMS を測る
const VOICE_BAND = "highpass=f=250,lowpass=f=3400";
const VOICE_WINDOW = 0.4;

/**
 * plan.sfx[]（name と鳴らす時刻）に assets/sfx/<name>.wav の実パスを埋める。
 * ファイルが無い名前は braam に代替し、それも無ければそのイベントを落とす（音無しで通す）。
 */
function resolveSfx(files, sfxDir, plan) {
  if (!sfxDir || !(plan.sfx ?? []).length) {
    plan.sfx = [];
    return plan;
  }
  const pick = (name) => {
    for (const n of [name, "braam"]) {
      const f = path.join(sfxDir, `${n}.wav`);
      if (files.ready(f)) return f;
    }
    return null;
  };
  plan.sfx = plan.sfx.map((e) => ({ ...e, file: pick(e.name) })).filter((e) => e.file);
  return plan;
}

/** out/<job>/bgm.* を探す。 */
function bgmFile(files, dir) {
  for (const ext of ["mp3", "wav", "m4a", "ogg"]) {
    const f = path.join(dir, `bgm.${ext}`);
    if (files.ready(f)) return f;
  }
  return null;
}

/**
 * 各シーンの素材を ffprobe で実測して planTimeline に渡す形にする。
 * ここだけが I/O。設計そのものは domain の純関数が行う。
 */
async function measureScenes(media, files, paths, view) {
  const src = [];
  const voice = [];
  const nolan = view.style === "nolan";
  for (const [i, s] of view.scenes.entries()) {
    const nn = i + 1;
    const vid = path.join(paths.vid, `s${nn}.mp4`);
    const img = path.join(paths.img, `s${nn}.png`);
    const narFile = path.join(paths.nar, `s${nn}.wav`);
    const dlgFile = path.join(paths.dlg, `s${nn}.wav`);
    // 案 B（style: "dialogue"）は narration が空のシーンがある → その場合 wav は作られない
    const wantNar = Boolean(String(s.narration ?? "").trim());
    const hasNar = files.ready(narFile);
    if (wantNar && !hasNar) throw new Error(`ナレーションがありません: ${narFile}（scripts/narration.mjs を先に）`);

    const useVideo = s.motion === "video" && files.ready(vid);
    let clipSec = 0;
    let hasAudio = false;
    let gainDb = 0;
    if (useVideo) {
      clipSec = await media.probeDuration(vid);
      const info = await media.probeSummary(vid);
      hasAudio = (info.streams ?? []).some((st) => st.codec_type === "audio");
      if (hasAudio) {
        // gap-analysis 1-2: クリップごとに環境音の mean を揃えてから主役級の音量で使う
        const v = await media.probeVolume(vid);
        if (v) gainDb = Math.max(-6, Math.min(14, AMBIENT_TARGET_DB - v.mean));
      }
    } else if (!files.exists(img)) {
      throw new Error(`素材がありません: ${img} も ${vid} も見つかりません`);
    }

    // nolan はセリフを Veo が喋る。8 秒のクリップから「喋っている所」を含む窓を切り出したいので、
    // 声の帯域のレベルを 1 回測って発話区間を推定し、srcIn を決めておく（結果は script.json に残す）。
    let srcIn = 0;
    if (nolan && useVideo && hasAudio) {
      const cached = Number.isFinite(s.voice_start) && Number.isFinite(s.voice_end)
        ? { start: s.voice_start, end: s.voice_end }
        : null;
      const span = cached ?? detectVoiceSpan(
        await media.probeLevels(vid, { windowSec: VOICE_WINDOW, af: VOICE_BAND }),
        VOICE_WINDOW
      );
      srcIn = pickSrcIn(span, { clipSec, needSec: s.duration_sec ?? 3 });
      if (span) voice.push({ n: nn, start: span.start, end: span.end, srcIn });
    }

    const narSec = hasNar ? await media.probeDuration(narFile) : 0;
    const hasDlg = Boolean(s.dialogue) && files.ready(dlgFile);
    const dlgSec = hasDlg ? await media.probeDuration(dlgFile) : 0;

    src.push({ i, n: nn, s, useVideo, vid, img, clipSec, hasAudio, gainDb, srcIn, narFile, hasNar, narSec, dlgFile, hasDlg, dlgSec });
  }
  return { src, voice };
}

/**
 * @param {object} deps { store, media, video: { renderCut, composeFinal, writeAss }, rel }
 */
export async function renderTrailer(deps, job, { force = false } = {}) {
  const { store, media, files, ffmpegRender, rel, sfxDir } = deps;
  const t0 = Date.now();
  const p = store.ensureDirs(job, "scenes", "telop", "cuts", "dlg");
  const view = enrichedView(store.readScript(job));

  console.log(`[render] タイムライン設計（${view.scenes.length} シーン / enriched=${view.enriched}）`);
  const { src, voice } = await measureScenes(media, files, p, view);
  if (voice.length) {
    console.log(
      `  発話区間: ${voice.map((v) => `s${v.n} ${v.start.toFixed(2)}〜${v.end.toFixed(2)}s → srcIn ${v.srcIn.toFixed(2)}s`).join(" / ")}`
    );
  }
  const plan = resolveSfx(files, sfxDir, planTimeline(view, src));

  const nCut = plan.segs.filter((s) => s.kind !== "card").length;
  const nCard = plan.segs.length - nCut;
  console.log(
    `  カット ${nCut} / カード ${nCard} / 合計 ${plan.total.toFixed(2)}s` +
      (plan.xfadeAfter >= 0 ? ` / xfade 1箇所 (${plan.xfadeSec.toFixed(2)}s)` : " / xfade なし")
  );
  for (const [k, s] of plan.segs.entries()) {
    const label =
      s.kind === "card"
        ? `card(${s.color})`
        : s.kind === "still"
        ? "still"
        : `video src ${s.srcIn.toFixed(2)}-${(s.srcIn + s.srcLen).toFixed(2)} z=${s.zoom}${s.shake ? " shake" : ""}${s.slow !== 1 ? ` slow x${s.slow}` : ""}`;
    console.log(`   c${String(k).padStart(3, "0")} @${s.absStart.toFixed(2)} ${s.outSec.toFixed(2)}s ${label}`);
  }
  console.log(`  ナレ: ${plan.nar.map((e) => `s${e.n}@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)`).join(", ")}`);
  console.log(`  セリフ: ${plan.dlg.map((e) => `s${e.n}@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)「${e.text}」`).join(", ") || "(なし)"}`);
  console.log(`  button: ${plan.btn.map((e) => `@${e.at.toFixed(2)}(${e.sec.toFixed(2)}s)「${e.text}」`).join(", ") || "(なし)"}`);
  console.log(`  SFX: ${(plan.sfx ?? []).map((e) => `${e.name}@${e.at.toFixed(2)}`).join(", ") || "(なし)"}`);
  console.log(`  無音区間: ${plan.silences.map((sl) => `${sl.start.toFixed(2)}〜${sl.end.toFixed(2)}s`).join(", ")}`);

  // --- テロップ ASS -------------------------------------------------------
  ffmpegRender.writeAss(p.ass, plan.ass);
  console.log(`[render] テロップ ${rel(p.ass)}（${plan.ass.length} イベント）`);

  // --- カット別レンダ -----------------------------------------------------
  // 設計が少しでも変わるとカットの内容が変わるので、既存キャッシュはプラン一致時のみ使う。
  const planKey = JSON.stringify(plan.segs.map((s) => ({ ...s, absStart: undefined })));
  const keyFile = path.join(p.cuts, "plan.json");
  const reuse =
    !force && files.exists(keyFile) && files.readText(keyFile) === planKey;
  if (!reuse) files.removeDir(p.cuts);
  files.mkdir(p.cuts);

  const ts = Date.now();
  const cutFiles = [];
  for (const [k, seg] of plan.segs.entries()) {
    const f = path.join(p.cuts, `c${String(k).padStart(3, "0")}.mp4`);
    if (reuse && files.ready(f)) cutFiles.push(f);
    else cutFiles.push(await ffmpegRender.renderCut(p.cuts, seg, k));
  }
  files.writeText(keyFile, planKey);
  console.log(`[render] カット別レンダ ${cutFiles.length}本 (${((Date.now() - ts) / 1000).toFixed(1)}s)${reuse ? " ※一部再利用" : ""}`);

  // --- 最終合成 -----------------------------------------------------------
  const tc = Date.now();
  const bgmPath = bgmFile(files, p.dir);
  const bgm = bgmPath ? { file: bgmPath, dur: await media.probeDuration(bgmPath) } : null;
  await ffmpegRender.composeFinal({
    plan, cutFiles, assPath: p.ass, fcPath: p.fc, bgm, out: p.trailer,
  });
  console.log(`[render] 最終合成 (${((Date.now() - tc) / 1000).toFixed(1)}s)`);

  const sec = (Date.now() - t0) / 1000;
  store.logEvent(job, {
    step: "render",
    ok: true,
    sec: Number(sec.toFixed(2)),
    total_sec: Number(plan.total.toFixed(2)),
    cuts: nCut,
    cards: nCard,
    dialogue: plan.dlg.length,
    button: plan.btn.length,
    sfx: (plan.sfx ?? []).length,
    style: view.style,
    ambient_vol: AMBIENT_VOL,
    bgm: bgmPath ? path.basename(bgmPath) : null,
  });

  console.log(`[render] ${p.trailer}`);
  console.log(`  尺 ${plan.total.toFixed(2)}s / カット ${nCut} / カード ${nCard} / セリフ ${plan.dlg.length} / 所要 ${sec.toFixed(1)}s`);
  return { file: p.trailer, sec, total: plan.total, plan, bgm: bgmPath };
}
