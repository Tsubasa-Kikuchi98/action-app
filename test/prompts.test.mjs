// domain/prompts と domain/script/lint のユニットテスト。
import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoPrompt, veoDuration, ENV_BEAT } from "../src/domain/prompts/videoPrompt.mjs";
import { buildEditPrompt, buildGeneratePrompt, STYLE_SUFFIX } from "../src/domain/prompts/imagePrompt.mjs";
import { validateSchema, SCRIPT_SCHEMA, buildScriptSystemPrompt } from "../src/domain/prompts/scriptPrompt.mjs";
import { ENRICH_SCHEMA } from "../src/domain/prompts/enrichPrompt.mjs";
import { lintScript } from "../src/domain/script/lint.mjs";
import { roundSceneSec } from "../src/domain/script/rounding.mjs";
import { CAST } from "../src/domain/cast.mjs";

const base = {
  scene_type: "turn",
  camera_beat: "low-angle tracking shot",
  motion_beat: "slams a fist on the desk",
  ambient: "server fans, alarm",
  dialogue: "",
  speaker: "none",
  characters: [],
  video_prompt: "",
  image_prompt: "",
};

test("buildVideoPrompt: camera → motion → env → ambient の順で 1 文ずつ", () => {
  const p = buildVideoPrompt(base);
  assert.ok(p.startsWith("Low-angle tracking shot. Slams a fist on the desk."), p.slice(0, 80));
  assert.ok(p.includes(`Secondary motion: ${ENV_BEAT.turn}.`));
  assert.ok(p.includes("Ambient noise: server fans, alarm."));
  assert.ok(p.includes("The scene is wordless and no one speaks"));
});

test("buildVideoPrompt: セリフがあると話者ラベル付きの引用符行になる", () => {
  const p = buildVideoPrompt({ ...base, dialogue: "まだ終わってない", speaker: "hero" });
  assert.ok(p.includes('The young man (the protagonist) speaks one short line in Japanese: "まだ終わってない". Nobody else speaks.'));
  assert.ok(!p.includes("wordless"));
  // 話者ごとにラベルが変わる
  assert.ok(buildVideoPrompt({ ...base, dialogue: "全員、動け", speaker: "boss" }).includes("The older man in the dark suit (the boss)"));
  assert.ok(buildVideoPrompt({ ...base, dialogue: "気づいた", speaker: "senpai" }).includes("The woman in the navy blazer (the senior colleague)"));
});

test("buildVideoPrompt: characters があると castLine が入る", () => {
  const p = buildVideoPrompt({ ...base, characters: ["hero", "boss"] });
  assert.ok(p.includes(`The people on screen are ${CAST.hero.en}; ${CAST.boss.en};`));
  assert.ok(p.includes("keep their faces, hair and clothing exactly as in the source image."));
  // characters が空なら castLine は入らない
  assert.ok(!buildVideoPrompt(base).includes("The people on screen are"));
});

test("buildVideoPrompt: 旧台本（motion_beat なし）は video_prompt にフォールバックする", () => {
  const p = buildVideoPrompt({ ...base, motion_beat: "", video_prompt: "the camera pushes past the rack" });
  assert.ok(p.includes("The camera pushes past the rack."));
  // camera_beat も無ければ scene_type の既定を使う
  const q = buildVideoPrompt({ ...base, camera_beat: "", motion_beat: "", video_prompt: "moves" });
  assert.ok(q.startsWith("Low-angle tracking shot, shallow depth of field."));
});

test("veoDuration / roundSceneSec は 4 / 6 / 8 に丸める", () => {
  assert.equal(veoDuration(4), 8, "VEO_GEN_SEC 既定 8 なので常に 8");
  assert.equal(roundSceneSec(0.5), 4);
  assert.equal(roundSceneSec(4), 4);
  assert.equal(roundSceneSec(4.01), 6);
  assert.equal(roundSceneSec(6), 6);
  assert.equal(roundSceneSec(7.2), 8);
  assert.equal(roundSceneSec(99), 8, "上限でクランプ");
});

test("画像プロンプト: 参照ありは順序を明示、参照なしは外見をテキストで指定", () => {
  const scene = { image_prompt: "a man bolts down the corridor", characters: ["hero"] };
  const edit = buildEditPrompt(scene, { chars: ["hero"], loc: "corridor", files: ["a", "b"] });
  assert.ok(edit.startsWith("Reference images, in this order:"));
  assert.ok(edit.includes("a character sheet (three views of the same person)"));
  assert.ok(edit.includes("a location plate of"));
  assert.ok(edit.endsWith(STYLE_SUFFIX));

  const gen = buildGeneratePrompt(scene);
  assert.ok(gen.startsWith("a man bolts down the corridor."));
  assert.ok(gen.includes("Characters (keep exactly this appearance):"));
  assert.ok(gen.endsWith(STYLE_SUFFIX));
});

test("両スキーマとも Structured Outputs の strict モードで使える形", () => {
  assert.deepEqual(validateSchema(SCRIPT_SCHEMA), []);
  assert.deepEqual(validateSchema(ENRICH_SCHEMA), []);
});

test("validateSchema は strict 違反を検出する", () => {
  assert.ok(validateSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })
    .some((e) => e.includes("additionalProperties")));
  assert.ok(validateSchema({ type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: [] })
    .some((e) => e.includes("required に a が無い")));
  assert.ok(validateSchema({ type: "array", minItems: 5, items: { type: "string" } })
    .some((e) => e.includes("minItems")));
});

test("システムプロンプトは style で構成ブロックが切り替わる", () => {
  const a = buildScriptSystemPrompt("narration");
  const b = buildScriptSystemPrompt("dialogue");
  assert.ok(a.includes("案 A: ナレーション主導"));
  assert.ok(b.includes("案 B: セリフ・テロップ主導"));
  assert.ok(a.includes('style: "narration"'));
  assert.ok(b.includes('style: "dialogue"'));
});

/** lint 用の最小構成の台本。 */
const lintable = (over = {}) => ({
  title: "深夜の障害対応",
  tagline: "夜明けは、来るのか。",
  presents: "情シス PRESENTS",
  release_line: "近日公開",
  button_line: "",
  review_line: "情シスが泣いた",
  stake: "残された時間は 3 分",
  style: "narration",
  cast_lines: ["主演 情シス"],
  interstitials: [{ text: "この夏、", after_scene: 2 }, { text: "賭け", after_scene: 3 }],
  scenes: ["cold_open", "setup", "turn", "montage", "resolve"].map((t, i) => ({
    index: i + 1,
    scene_type: t,
    narration: i === 2 || i === 3 ? "" : "その日……",
    telop: `テロップ${i}`,
    dialogue: i === 2 || i === 3 ? "行くぞ" : "",
    visual_metaphor: "現実 → 演出",
    duration_sec: [6, 4, 4, 6, 4][i],
  })),
  ...over,
});

test("lintScript: 問題のない台本では警告が出ない", () => {
  assert.deepEqual(lintScript(lintable()), []);
});

test("lintScript: 禁句を検出する", () => {
  const w = lintScript(lintable({ title: "感動の障害対応" }));
  assert.ok(w.some((x) => x.includes("禁句") && x.includes("感動")), w.join(" / "));
});

test("lintScript: stake の数字欠落・テロップ重複・尺の逸脱を検出する", () => {
  const d = lintable({ stake: "残された時間はわずか" });
  d.scenes[1].telop = d.scenes[0].telop;          // 重複
  d.scenes[0].duration_sec = 8;                    // 合計 24 → 想定内
  d.scenes[3].duration_sec = 8;                    // 合計 28 → 逸脱
  const w = lintScript(d);
  assert.ok(w.some((x) => x.includes("stake に数字がありません")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("同じテロップが 2 回")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("映像の合計尺")), w.join(" / "));
});

test("lintScript: ナレ合計字数・セリフ本数・visual_metaphor の形を見る", () => {
  const d = lintable();
  for (const s of d.scenes) s.narration = "あ".repeat(30);
  d.scenes[2].dialogue = "";
  d.scenes[3].dialogue = "";
  d.scenes[0].visual_metaphor = "矢印がない翻訳";
  const w = lintScript(d);
  assert.ok(w.some((x) => x.includes("ナレ合計")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("セリフが 0 本")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("「現実 → 演出」の形になっていない")), w.join(" / "));
});
