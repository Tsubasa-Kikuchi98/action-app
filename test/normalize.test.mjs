// domain/script/normalize.mjs のユニットテスト（API は呼ばない・純関数のみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/domain/script/normalize.mjs";

/** テスト用のシーン 1 件。 */
const scene = (over = {}) => ({
  narration: "その日……すべては静かに始まった。",
  telop: "その日、",
  image_prompt: "a wide shot",
  video_prompt: "dolly in",
  duration_sec: 4,
  scene_type: "cold_open",
  location: "office",
  cut_count: 1,
  visual_metaphor: "退勤 → 背後で火花",
  motion_beat: "bolts",
  camera_beat: "dolly in",
  ambient: "server fans",
  dialogue: "",
  speaker: "none",
  characters: ["hero"],
  telop_timing: "after_narration",
  screen_text: [],
  ...over,
});

const raw = (types, over = {}) => ({
  title: "無題",
  scenes: types.map((t) => scene({ scene_type: t })),
  ...over,
});

const opts = { model: "test-model", createdAt: "2026-01-01T00:00:00.000Z", warn: () => {} };
const run = (data, style = "narration") => normalize(data, "エピソード", style, opts);

// 排他ルール（2026-08-30 修正済み）: turn / montage はセリフ優先でナレを空にし、
// cold_open / setup / resolve はナレ優先でセリフを空にする。
test("turn / montage はセリフを必ず残す（セリフ優先）", () => {
  const withDlg = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  withDlg.scenes[2].dialogue = "まだ終わってない";
  withDlg.scenes[3].dialogue = "全員、動け";
  const e = run(withDlg);
  assert.equal(e.scenes[2].dialogue, "まだ終わってない", "turn のセリフは残る");
  assert.equal(e.scenes[3].dialogue, "全員、動け", "montage のセリフは残る");
  assert.equal(e.scenes[2].narration, "", "turn はセリフがあるのでナレを落とす");
  assert.equal(e.scenes[3].narration, "", "montage はセリフがあるのでナレを落とす");
});

test("cold_open / setup / resolve はナレ優先でセリフを落とす", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  d.scenes[4].dialogue = "行くぞ";
  const e = run(d);
  assert.equal(e.scenes[4].dialogue, "", "resolve はナレがあるのでセリフを落とす");
  assert.notEqual(e.scenes[4].narration, "");
});

test("cold_open / setup にはそもそもセリフを置かせない（案 A）", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  d.scenes[0].dialogue = "おつかれさまです";
  d.scenes[1].dialogue = "これ、まずくないですか";
  const e = run(d, "narration");
  assert.equal(e.scenes[0].dialogue, "");
  assert.equal(e.scenes[1].dialogue, "");
});

test("案 B（dialogue）は setup にもセリフを置ける", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  d.scenes[1].narration = "";      // 案 B はナレなしのシーンがある
  d.scenes[1].dialogue = "これ、まずいです";
  const e = run(d, "dialogue");
  assert.equal(e.scenes[1].dialogue, "これ、まずいです");
  assert.equal(e.style, "dialogue");
});

test("duration_sec は 4 / 6 / 8 のみ。外れたら既定ランプに落とす", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  d.scenes[0].duration_sec = 5;    // 不正 → ランプ[0] = 6
  d.scenes[1].duration_sec = 6;    // 正
  d.scenes[2].duration_sec = "8";  // 文字列でも Number() で 8
  d.scenes[3].duration_sec = 99;   // 不正 → ランプ[3] = 6
  d.scenes[4].duration_sec = null; // 不正 → ランプ[4] = 4
  const e = run(d);
  assert.deepEqual(e.scenes.map((s) => s.duration_sec), [6, 6, 8, 6, 4]);
});

test("cut_count は scene_type 別の上限でクランプ（montage だけ 6）", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  for (const s of d.scenes) s.cut_count = 99;
  const e = run(d);
  assert.deepEqual(e.scenes.map((s) => s.cut_count), [4, 4, 4, 6, 4]);
});

test("on_silence は予告全体で 1 回まで（2 回目以降は cut_head に落ちる）", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  for (const s of d.scenes) s.telop_timing = "on_silence";
  const e = run(d);
  assert.equal(e.scenes.filter((s) => s.telop_timing === "on_silence").length, 1);
  assert.equal(e.scenes[0].telop_timing, "on_silence");
  assert.equal(e.scenes[1].telop_timing, "cut_head");
});

test("セリフは案 A で 3 本まで / 未知の location と characters は落とす", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  for (const s of d.scenes) { s.narration = ""; s.dialogue = "行くぞ"; }
  d.scenes[2].location = "mars";
  d.scenes[2].characters = ["hero", "godzilla", "boss"];
  const e = run(d);
  assert.equal(e.scenes.filter((s) => s.dialogue).length, 3, "案 A は 3 本まで");
  assert.equal(e.scenes[2].location, "office", "未知の location は scene_type の既定に落ちる");
  assert.deepEqual(e.scenes[2].characters, ["hero", "boss"]);
});

test("旧 speaker キーは新キャストに読み替える", () => {
  const d = raw(["cold_open", "setup", "turn", "montage", "resolve"]);
  d.scenes[2].narration = "";
  d.scenes[2].dialogue = "時間がない";
  d.scenes[2].speaker = "male_mature";
  assert.equal(run(d).scenes[2].speaker, "boss");
});

test("scenes の件数を SCENE_COUNT に揃え、メタ情報を書き込む", () => {
  const d = raw(["cold_open", "setup", "turn"]);
  const e = normalize(d, "エピソード文", "narration", { ...opts, sceneCount: 5 });
  assert.equal(e.scenes.length, 5);
  assert.deepEqual(e.scenes.map((s) => s.index), [1, 2, 3, 4, 5]);
  assert.equal(e.episode, "エピソード文");
  assert.equal(e.model, "test-model");
  assert.equal(e.created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(e.enriched, true);
});
