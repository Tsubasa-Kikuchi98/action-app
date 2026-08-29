// 台本（script.json）の型を JSDoc typedef で明示する。実行時の値は持たない型専用モジュール。
// JS なのでコンパイラの検査は入らないが、ポート（usecases が受け取る依存）の
// 契約をここに 1 箇所で書いておくことで、adapters 側の実装漏れを読み取れるようにする。

/**
 * @typedef {"cold_open"|"setup"|"turn"|"montage"|"resolve"} SceneType
 * @typedef {"cut_head"|"after_narration"|"on_silence"} TelopTiming
 * @typedef {"narration"|"dialogue"} TrailerStyle
 * @typedef {"none"|"hero"|"senpai"|"boss"} Speaker
 * @typedef {"office"|"meeting"|"server"|"corridor"|"home"} LocationKey
 */

/**
 * @typedef {object} Scene
 * @property {number} index                1 始まりのシーン番号
 * @property {string} narration            ナレーション（空文字可）
 * @property {string} telop                画面下部のテロップ
 * @property {string} image_prompt         英語の画像生成プロンプト
 * @property {string} video_prompt         英語の動画生成プロンプト
 * @property {number} duration_sec         シーン尺（4 / 6 / 8）
 * @property {SceneType} scene_type
 * @property {LocationKey} location
 * @property {number} cut_count            カット割り数
 * @property {string} visual_metaphor      「現実 → 演出」の翻訳 1 行
 * @property {string} motion_beat          英語・力の動詞 1 つ
 * @property {string} camera_beat          英語・Veo のカメラ語彙 1 つ
 * @property {string} ambient              英語・環境音
 * @property {string} dialogue             決め台詞（空文字可）
 * @property {Speaker} speaker
 * @property {string[]} characters         画面に映る主要人物
 * @property {TelopTiming} telop_timing
 * @property {string[]} screen_text        画面内の小テロップ
 * @property {"video"|"still"} [motion]    video.mjs が書き戻す
 * @property {string} [motion_reason]      still に落ちた理由
 * @property {number} [clip_sec]           Veo クリップの実尺
 * @property {number} [nar_sec]            ナレ wav の実尺
 * @property {number} [dlg_sec]            セリフ wav の実尺
 * @property {number} [base_sec]           丸める前のシーン尺
 */

/**
 * @typedef {object} Interstitial
 * @property {string} text
 * @property {number} after_scene
 */

/**
 * @typedef {object} Script
 * @property {string} title
 * @property {string} tagline
 * @property {string} presents
 * @property {string} review_line
 * @property {string} stake
 * @property {string} button_line          （廃止・常に空文字）
 * @property {TrailerStyle} style
 * @property {string} release_line
 * @property {string[]} cast_lines
 * @property {Interstitial[]} interstitials
 * @property {Scene[]} scenes
 * @property {string} [episode]
 * @property {string} [model]
 * @property {string} [created_at]
 * @property {boolean} [enriched]
 */

// ---------------------------------------------------------------- ポート
// usecases が引数（deps）で受け取る依存の形。adapters/ がこれを実装する。

/**
 * @typedef {object} TextGenerator                Structured Outputs のテキスト生成
 * @property {(req: {model: string, system: string, user: string, schemaName: string, schema: object}) => Promise<{text: string, usage: object, model: string}>} createStructured
 */

/**
 * @typedef {object} ImageGenerator
 * @property {(req: {model: string, prompt: string, size: string, quality: string}) => Promise<Buffer>} generate
 * @property {(req: {model: string, prompt: string, images: string[], size: string, quality: string}) => Promise<Buffer>} edit
 */

/**
 * @typedef {object} SpeechGenerator
 * @property {(req: {model: string, voice: string, text: string, instructions: string, speed: number}) => Promise<Buffer>} speak
 */

/**
 * @typedef {object} VideoGenerator
 * @property {(req: {model: string, prompt: string, imagePath: string, config: object, timeoutSec: number, onSubmit?: Function, onPollError?: Function}) => Promise<{path: string, polls: number}>} generate
 */

/**
 * @typedef {object} JobStore                     out/<job>/ の読み書きとログ
 * @property {(job: string) => object} paths
 * @property {(job: string, ...keys: string[]) => object} ensureDirs
 * @property {(job: string) => Script} readScript
 * @property {(job: string, data: Script) => void} writeScript
 * @property {(job: string, entry: object) => void} logEvent
 * @property {(job: string, step: string, fn: Function, meta?: object) => Promise<object>} timed
 * @property {(job: string) => {totalCost: number, totalSec: number, rows: object[]}} summarizeLog
 */

/**
 * @typedef {object} MediaTool                    ffmpeg / ffprobe
 * @property {(args: string[]) => Promise<object>} ffmpeg
 * @property {(file: string) => Promise<number>} probeDuration
 * @property {(file: string) => Promise<object>} probeSummary
 * @property {(file: string, opts?: object) => Promise<{mean: number, max: number}|null>} probeVolume
 */

export {};
