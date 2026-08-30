// domain/script/enrichedView.mjs のユニットテスト（旧 script.json 互換）。
import test from "node:test";
import assert from "node:assert/strict";
import { enrichedView, isEnriched } from "../src/domain/script/enrichedView.mjs";
import { DEFAULT_CAMERA_BEAT } from "../src/domain/script/constants.mjs";

/** Phase 1 の旧 script.json 相当（演出フィールドを一切持たない）。 */
const legacy = () => ({
  title: "旧台本",
  scenes: [
    { narration: "その日……", telop: "その日、", image_prompt: "a", duration_sec: 6, index: 1 },
    { narration: "しかし……", telop: "しかし、", image_prompt: "b", duration_sec: 4, index: 2 },
    { narration: "誰も……",   telop: "誰も",     image_prompt: "c", duration_sec: 4, index: 3 },
    { narration: "今……",     telop: "今",       image_prompt: "d", duration_sec: 6, index: 4 },
    { narration: "動き出す",   telop: "動き出す", image_prompt: "e", duration_sec: 4, index: 5 },
  ],
});

test("旧台本は enriched=false になり、演出は既定値に落ちる（非破壊）", () => {
  const data = legacy();
  const before = JSON.stringify(data);
  const v = enrichedView(data);

  assert.equal(v.enriched, false);
  assert.equal(isEnriched(data), false);
  assert.equal(JSON.stringify(data), before, "元データを変更しない");

  // 未 enrich はカットを割らない・セリフとカードを出さない
  assert.deepEqual(v.scenes.map((s) => s.cut_count), [1, 1, 1, 1, 1]);
  assert.deepEqual(v.scenes.map((s) => s.dialogue), ["", "", "", "", ""]);
  assert.deepEqual(v.scenes.map((s) => s.screen_text), [[], [], [], [], []]);
  assert.equal(v.button_line, "");
  assert.equal(v.review_line, "");
  assert.equal(v.stake, "");
  assert.deepEqual(v.interstitials, []);
  assert.deepEqual(v.cast_lines, []);
  assert.equal(v.style, "narration");
});

test("旧台本の scene_type は位置から推定される", () => {
  const v = enrichedView(legacy());
  // guessSceneType は「先頭 cold_open / 末尾 resolve / 中間を 0..1 で 3 分割」。
  // n=5 では中間の位置が 0, 1/3, 2/3 なので setup, setup, turn になる（montage は出ない）。
  assert.deepEqual(v.scenes.map((s) => s.scene_type), ["cold_open", "setup", "setup", "turn", "resolve"]);
  // camera_beat と location も scene_type の既定で埋まる
  assert.equal(v.scenes[0].camera_beat, DEFAULT_CAMERA_BEAT.cold_open);
  assert.equal(v.scenes[3].camera_beat, DEFAULT_CAMERA_BEAT.turn);
  assert.deepEqual(v.scenes.map((s) => s.location), ["office", "office", "office", "office", "meeting"]);
});

test("enriched=true の台本は演出フィールドをそのまま通す", () => {
  const data = legacy();
  data.enriched = true;
  data.stake = "残された時間は 3 分";
  data.review_line = "情シスが泣いた";
  data.interstitials = [{ text: "この夏、", after_scene: 2 }];
  data.cast_lines = ["主演 情シス", "", "  "];
  data.scenes[3].cut_count = 6;
  data.scenes[3].scene_type = "montage";
  data.scenes[3].dialogue = "Everyone, move.";
  data.scenes[3].screen_text = ["02:14 AM", "ALERT", "余分"];

  const v = enrichedView(data);
  assert.equal(v.enriched, true);
  assert.equal(v.stake, "残された時間は 3 分");
  assert.equal(v.scenes[3].cut_count, 6, "montage は 6 まで許される");
  assert.equal(v.scenes[3].dialogue, "Everyone, move.");
  assert.deepEqual(v.scenes[3].screen_text, ["02:14 AM", "ALERT"], "画面内テロップは 2 個まで");
  assert.deepEqual(v.cast_lines, ["主演 情シス"], "空文字は落とす");
  assert.deepEqual(v.interstitials, [{ text: "この夏、", after_scene: 2 }]);
});

test("cut_count は scene_type の上限でクランプされる（montage だけ 6）", () => {
  const data = legacy();
  data.enriched = true;
  for (const s of data.scenes) s.cut_count = 99;
  // scene_type が無いと推定結果に montage は現れないので、すべて 4 に張り付く
  assert.deepEqual(enrichedView(data).scenes.map((s) => s.cut_count), [4, 4, 4, 4, 4]);
  // 明示的に montage を指定したシーンだけ 6 まで許される
  data.scenes[3].scene_type = "montage";
  assert.deepEqual(enrichedView(data).scenes.map((s) => s.cut_count), [4, 4, 4, 6, 4]);
});

test("interstitials の after_scene は 1..n-1 にクランプされる", () => {
  const data = legacy();
  data.enriched = true;
  data.interstitials = [{ text: "先頭より前", after_scene: -5 }, { text: "最後より後", after_scene: 99 }];
  const v = enrichedView(data);
  assert.deepEqual(v.interstitials.map((i) => i.after_scene), [1, 4]);
});
