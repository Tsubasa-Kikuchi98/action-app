// モックモード（TRAILER_MOCK=1）用のポート実装。
//
// ねらいは「UI の全経路（進捗・完成・再生・履歴・エラー表示）を API 課金ゼロで検証する」こと。
// そのため **外部 API を呼ぶポートだけ**を差し替え、⑤ 合成（ffmpeg）は本物をそのまま通す。
//
//   text   → 固定の台本 JSON（normalize() を通るので script.json は本物と同じ形になる）
//   image  → ffmpeg の単色＋ノイズ PNG
//   speech → ffmpeg の低音トーン wav（文字数に比例した尺。TTS_TRIM の無音除去でも消えない）
//   video  → ffmpeg で起点画像を静止させた 1280x720 / 24fps / h264+aac の mp4（Veo の出力に合わせる）
//   music / sound → available() を false にして、既存の ffmpeg 合成音フォールバックに落とす
//
// src/ には一切手を入れない。app 層は cli 層と同じ「外側」なので adapters を直接 import してよい。
import path from "node:path";
import fs from "node:fs";
import { ROOT } from "../src/adapters/storage/env.mjs";

/** モックの中間ファイル置き場（out/_mock/）。 */
const MOCK_DIR = path.join(ROOT, "out", "_mock");

/** 各工程にわざと入れる待ち時間（ms）。UI の「実行中」表示を目視できるようにする。 */
const DELAY = Number(process.env.TRAILER_MOCK_DELAY_MS ?? 700);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 文字列から 0〜359 の色相を作る（同じプロンプトなら毎回同じ色）。 */
function hueOf(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return h % 360;
}

/** HSV → 0xRRGGBB。暗めの色に固定して「映画っぽい」プレースホルダにする。 */
function hexOf(hue, sat = 0.45, val = 0.30) {
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const i = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][i];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `0x${to(r)}${to(g)}${to(b)}`;
}

// ------------------------------------------------------------------ 台本
/** narration / dialogue（5 シーン）のダミー台本。normalize() が最終形に整える。 */
function mockScriptNarration() {
  const S = [
    {
      scene_type: "cold_open", location: "office", characters: ["hero"],
      narration: "その日、すべてはいつもどおりだった……",
      telop: "平穏な午後", dialogue: "", speaker: "none",
      visual_metaphor: "静かなオフィス＝嵐の前の静けさ",
      camera_beat: "slow dolly in", motion_beat: "モニタの光だけが揺れる",
      ambient: "空調の低い唸り", duration_sec: 6, cut_count: 2,
      telop_timing: "after_narration", screen_text: ["14:58"],
    },
    {
      scene_type: "setup", location: "meeting", characters: ["hero", "senpai"],
      narration: "たった一行の設定が、すべてを飲み込む。",
      telop: "本番、停止", dialogue: "", speaker: "none",
      visual_metaphor: "設定ミス＝石板の崩落",
      camera_beat: "handheld push", motion_beat: "全員が一斉に立ち上がる",
      ambient: "椅子が倒れる音", duration_sec: 4, cut_count: 3,
      telop_timing: "cut_head", screen_text: [],
    },
    {
      scene_type: "turn", location: "server", characters: ["hero"],
      narration: "", telop: "残り 30 分", dialogue: "戻せない……!", speaker: "hero",
      visual_metaphor: "ロールバック不能＝閉じる隔壁",
      camera_beat: "whip pan", motion_beat: "赤色灯が回りはじめる",
      ambient: "警報のブザー", duration_sec: 4, cut_count: 4,
      telop_timing: "cut_head", screen_text: [],
    },
    {
      scene_type: "montage", location: "corridor", characters: ["hero", "senpai", "boss"],
      narration: "", telop: "全員、出る", dialogue: "行くぞ、走れ!", speaker: "boss",
      visual_metaphor: "復旧作業＝部隊の突入",
      camera_beat: "tracking run", motion_beat: "三人が廊下を駆け抜ける",
      ambient: "足音と非常灯のノイズ", duration_sec: 6, cut_count: 5,
      telop_timing: "cut_head", screen_text: [],
    },
    {
      scene_type: "resolve", location: "home", characters: ["hero"],
      narration: "この失敗は、まだ終わっていない……",
      telop: "そして、朝が来る", dialogue: "", speaker: "none",
      visual_metaphor: "終わらない対応＝明けない夜",
      camera_beat: "static wide", motion_beat: "窓の外がゆっくり白む",
      ambient: "雨音", duration_sec: 4, cut_count: 2,
      telop_timing: "on_silence", screen_text: [],
    },
  ];
  return {
    title: "デプロイ・ゼロアワー",
    tagline: "その一行が、夜を壊した",
    presents: "IFTC 提供",
    review_line: "全社が震えた",
    stake: "残り 30 分",
    button_line: "……で、誰が押した?",
    release_line: "近日公開",
    style: "narration",
    cast_lines: ["主人公", "先輩", "上司"],
    interstitials: [
      { text: "誰も気づかなかった", after_scene: 1 },
      { text: "取り戻せるか", after_scene: 3 },
    ],
    scenes: S.map((s, i) => ({
      ...s,
      index: i + 1,
      image_prompt: `MOCK image prompt for scene ${i + 1} (${s.scene_type})`,
      video_prompt: `MOCK video prompt for scene ${i + 1} (${s.scene_type})`,
    })),
  };
}

/** nolan（3 シーン・ナレなし・セリフは Veo が喋る）のダミー台本。 */
function mockScriptNolan() {
  const S = [
    {
      scene_type: "discover", location: "office", characters: ["senpai"],
      dialogue: "……止まってる", speaker: "senpai",
      visual_metaphor: "障害の発覚＝計器の沈黙",
      camera_beat: "slow push in", motion_beat: "先輩がモニタから顔を上げる",
      ambient: "空調とファンの低音", duration_sec: 3,
    },
    {
      scene_type: "struggle", location: "server", characters: ["hero"],
      dialogue: "戻せない", speaker: "hero",
      visual_metaphor: "ロールバック不能＝閉じる扉",
      camera_beat: "handheld", motion_beat: "主人公がラックの前で立ち尽くす",
      ambient: "サーバーの唸り", duration_sec: 4,
    },
    {
      scene_type: "mobilize", location: "meeting", characters: ["boss"],
      dialogue: "全員、集めろ", speaker: "boss",
      visual_metaphor: "招集＝作戦会議",
      camera_beat: "static wide", motion_beat: "上司が受話器を置く",
      ambient: "遠い電話の呼び出し音", duration_sec: 3,
    },
  ];
  return {
    title: "ゼロアワー",
    tagline: "夜は長い",
    presents: "IFTC 提供",
    review_line: "",
    stake: "",
    button_line: "",
    release_line: "近日公開",
    style: "nolan",
    cast_lines: [],
    interstitials: [
      { text: "誰も、気づかなかった", after_scene: 1 },
      { text: "夜が、始まる", after_scene: 2 },
    ],
    scenes: S.map((s, i) => ({
      ...s,
      index: i + 1,
      narration: "",
      telop: "",
      cut_count: 1,
      telop_timing: "cut_head",
      screen_text: [],
      image_prompt: `MOCK image prompt for nolan cut ${i + 1} (${s.scene_type})`,
      video_prompt: `MOCK video prompt for nolan cut ${i + 1} (${s.scene_type})`,
    })),
  };
}

/** TextGenerator ポートのモック。schemaName を見ず、style だけで固定 JSON を返す。 */
export function mockTextGenerator() {
  return {
    async createStructured({ model, user }) {
      await sleep(DELAY);
      const nolan = /style:\s*nolan/.test(user ?? "");
      const data = nolan ? mockScriptNolan() : mockScriptNarration();
      return {
        text: JSON.stringify(data),
        usage: { input_tokens: 0, output_tokens: 0 },
        model,
        raw: { mock: true },
      };
    },
  };
}

// ------------------------------------------------------------------ 画像
/** ImageGenerator ポートのモック（generations / edits とも単色＋ノイズの PNG）。 */
export function mockImageGenerator(media) {
  const make = async ({ prompt, size = "1536x1024" }) => {
    await sleep(DELAY);
    fs.mkdirSync(MOCK_DIR, { recursive: true });
    const [w, h] = String(size).split("x").map(Number);
    const color = hexOf(hueOf(prompt));
    const out = path.join(MOCK_DIR, `img_${w}x${h}_${color.slice(2)}.png`);
    if (!fs.existsSync(out)) {
      await media.ffmpeg([
        "-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`,
        "-vf", "noise=alls=10:allf=t+u,vignette",
        "-frames:v", "1", "-update", "1",
        out,
      ]);
    }
    return { buffer: fs.readFileSync(out), usage: { images: 1, mock: true } };
  };
  return { generate: make, edit: make };
}

// ------------------------------------------------------------------ 音声
/** SpeechGenerator ポートのモック。文字数に比例した尺の低音トーン wav を返す。 */
export function mockSpeechGenerator(media) {
  return {
    async speak({ text = "" }) {
      await sleep(Math.min(DELAY, 400));
      fs.mkdirSync(MOCK_DIR, { recursive: true });
      const sec = Math.max(1.0, Math.min(8, text.length * 0.16 + 0.4));
      const out = path.join(MOCK_DIR, `tts_${sec.toFixed(2)}.wav`);
      if (!fs.existsSync(out)) {
        // 無音だと TTS_TRIM の silenceremove で全部消えるので、必ず鳴らす。
        const src =
          `aevalsrc='0.35*sin(2*PI*190*t)*(0.60+0.40*sin(2*PI*4.5*t))':s=24000:d=${sec.toFixed(2)}`;
        await media.ffmpeg(["-f", "lavfi", "-i", src, "-c:a", "pcm_s16le", out]);
      }
      return fs.readFileSync(out);
    },
  };
}

// ------------------------------------------------------------------ 動画
/**
 * VideoGenerator ポートのモック。
 * 起点画像（generateVideos が 1280x720 にクロップ済み）を静止させた mp4 を作る。
 * Veo の実出力に合わせて 1280x720 / 24fps / h264 + aac 48kHz stereo にする。
 */
export function mockVideoGenerator(media) {
  return {
    async generate({ imagePath, out, config = {}, onSubmit = () => {} }) {
      const dur = Number(config.durationSeconds ?? 4);
      onSubmit({ name: "mock/operation" });
      await sleep(DELAY * 2);
      // 環境音レーンの正規化（probeVolume の mean dBFS）が -inf にならないよう、
      // 無音ではなく微小なブラウンノイズを入れる。
      const noise = `anoisesrc=color=brown:sample_rate=48000:amplitude=0.06:duration=${dur}`;
      await media.ffmpeg([
        "-loop", "1", "-t", String(dur), "-i", imagePath,
        "-f", "lavfi", "-t", String(dur), "-i", noise,
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-af", "aformat=sample_fmts=fltp:channel_layouts=stereo",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-t", String(dur), "-shortest",
        out,
      ]);
      return { path: out, polls: 1 };
    },
  };
}

/** ElevenLabs 系（BGM / 効果音）は available() を false にして ffmpeg 合成音に落とす。 */
export const mockUnavailable = { available: () => false };

/**
 * createDeps() が組んだ依存の「外部 API を呼ぶポート」だけをモックに差し替える。
 * store / media / files / refs（＝ローカルの FS と ffmpeg）はそのまま本物を使う。
 */
export function applyMocks(deps) {
  const text = mockTextGenerator();
  const image = mockImageGenerator(deps.media);
  const speech = mockSpeechGenerator(deps.media);
  const video = mockVideoGenerator(deps.media);

  deps.script.text = text;
  deps.refsUseCase.image = image;
  deps.image.image = image;
  deps.speech.speech = speech;
  deps.video.video = video;
  deps.bgm.music = mockUnavailable;
  deps.sfx.sound = mockUnavailable;
  return deps;
}
