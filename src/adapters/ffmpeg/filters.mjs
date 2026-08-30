// filter_complex を「ファイルに書いて ffmpeg に渡す」部分（I/O が要るところ）。
// 文字列そのものの組み立ては domain/timeline/filters.mjs（純関数）。
//
// CLAUDE.md: -filter_complex_script は ffmpeg 9 で削除済み → `-/filter_complex fc.txt`。
// ファイル内でもエスケープ規則は同じ。パスは ROOT からの相対にして `:` の事故を避ける。
import fs from "node:fs";
import path from "node:path";
import { rel } from "../storage/env.mjs";
import { ffmpeg } from "./exec.mjs";
import { W, H, FPS } from "../../domain/timeline/constants.mjs";
import { buildCutFilter, buildComposeFilter } from "../../domain/timeline/filters.mjs";

/** filter_complex をファイルに書いて、その相対パスを返す。 */
export function writeFilterFile(file, fc) {
  fs.writeFileSync(file, fc, "utf8");
  return rel(file);
}

const CUT_ENC = [
  "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2",
];

/** 1 カットを out/<job>/cuts/cNNN.mp4 に書き出す。 */
export async function renderCut(cutsDir, seg, k) {
  const tag = String(k).padStart(3, "0");
  const out = path.join(cutsDir, `c${tag}.mp4`);
  const fcRel = writeFilterFile(path.join(cutsDir, `fc_c${tag}.txt`), buildCutFilter(seg));
  const dur = seg.outSec;

  if (seg.kind === "card") {
    await ffmpeg([
      "-f", "lavfi", "-i", `color=c=${seg.color}:s=${W}x${H}:r=${FPS}:d=${(dur + 0.2).toFixed(3)}`,
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.2).toFixed(3)}`,
      "-/filter_complex", fcRel,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
    return out;
  }

  if (seg.kind === "still") {
    await ffmpeg([
      "-loop", "1", "-t", (dur + 0.3).toFixed(3), "-i", rel(seg.img),
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.3).toFixed(3)}`,
      "-/filter_complex", fcRel,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
    return out;
  }

  // --- video ---------------------------------------------------------------
  if (seg.hasAudio) {
    await ffmpeg([
      "-i", rel(seg.src),
      "-/filter_complex", fcRel,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
  } else {
    await ffmpeg([
      "-i", rel(seg.src),
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${(dur + 0.3).toFixed(3)}`,
      "-/filter_complex", fcRel,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...CUT_ENC, rel(out),
    ]);
  }
  return out;
}

/**
 * 最終 1 パスの合成。入力は [カット][ナレ][セリフ][button][SFX][BGM] の順に並べる。
 * @param {{plan: object, cutFiles: string[], assPath: string, fcPath: string, bgm: {file: string, dur: number}|null, out: string}} args
 */
export async function composeFinal({ plan, cutFiles, assPath, fcPath, bgm, out }) {
  const fc = buildComposeFilter(plan, {
    cutCount: cutFiles.length,
    assRel: rel(assPath),
    bgm: bgm ? { dur: bgm.dur } : null,
  });
  const fcRel = writeFilterFile(fcPath, fc);

  const args = [];
  for (const c of cutFiles) args.push("-i", rel(c));
  for (const e of plan.nar) args.push("-i", rel(e.file));
  for (const e of plan.dlg) args.push("-i", rel(e.file));
  for (const e of plan.btn) args.push("-i", rel(e.file));
  for (const e of plan.sfx ?? []) args.push("-i", rel(e.file));
  if (bgm) args.push("-i", rel(bgm.file));
  args.push(
    "-/filter_complex", fcRel,
    "-map", "[v]", "-map", "[aout]",
    "-t", plan.total.toFixed(3),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    rel(out)
  );
  await ffmpeg(args);
  return out;
}
