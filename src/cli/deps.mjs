// 依存の組み立て（composition root）。
// adapters の実装をポートの形に束ねて usecases に渡す。ここだけが両方を知っている。
import path from "node:path";
import { ROOT, rel, MODELS } from "../adapters/storage/env.mjs";
import * as jobStore from "../adapters/storage/jobStore.mjs";
import * as refsStore from "../adapters/storage/refsStore.mjs";
import { fileStore } from "../adapters/storage/files.mjs";
import * as ffmpegExec from "../adapters/ffmpeg/exec.mjs";
import * as ffmpegFilters from "../adapters/ffmpeg/filters.mjs";
import { writeAss } from "../adapters/ffmpeg/ass.mjs";
import { textGenerator } from "../adapters/openai/text.mjs";
import { imageGenerator } from "../adapters/openai/image.mjs";
import { speechGenerator } from "../adapters/openai/tts.mjs";
import { videoGenerator } from "../adapters/gemini/veo.mjs";
import { soundGenerator } from "../adapters/elevenlabs/sfx.mjs";
import { musicGenerator } from "../adapters/elevenlabs/music.mjs";

export { ROOT, rel, MODELS };

/** JobStore ポート。 */
export const store = {
  paths: jobStore.jobPaths,
  ensureDirs: jobStore.ensureDirs,
  readScript: jobStore.readScript,
  writeScript: jobStore.writeScript,
  logEvent: jobStore.logEvent,
  timed: jobStore.timed,
  summarizeLog: jobStore.summarizeLog,
};

/** MediaTool ポート。 */
export const media = {
  ffmpeg: ffmpegExec.ffmpeg,
  probeDuration: ffmpegExec.probeDuration,
  probeSummary: ffmpegExec.probeSummary,
  probeVolume: ffmpegExec.probeVolume,
  probeLevels: ffmpegExec.probeLevels,
};

/** FileStore ポート（usecases はこれ経由でだけファイルに触る）。 */
export const files = fileStore;

/** 基準画像ストア。 */
export const refs = {
  charRefPath: refsStore.charRefPath,
  locRefPath: refsStore.locRefPath,
  exists: refsStore.exists,
  write: refsStore.writeRef,
  sceneRefs: refsStore.sceneRefs,
  refsNeededForScript: refsStore.refsNeededForScript,
};

/**
 * 全 usecase 分の依存をまとめて作る。
 * usecase ごとに必要な形（deps.script / deps.image / …）に束ねてある。
 */
export function createDeps() {
  const bgmDir = path.join(ROOT, "assets", "bgm");
  const sfxDir = path.join(ROOT, "assets", "sfx");
  return {
    store,
    media,
    refs,
    files,

    // ① 台本 / ①' 演出
    script: { text: textGenerator, store, model: MODELS.script },

    // ⓪ 基準画像
    refsUseCase: {
      image: imageGenerator, store, refs, files, root: ROOT, job: refsStore.REFS_JOB,
      model: MODELS.image, quality: refsStore.REFS_QUALITY, size: refsStore.REFS_SIZE,
    },

    // ② 画像
    image: { image: imageGenerator, store, refs, files, model: MODELS.image },

    // ③' ナレーション・セリフ
    speech: { speech: speechGenerator, store, media, files, model: MODELS.tts },

    // ③ 動画（Veo）
    video: { video: videoGenerator, store, media, files, model: MODELS.video },

    // ④ BGM
    bgm: { store, media, files, music: musicGenerator, bgmDir },

    // ⑥ 効果音（ブラーム。assets/sfx/ にジョブ横断で置く）
    sfx: { sound: soundGenerator, store, media, files, sfxDir },

    // ⑤ 合成
    render: {
      store,
      media,
      files,
      rel,
      sfxDir,
      ffmpegRender: {
        writeAss,
        renderCut: ffmpegFilters.renderCut,
        composeFinal: ffmpegFilters.composeFinal,
      },
    },
  };
}
