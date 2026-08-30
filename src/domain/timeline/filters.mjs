// ffmpeg の filter_complex 文字列を組み立てる純関数群。
// ファイル書き込み・プロセス起動は adapters/ffmpeg/ が担当する。
//
// ffmpeg / Windows の注意（CLAUDE.md 準拠）:
//   - blend は format=gbrp で行い後で yuv420p に戻す（YUV のままだとマゼンタ化）
//   - crop の w/h に t は使えない（x/y は可）→ 寄りは固定 crop、動きは x/y の式で作る
//   - zoompan の前に scale=iw*4:ih*4、fps=30 / s=1920x1080 を明示（静止画フォールバック経路）
//   - xfade の 2 入力は両方に settb=AVTB,fps,format,setsar を掛ける
import {
  W, H, FPS, BAR, AMBIENT_VOL, NAR_VOL, DLG_VOL, BTN_VOL, BGM_VOL,
  NOLAN_BGM_VOL, SFX_VOL, frames,
} from "./constants.mjs";

// ---------------------------------------------------------------- カット
/** Ken Burns（zoompan）の式。静止画フォールバック用。 */
export function kenBurns(i, f) {
  const c = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  switch (i % 4) {
    case 0: return { z: `1+0.12*on/${f}`, x: c.x, y: c.y };
    case 1: return { z: `1.12-0.12*on/${f}`, x: c.x, y: c.y };
    case 2: return { z: `1+0.10*on/${f}`, x: `(iw-iw/zoom)*on/${f}`, y: c.y };
    default: return { z: `1.12-0.10*on/${f}`, x: `(iw-iw/zoom)*(1-on/${f})`, y: c.y };
  }
}

/** crop（疑似寄り + 手ブレ + ドリフト）の式。crop の w/h に t は使えないので固定値にする。 */
export function cropExpr(seg) {
  const z = Math.max(1.0, seg.zoom ?? 1);
  const cw = Math.max(2, Math.round((W / z) / 2) * 2);
  const ch = Math.max(2, Math.round((H / z) / 2) * 2);
  const maxX = W - cw;
  const maxY = H - ch;
  if (maxX < 2 || maxY < 2) return null;
  const D = Math.max(0.1, seg.outSec);
  const dx = Math.max(-maxX / 2, Math.min(maxX / 2, seg.drift?.x ?? 0));
  const dy = Math.max(-maxY / 2, Math.min(maxY / 2, seg.drift?.y ?? 0));
  let x = `${(maxX / 2).toFixed(1)}+${dx.toFixed(1)}*(t/${D.toFixed(3)})`;
  let y = `${(maxY / 2).toFixed(1)}+${dy.toFixed(1)}*(t/${D.toFixed(3)})`;
  if (seg.shake) {
    x += `+7*sin(2*PI*t*3.3)+3*sin(2*PI*t*7.1)`;
    y += `+5*sin(2*PI*t*2.7)`;
  }
  return { cw, ch, x: `max(0\\,min(${maxX}\\,${x}))`, y: `max(0\\,min(${maxY}\\,${y}))` };
}

/**
 * 1 カット分の filter_complex を組む。
 * @param {object} seg plan.segs の 1 要素
 * @returns {string} filter_complex の中身
 */
export function buildCutFilter(seg) {
  const dur = seg.outSec;

  if (seg.kind === "card") {
    return [
      `[0:v]settb=AVTB,fps=${FPS},setsar=1,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[v]`,
      `[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`,
    ].join(";\n");
  }

  if (seg.kind === "still") {
    const f = frames(dur, FPS);
    const kb = kenBurns(seg.kb, f);
    return [
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=iw*4:ih*4,` +
        `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${f}:s=${W}x${H}:fps=${FPS},` +
        `settb=AVTB,setsar=1,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[v]`,
      `[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`,
    ].join(";\n");
  }

  // --- video ---------------------------------------------------------------
  const inA = seg.srcIn;
  const inB = seg.srcIn + seg.srcLen;
  const slow = seg.slow ?? 1;
  const c = cropExpr(seg);
  const played = seg.srcLen * slow; // trim 後に実際に得られる尺
  const pad = Math.max(0, dur - played);

  const vparts = [
    `[0:v]trim=${inA.toFixed(3)}:${inB.toFixed(3)},setpts=(PTS-STARTPTS)${slow !== 1 ? `*${slow}` : ""}`,
    `fps=${FPS}`,
    `scale=${W}:${H}:flags=lanczos:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
  ];
  if (c) {
    vparts.push(`crop=w=${c.cw}:h=${c.ch}:x='${c.x}':y='${c.y}'`);
    vparts.push(`scale=${W}:${H}:flags=lanczos`);
  }
  if (pad > 0.01) vparts.push(`tpad=stop_mode=clone:stop_duration=${(pad + 0.2).toFixed(3)}`);
  vparts.push(`settb=AVTB,setsar=1,format=yuv420p`, `trim=0:${dur.toFixed(3)}`, `setpts=PTS-STARTPTS[v]`);

  const lines = [vparts.join(",")];

  if (seg.hasAudio) {
    // 映像と同じ trim 区間の環境音を使う（カットしても「そのカットの音」になる）
    const aparts = [
      `[0:a]atrim=${inA.toFixed(3)}:${inB.toFixed(3)},asetpts=PTS-STARTPTS`,
      `aresample=48000`,
      `aformat=sample_fmts=fltp:channel_layouts=stereo`,
    ];
    // スローは atempo（0.5 以上なので SLOW_FACTOR<=2.0 で有効）
    if (slow !== 1) aparts.push(`atempo=${(1 / slow).toFixed(4)}`);
    if (Math.abs(seg.gainDb) > 0.1) aparts.push(`volume=${seg.gainDb.toFixed(2)}dB`);
    aparts.push(`apad`, `atrim=0:${dur.toFixed(3)}`, `asetpts=N/SR/TB[a]`);
    lines.push(aparts.join(","));
  } else {
    lines.push(`[1:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[a]`);
  }
  return lines.join(";\n");
}

// ---------------------------------------------------------------- 最終合成
/**
 * nolan のルック: teal-orange グレード・ブルーム・強いグレインを外し、
 * 彩度を落とした鋼色の青と硬めのコントラストだけにする（ノーラン作品の色）。
 */
export function lookFilterNolan(inLabel, assRel, outLabel) {
  return [
    `${inLabel}scale=${W}:${H}:flags=lanczos,fps=${FPS},` +
      // 影を青に寄せ、ハイライトをわずかに冷たく（鋼色）
      `colorbalance=rs=-0.04:bs=0.08:rm=-0.02:bm=0.03:rh=-0.02:bh=0.02,` +
      `eq=contrast=1.12:saturation=0.80:gamma=0.98,` +
      `vignette=PI/4[graded]`,
    // グレインは微量、ブルームは掛けない
    `[graded]noise=alls=2:allf=t,` +
      `ass=f=${assRel},` +
      `drawbox=x=0:y=0:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `drawbox=x=0:y=ih-${BAR}:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `settb=AVTB,fps=${FPS},setsar=1,format=yuv420p${outLabel}`,
  ];
}

/** グレード → ブルーム → グレイン → ASS → レターボックス（quality-research §D-1）。 */
export function lookFilter(inLabel, assRel, outLabel, style = "narration") {
  if (style === "nolan") return lookFilterNolan(inLabel, assRel, outLabel);
  return [
    `${inLabel}scale=${W}:${H}:flags=lanczos,fps=${FPS},` +
      `curves=r='0/0.00 0.5/0.52 1/1.00':g='0/0.005 0.5/0.50 1/0.995':b='0/0.030 0.5/0.48 1/0.95',` +
      `eq=contrast=1.06:saturation=1.10,vignette=PI/5[base]`,
    // blend は RGB で（YUV のままだとマゼンタ化）
    `[base]format=gbrp,split=2[b1][b2]`,
    // ブルームは 1/4 に落としてから blur（見た目は同等で大幅に速い）
    `[b2]curves=all='0/0 0.72/0 1/1',scale=iw/4:ih/4,gblur=sigma=7,scale=${W}:${H}[bl]`,
    `[b1][bl]blend=all_mode=screen:all_opacity=0.30,format=yuv420p[bloomed]`,
    `[bloomed]noise=alls=5:allf=t+u,` +
      `ass=f=${assRel},` +
      `drawbox=x=0:y=0:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `drawbox=x=0:y=ih-${BAR}:w=iw:h=${BAR}:color=black@1:t=fill,` +
      `settb=AVTB,fps=${FPS},setsar=1,format=yuv420p${outLabel}`,
  ];
}

/** ナレーションのトレーラー処理チェーン（quality-research §C-4）。 */
export const NAR_CHAIN =
  `highpass=f=70,equalizer=f=115:t=q:w=1.0:g=4,equalizer=f=330:t=q:w=1.2:g=-3,` +
  `equalizer=f=3800:t=q:w=1.6:g=3,` +
  `acompressor=threshold=0.08:ratio=4:attack=8:release=180:makeup=2,` +
  `aecho=0.9:0.85:38:0.12,alimiter=limit=0.94`;

/** セリフ = 「現場の声」。小部屋の残響と低域カット（gap-analysis 1-8）。 */
export const DLG_CHAIN =
  `highpass=f=120,equalizer=f=2600:t=q:w=1.4:g=2,` +
  `acompressor=threshold=0.10:ratio=3.5:attack=6:release=140:makeup=2,` +
  `aecho=0.8:0.7:20|40:0.25|0.15,alimiter=limit=0.94`;

/** button = 「素の声」。演出を足さない（軽い整音だけ）。 */
export const BTN_CHAIN = `highpass=f=90,acompressor=threshold=0.12:ratio=2.5:attack=10:release=180:makeup=1,alimiter=limit=0.94`;

/**
 * 最終 1 パスの filter_complex を組む。
 * 入力の並びは [カット 0..N-1][ナレ][セリフ][button][BGM] の順で、
 * 呼び出し側（usecase）が同じ順で -i を並べること。
 * @param {object} plan planTimeline() の戻り値
 * @param {{cutCount: number, assRel: string, bgm: {dur: number}|null}} ctx
 * @returns {string} filter_complex の中身
 */
export function buildComposeFilter(plan, { cutCount, assRel, bgm }) {
  const lines = [];
  const N = cutCount;
  const total = plan.total;

  // --- 入力インデックス ---------------------------------------------------
  const narBase = N;
  const dlgBase = narBase + plan.nar.length;
  const btnBase = dlgBase + plan.dlg.length;
  const sfxBase = btnBase + plan.btn.length;
  const sfxList = plan.sfx ?? [];
  const bgmIdx = sfxBase + sfxList.length;
  const style = plan.style ?? "narration";

  // --- 各カットを揃える ---------------------------------------------------
  plan.segs.forEach((seg, k) => {
    const d = seg.outSec.toFixed(3);
    lines.push(
      `[${k}:v]trim=0:${d},setpts=PTS-STARTPTS,settb=AVTB,fps=${FPS},setsar=1,format=yuv420p[cv${k}]`
    );
    lines.push(
      `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `apad,atrim=0:${d},asetpts=N/SR/TB[ca${k}]`
    );
  });

  // --- concat（xfade があれば 2 グループに分けて 1 箇所だけ繋ぐ） ----------
  const X = plan.xfadeAfter;
  const cat = (from, to, tag) => {
    const idx = [];
    for (let k = from; k <= to; k++) idx.push(k);
    if (idx.length === 1) {
      lines.push(`[cv${idx[0]}]null[gv${tag}]`);
      lines.push(`[ca${idx[0]}]anull[ga${tag}]`);
    } else {
      lines.push(`${idx.map((k) => `[cv${k}]`).join("")}concat=n=${idx.length}:v=1:a=0[gv${tag}]`);
      lines.push(`${idx.map((k) => `[ca${k}]`).join("")}concat=n=${idx.length}:v=0:a=1[ga${tag}]`);
    }
    return idx.reduce((a, k) => a + plan.segs[k].outSec, 0);
  };

  if (X >= 0) {
    const d0 = cat(0, X, "0");
    cat(X + 1, N - 1, "1");
    const off = (d0 - plan.xfadeSec).toFixed(3);
    // CLAUDE.md: xfade の前に各入力を settb/fps/format/setsar で必ず揃える。
    // （片方が concat・片方が単一クリップだと timebase が 1/30 と 1/1000000 で食い違い
    //   "First input link main timebase do not match" でグラフ構築に失敗する）
    for (const g of ["0", "1"]) {
      lines.push(`[gv${g}]settb=AVTB,fps=${FPS},format=yuv420p,setsar=1[xv${g}]`);
    }
    lines.push(`[xv0][xv1]xfade=transition=fade:duration=${plan.xfadeSec.toFixed(3)}:offset=${off}[vcat]`);
    lines.push(`[ga0][ga1]acrossfade=d=${plan.xfadeSec.toFixed(3)}:c1=tri:c2=tri[acat]`);
  } else {
    cat(0, N - 1, "0");
    lines.push(`[gv0]null[vcat]`);
    lines.push(`[ga0]anull[acat]`);
  }

  // --- 映像のルック -------------------------------------------------------
  lines.push(...lookFilter("[vcat]", assRel, "[v]", style));

  // --- 音: 環境音レーン ---------------------------------------------------
  lines.push(
    `[acat]atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      `highpass=f=40,treble=g=-2:f=7000,volume=${AMBIENT_VOL}[ambv]`
  );

  // --- 音: ナレレーン -----------------------------------------------------
  plan.nar.forEach((e, k) => {
    const ms = Math.round(e.at * 1000);
    lines.push(
      `[${narBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}[nr${k}]`
    );
  });
  if (plan.nar.length === 0) {
    // 案 B でナレが 1 本も無いジョブでもグラフが成立するようにする
    lines.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[narv]`);
  } else {
    if (plan.nar.length === 1) lines.push(`[nr0]anull[narmix]`);
    else lines.push(`${plan.nar.map((_, k) => `[nr${k}]`).join("")}amix=inputs=${plan.nar.length}:normalize=0:duration=longest[narmix]`);
    lines.push(`[narmix]${NAR_CHAIN},volume=${NAR_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[narv]`);
  }

  // --- 音: セリフレーン ---------------------------------------------------
  let dlgLabel = null;
  if (plan.dlg.length) {
    plan.dlg.forEach((e, k) => {
      const ms = Math.round(e.at * 1000);
      lines.push(
        `[${dlgBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `adelay=${ms}|${ms}[dl${k}]`
      );
    });
    if (plan.dlg.length === 1) lines.push(`[dl0]anull[dlgmix]`);
    else lines.push(`${plan.dlg.map((_, k) => `[dl${k}]`).join("")}amix=inputs=${plan.dlg.length}:normalize=0:duration=longest[dlgmix]`);
    lines.push(`[dlgmix]${DLG_CHAIN},volume=${DLG_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[dlgv]`);
    dlgLabel = "[dlgv]";
  }

  // --- 音: button レーン（素の声。残響は付けない）--------------------------
  let btnLabel = null;
  if (plan.btn.length) {
    const e = plan.btn[0];
    const ms = Math.round(e.at * 1000);
    lines.push(
      `[${btnBase}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}[btn0]`
    );
    lines.push(`[btn0]${BTN_CHAIN},volume=${BTN_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[btnv]`);
    btnLabel = "[btnv]";
  }

  // --- 音: SFX レーン（ブラーム。カードの開始時刻に置く。ダッキングはしない）---
  let sfxLabel = null;
  if (sfxList.length) {
    sfxList.forEach((e, k) => {
      const ms = Math.round(e.at * 1000);
      lines.push(
        `[${sfxBase + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `adelay=${ms}|${ms}[sx${k}]`
      );
    });
    if (sfxList.length === 1) lines.push(`[sx0]anull[sfxmix]`);
    else lines.push(`${sfxList.map((_, k) => `[sx${k}]`).join("")}amix=inputs=${sfxList.length}:normalize=0:duration=longest[sfxmix]`);
    lines.push(`[sfxmix]volume=${SFX_VOL},apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[sfxv]`);
    sfxLabel = "[sfxv]";
  }

  // --- ダッキングのキー（ナレ + セリフ） -----------------------------------
  lines.push(`[narv]asplit=2[nar_main][nar_key]`);
  if (dlgLabel) {
    lines.push(`${dlgLabel}asplit=2[dlg_main][dlg_key]`);
    lines.push(`[nar_key][dlg_key]amix=inputs=2:normalize=0:duration=longest[duckkey]`);
  } else {
    lines.push(`[nar_key]anull[duckkey]`);
  }
  lines.push(`[duckkey]asplit=2[key_amb][key_bgm]`);

  // 環境音は「ナレ中だけ −6dB 程度」（ratio を浅くして主役級を保つ）
  lines.push(`[ambv][key_amb]sidechaincompress=threshold=0.05:ratio=3.5:attack=15:release=320:makeup=1[ambduck]`);

  // --- 音: BGM ------------------------------------------------------------
  const mixIn = ["[ambduck]", "[nar_main]"];
  if (dlgLabel) mixIn.push("[dlg_main]");
  if (btnLabel) mixIn.push(btnLabel);
  if (sfxLabel) mixIn.push(sfxLabel);
  if (bgm) {
    const loop = bgm.dur < total ? `aloop=loop=-1:size=${Math.round(bgm.dur * 48000)},` : "";
    lines.push(
      `[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${loop}` +
        `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,volume=${style === "nolan" ? NOLAN_BGM_VOL : BGM_VOL},` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(3)}:d=2.5[bgmv]`
    );
    lines.push(`[bgmv][key_bgm]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350[bgmduck]`);
    mixIn.push("[bgmduck]");
  } else {
    lines.push(`[key_bgm]anullsink`);
  }

  // --- 最終段: amix → loudnorm → alimiter → stopdown 無音 → aresample -----
  // stopdown（黒＋完全無音）と telop_timing: on_silence の区間を全レーンまとめて落とす
  const gate = (plan.silences ?? [plan.silence])
    .map((sl) => `volume=enable='between(t\\,${sl.start.toFixed(3)}\\,${sl.end.toFixed(3)})':volume=0`)
    .join(",");
  lines.push(
    `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,` +
      `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      `loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.95,${gate},aresample=48000[aout]`
  );

  return lines.join(";\n");
}
