// シーン尺の丸め（純関数）。Phase 2: Veo が受け付ける尺は 4 / 6 / 8 秒のみ。
// ナレ実尺 + 余白をこの中に丸め上げる。SCENE_ROUND=off で Phase 1 相当の連続値に戻す。
import { VEO_STEPS } from "./constants.mjs";

export { VEO_STEPS };

/** ナレ後の余白（秒）。シーン尺はこの分だけナレより長くする。 */
export const TAIL_PAD = 0.6;

export const roundingEnabled = () => (process.env.SCENE_ROUND ?? "on").toLowerCase() !== "off";

/** sec 以上で最小の許容尺を返す（超過分は最大値でクランプ）。 */
export function roundSceneSec(sec) {
  const max = Number(process.env.VEO_MAX_SEC ?? VEO_STEPS[VEO_STEPS.length - 1]);
  const steps = VEO_STEPS.filter((v) => v <= max);
  return steps.find((v) => v >= sec - 1e-6) ?? steps[steps.length - 1];
}
