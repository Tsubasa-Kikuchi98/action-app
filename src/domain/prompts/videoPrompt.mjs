// Veo（image-to-video）に渡す motion-first プロンプトの組み立て（純関数）。
//
// Phase 3 / quality-research §B: 起点画像に写っているもの（外見・色調・レンズ）は再記述しない。
// 「被写体 / カメラ / 環境」を各 1 つ、動きは 1〜2 種に絞ると Veo がよく動く。
//
//   <camera_beat>. <motion_beat>. Secondary motion: <env_beat>.
//   The scene keeps the exact lighting, color and framing of the source image.
//   Ambient noise: <ambient>.
//   （dialogue があるシーンだけ）The character says: "<セリフ>".
//   （dialogue が無いシーン）The scene is wordless and no one speaks; only ambient sound is heard.
//
// 引用符は**セリフにだけ**使う（Veo は引用符の中身を発話として解釈する。公式ガイド）。
import { DEFAULT_CAMERA_BEAT } from "../script/constants.mjs";
import { castDescription } from "../cast.mjs";

/** scene_type 別のカメラ既定値（camera_beat が空のときのフォールバック）。 */
export const CAMERA_FALLBACK = DEFAULT_CAMERA_BEAT;

/** scene_type 別の二次的な動き（背景・環境側の動き）。 */
export const ENV_BEAT = {
  cold_open: "dust drifting through the light, faint flicker on distant screens",
  setup: "papers stirring, reflections sliding across glass",
  turn: "warning light pulsing, shadows sweeping past",
  montage: "sparks and steam crossing frame, silhouettes moving in the background",
  resolve: "slow-moving haze, first light spreading across the room",
  // nolan: 背景の動きも静か。空気とわずかな光の変化だけ。
  discover: "faint reflections shifting on the glass, a cursor blinking on a distant screen",
  struggle: "cooling fans breathing, a thin haze drifting through the monitor light",
  mobilize: "the corridor lights holding steady, a door swinging slowly behind him",
};

/** nolan で全カットに固定で足す撮り方の指定（カメラは静か・文字は出さない）。 */
export const NOLAN_STYLE_LINE =
  "Filmed in the restrained style of a Christopher Nolan trailer: the camera is quiet and almost static " +
  "(locked-off tripod or a very slow dolly), the framing is a wide symmetrical composition with the subject centred, " +
  "and the light comes only from sources visible in the frame. " +
  "No handheld shake, no zoom, no whip pan, no lens flare bursts, no on-screen text or subtitles.";

/** 環境音が台本に無いときのフォールバック。 */
export const AMBIENT_FALLBACK = "low room tone and distant machinery";

/** config.negativePrompt に送る文字列（VEO_NEGATIVE_PROMPT=on のときだけ使用。Lite は 400）。 */
export const VEO_NEGATIVE_PROMPT = "subtitles, on-screen text, captions, logo, watermark";

const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export const speakerLabel = (sp) =>
  ({ hero: "The young man (the protagonist)", senpai: "The woman in the navy blazer (the senior colleague)", boss: "The older man in the dark suit (the boss)" })[sp] ?? "The character";

/**
 * scene から Veo に渡す最終プロンプトを組み立てる（motion-first）。
 * enrich 済みなら camera_beat / motion_beat / ambient / dialogue を使い、
 * 旧 script.json（Phase 1/2）では video_prompt / image_prompt にフォールバックする。
 */
export function buildVideoPrompt(scene, style = "narration") {
  const type = scene.scene_type ?? "setup";
  const camera = (scene.camera_beat ?? "").trim() || CAMERA_FALLBACK[type] || CAMERA_FALLBACK.setup;
  const motion = (scene.motion_beat ?? "").trim();
  const env = ENV_BEAT[type] ?? ENV_BEAT.setup;
  const ambient = (scene.ambient ?? "").trim() || AMBIENT_FALLBACK;
  const dialogue = (scene.dialogue ?? "").trim();

  // Phase 3（コンセプト版）: visual_metaphor（例「本番 DB 削除 → サーバーラックの連鎖爆発」）が
  // 「どのアクション演出に翻訳したか」を持ち、motion_beat / image_prompt はそれに沿って書かれている。
  // Veo に渡すのは英語のみなので、ここでは motion_beat をそのまま使い、
  // 無い旧台本だけ video_prompt / image_prompt から動きを拾う（--dry-run で翻訳を目視確認する）。
  const cast = castDescription(scene.characters);
  const castLine = cast ? ` The people on screen are ${cast}; keep their faces, hair and clothing exactly as in the source image.` : "";
  const action =
    motion ||
    scene.video_prompt?.trim() ||
    `${scene.image_prompt?.trim() ?? ""} The subject moves decisively within the frame.`;

  const lines = [
    `${cap(camera)}.`,
    `${cap(action)}${/[.!?]$/.test(action) ? "" : "."}`,
    `Secondary motion: ${env}.`,
    `The scene keeps the exact lighting, color and framing of the source image.${castLine}`,
    `Ambient noise: ${ambient}.`,
  ];
  if (style === "nolan") {
    // nolan はセリフを Veo に口パクで喋らせる（TTS で後から重ねない）ので、
    // 「誰が・何を・口元が見える形で」言うのかを最後に 1 文で置く。
    lines.push(NOLAN_STYLE_LINE);
    lines.push(
      dialogue
        ? `${speakerLabel(scene.speaker)} says in English: "${dialogue}". ` +
          `Their face is turned toward the camera and their mouth is clearly visible while they speak. ` +
          `No one else speaks or moves their lips, and there is no narration.`
        : `The scene is wordless and no one speaks; only ambient sound is heard.`
    );
    return lines.join(" ");
  }
  lines.push(
    dialogue
      ? `${speakerLabel(scene.speaker)} speaks one short line in English: "${dialogue}". Nobody else speaks.`
      : `The scene is wordless and no one speaks; only ambient sound is heard.`
  );
  return lines.join(" ");
}

/**
 * 生成を依頼する秒数。Phase 3 からは台本の尺ではなく VEO_GEN_SEC（既定 8）を使い、
 * 使うのは前半 4〜6 秒だけにする（後半の破綻を捨てる）。
 * VEO_MAX_SEC でクランプ、VEO_GEN_SEC=fit にすると従来どおり台本の尺に合わせる。
 */
export const VEO_GEN_SEC = Number(process.env.VEO_GEN_SEC ?? 8);

export function veoDuration(sec) {
  const max = Number(process.env.VEO_MAX_SEC ?? 8);
  const steps = [4, 6, 8].filter((v) => v <= max);
  if ((process.env.VEO_GEN_SEC ?? "").toLowerCase() === "fit") {
    return steps.find((v) => v >= sec - 1e-6) ?? steps[steps.length - 1];
  }
  return steps.find((v) => v >= VEO_GEN_SEC - 1e-6) ?? steps[steps.length - 1];
}
