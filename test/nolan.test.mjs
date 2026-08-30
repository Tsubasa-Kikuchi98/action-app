// nolan プリセット（3 カット・ナレなし・カード主導）のユニットテスト。API は呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { normalize, cleanDialogue } from "../src/domain/script/normalize.mjs";
import { lintScript } from "../src/domain/script/lint.mjs";
import { enrichedView } from "../src/domain/script/index.mjs";
import { NOLAN_SCENE_TYPES, sceneCountFor, STYLES } from "../src/domain/script/constants.mjs";
import { planTimeline } from "../src/domain/timeline/plan.mjs";
import { buildComposeFilter, lookFilter } from "../src/domain/timeline/filters.mjs";
import { buildAss } from "../src/domain/timeline/ass.mjs";
import {
  NOLAN_PRESENTS_SEC, NOLAN_CARD_SEC, NOLAN_STOPDOWN_SEC, NOLAN_TITLE_SEC, NOLAN_END_SEC, snap, nolanCenterX,
} from "../src/domain/timeline/constants.mjs";
import { detectVoiceSpan, pickSrcIn } from "../src/domain/timeline/voice.mjs";
import { buildScriptSchema, buildScriptSystemPrompt, validateSchema } from "../src/domain/prompts/scriptPrompt.mjs";
import { buildVideoPrompt } from "../src/domain/prompts/videoPrompt.mjs";
import { buildEditPrompt, NOLAN_STYLE_SUFFIX } from "../src/domain/prompts/imagePrompt.mjs";
import { SFX_SPECS, musicSpec } from "../src/domain/prompts/sfxPrompts.mjs";
import { CAST, LOCATIONS, castDescription } from "../src/domain/cast.mjs";

const opts = { model: "test-model", createdAt: "2026-01-01T00:00:00.000Z", warn: () => {} };

/** モデルの生出力に近い（＝余計なものが入っている）3 シーンの台本。 */
const rawNolan = (over = {}) => ({
  title: "帰還不能点",
  tagline: "戻れるのか。",
  presents: "情シス PRESENTS",     // → "IFTC 提供" に強制されるはず
  review_line: "全社員が震撼",      // → 空にされるはず
  stake: "被害総額 20 万円",        // → 空にされるはず
  button_line: "落ちのセリフ",      // → 空にされるはず
  release_line: "近日公開",
  cast_lines: ["主演 情シス"],      // → 空にされるはず
  style: "nolan",
  interstitials: [
    { text: "気づいた時には、遅かった。", after_scene: 2 },
    { text: "時間は、待たない。", after_scene: 3 },
  ],
  scenes: [
    {
      narration: "その日……",       // → 空にされるはず
      telop: "しかし、",             // → 空にされるはず
      screen_text: ["02:14 AM"],     // → 空にされるはず
      image_prompt: "a symmetrical wide shot of the office",
      video_prompt: "",
      duration_sec: 6,               // → 3 にされるはず
      scene_type: "cold_open",       // → discover にされるはず
      location: "office",
      cut_count: 4,                  // → 1 にされるはず
      visual_metaphor: "請求に気づく → 赤い光が顔を染める",
      motion_beat: "stands up sharply",
      camera_beat: "locked-off symmetrical wide shot",
      ambient: "server fans",
      dialogue: "It's still running.",
      speaker: "hero",               // → senpai にされるはず
      characters: [],
      telop_timing: "on_silence",
    },
    {
      narration: "", telop: "", screen_text: [],
      image_prompt: "the young man at his desk", video_prompt: "",
      duration_sec: 4, scene_type: "turn", location: "office", cut_count: 2,
      visual_metaphor: "復旧できない → 端末を叩き閉じる",
      motion_beat: "slams the laptop shut", camera_beat: "very slow dolly in",
      ambient: "keyboard, fans", dialogue: "I can't stop it.", speaker: "hero",
      characters: ["hero"], telop_timing: "cut_head",
    },
    {
      narration: "", telop: "", screen_text: [],
      image_prompt: "the boss walks down the corridor", video_prompt: "",
      duration_sec: 4, scene_type: "resolve", location: "corridor", cut_count: 3,
      visual_metaphor: "本部長を呼ぶ → 逆光の廊下を歩き出す",
      motion_beat: "strides through the door", camera_beat: "locked-off low-angle wide shot",
      ambient: "corridor hum", dialogue: "I'll make the call.", speaker: "boss",
      characters: ["boss"], telop_timing: "cut_head",
    },
  ],
  ...over,
});

// ------------------------------------------------------------------ normalize
test("nolan は STYLES に含まれ、シーン数は 3", () => {
  assert.ok(STYLES.includes("nolan"));
  assert.equal(sceneCountFor("nolan"), 3);
  assert.equal(sceneCountFor("narration"), 5);
});

test("normalize(nolan): ナレは全シーン空・セリフは全シーン必須・話者は固定", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  assert.equal(d.style, "nolan");
  assert.equal(d.scenes.length, 3);
  assert.deepEqual(d.scenes.map((s) => s.narration), ["", "", ""]);
  assert.deepEqual(d.scenes.map((s) => s.dialogue), ["It's still running.", "I can't stop it.", "I'll make the call."]);
  assert.deepEqual(d.scenes.map((s) => s.speaker), ["senpai", "hero", "boss"]);
  assert.deepEqual(d.scenes.map((s) => s.scene_type), NOLAN_SCENE_TYPES);
});

test("normalize(nolan): カット内に文字を出さない（telop / screen_text は空・cut_count は 1）", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  assert.deepEqual(d.scenes.map((s) => s.telop), ["", "", ""]);
  assert.deepEqual(d.scenes.map((s) => s.screen_text.length), [0, 0, 0]);
  assert.deepEqual(d.scenes.map((s) => s.cut_count), [1, 1, 1]);
  assert.deepEqual(d.scenes.map((s) => s.duration_sec), [3, 4, 3]);
});

test("normalize(nolan): 中間カードは 2 枚（after_scene 1, 2）・presents は固定・煽り系は空", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  assert.deepEqual(d.interstitials.map((it) => it.after_scene), [1, 2]);
  assert.equal(d.interstitials.length, 2);
  assert.equal(d.interstitials[0].text, "気づいた時には、遅かった。");
  assert.equal(d.presents, "IFTC 提供");
  assert.equal(d.review_line, "");
  assert.equal(d.stake, "");
  assert.equal(d.button_line, "");
  assert.deepEqual(d.cast_lines, []);
});

test("normalize(nolan): シーンが 3 件でなくても 3 件に揃える", () => {
  const raw = rawNolan();
  raw.scenes = raw.scenes.slice(0, 1);
  const d = normalize(raw, "エピソード", "nolan", opts);
  assert.equal(d.scenes.length, 3);
  assert.deepEqual(d.scenes.map((s) => s.scene_type), NOLAN_SCENE_TYPES);
});

test("normalize: 既存の narration / dialogue は 5 シーンのままで壊れない", () => {
  const five = {
    title: "無題",
    scenes: ["cold_open", "setup", "turn", "montage", "resolve"].map((t) => ({
      narration: "その日……", telop: "その日、", image_prompt: "a", video_prompt: "b",
      duration_sec: 4, scene_type: t, location: "office", cut_count: 1,
      visual_metaphor: "現実 → 演出", motion_beat: "bolts", camera_beat: "dolly in",
      ambient: "fans", dialogue: "", speaker: "none", characters: ["hero"],
      telop_timing: "after_narration", screen_text: [],
    })),
  };
  const d = normalize(five, "エピソード", "narration", opts);
  assert.equal(d.style, "narration");
  assert.equal(d.scenes.length, 5);
  assert.equal(d.scenes[0].narration, "その日……");
});

// ------------------------------------------------------------------ lint
test("lintScript(nolan): 整った台本では警告が出ない", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  assert.deepEqual(lintScript(d), []);
});

test("lintScript(nolan): セリフ欠落・カード欠落・禁句を検出する", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  d.scenes[1].dialogue = "";
  d.interstitials = [{ text: "感動の一枚", after_scene: 1 }];
  const w = lintScript(d);
  assert.ok(w.some((x) => x.includes("セリフがありません")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("中間カードが 1 枚")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("禁句")), w.join(" / "));
});

test("lintScript(nolan): 日本語のセリフ・語数オーバーを検出する", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  d.scenes[0].dialogue = "止まってない";
  d.scenes[1].dialogue = "I really do not think that we can stop it now";
  const w = lintScript(d);
  assert.ok(w.some((x) => x.includes("日本語が混ざっています")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("語（2〜8 語）")), w.join(" / "));
});

test("normalize: セリフから話者ラベルと引用符を落とす", () => {
  const raw = rawNolan();
  raw.scenes[0].dialogue = 'senpai "The loop is still running."';
  raw.scenes[1].dialogue = "hero: 'I can not stop it.'";
  raw.scenes[2].dialogue = "「I'll make the call.」";
  const d = normalize(raw, "エピソード", "nolan", opts);
  assert.deepEqual(d.scenes.map((s) => s.dialogue), [
    "The loop is still running.", "I can not stop it.", "I'll make the call.",
  ]);
  assert.deepEqual(lintScript(d), []);
  // 本文が話者名で始まるだけのセリフは壊さない
  assert.equal(cleanDialogue("Boss, look at this."), "Boss, look at this.");
});

test("キャストは欧米系で、外見は髪と服装で見分ける", () => {
  for (const k of ["hero", "senpai", "boss"]) {
    assert.ok(CAST[k].en.includes("Western"), `${k}: ${CAST[k].en}`);
    assert.ok(!/Japanese/.test(CAST[k].en), `${k} に Japanese が残っている`);
  }
  assert.ok(castDescription(["hero", "boss"]).includes("light brown short hair"));
  assert.ok(!/Japanese/.test(LOCATIONS.office.en));
});

test("lintScript(nolan): カット内の文字とナレを検出する", () => {
  const d = normalize(rawNolan(), "エピソード", "nolan", opts);
  d.scenes[0].telop = "しかし、";
  d.scenes[2].narration = "今、動き出す";
  const w = lintScript(d);
  assert.ok(w.some((x) => x.includes("カット内に文字を出しません")), w.join(" / "));
  assert.ok(w.some((x) => x.includes("ナレーションは入れません")), w.join(" / "));
});

// ------------------------------------------------------------------ timeline
/** 3 シーン全部が 8 秒の Veo クリップ（音声あり）として実測できた状態。 */
function fixture() {
  const data = normalize(rawNolan(), "エピソード", "nolan", opts);
  for (const s of data.scenes) s.motion = "video";
  const view = enrichedView(data);
  const src = view.scenes.map((s, i) => ({
    i, n: i + 1, s,
    useVideo: true, vid: `out/x/vid/s${i + 1}.mp4`, img: `out/x/img/s${i + 1}.png`,
    clipSec: 8, hasAudio: true, gainDb: 2,
    narFile: "", hasNar: false, narSec: 0,
    dlgFile: "", hasDlg: false, dlgSec: 0,
  }));
  return { view, plan: planTimeline(view, src) };
}

test("planNolan: カード ↔ カットが交互に並び、カットは分割されない", () => {
  const { plan } = fixture();
  assert.equal(plan.style, "nolan");
  assert.deepEqual(
    plan.segs.map((s) => s.kind),
    ["card", "video", "card", "video", "card", "video", "card", "card", "card"],
    "提供 / C1 / カード① / C2 / カード② / C3 / 無音の黒 / タイトル / エンド"
  );
  // 1 シーン 1 カット・寄りも手ブレもスローも掛けない
  const cuts = plan.segs.filter((s) => s.kind === "video");
  assert.equal(cuts.length, 3);
  assert.deepEqual(cuts.map((s) => s.outSec), [3, 4, 3]);
  assert.deepEqual(cuts.map((s) => s.srcIn), [0, 0, 0]);
  assert.ok(cuts.every((s) => s.zoom === 1 && s.shake === false && s.slow === 1));
  // ハードカットのみ（xfade は使わない）
  assert.equal(plan.xfadeAfter, -1);
  assert.equal(plan.xfadeSec, 0);
  // 声のレーンは使わない（セリフは Veo クリップの中）
  assert.deepEqual([plan.nar.length, plan.dlg.length, plan.btn.length], [0, 0, 0]);
});

test("planNolan: SFX はカードの開始時刻とぴったり一致する", () => {
  const { plan } = fixture();
  assert.equal(plan.sfx.length, 3, "中間カード 2 枚 + タイトル");
  assert.deepEqual(plan.sfx.map((e) => e.name), ["braam", "braam2", "riser"]);
  const cardStarts = new Set(plan.segs.filter((s) => s.kind === "card").map((s) => s.absStart.toFixed(3)));
  for (const e of plan.sfx) {
    assert.ok(cardStarts.has(e.at.toFixed(3)), `sfx ${e.name}@${e.at} がカード開始時刻に無い`);
    assert.equal(plan.segs[e.card].absStart.toFixed(3), e.at.toFixed(3));
  }
});

test("planNolan: 合計尺は 20 秒前後（カード尺 + 3 / 4 / 3 秒）", () => {
  const { plan } = fixture();
  const expected =
    snap(NOLAN_PRESENTS_SEC) + 3 + snap(NOLAN_CARD_SEC) + 4 + snap(NOLAN_CARD_SEC) + 3 +
    snap(NOLAN_STOPDOWN_SEC) + snap(NOLAN_TITLE_SEC) + snap(NOLAN_END_SEC);
  assert.ok(Math.abs(plan.total - expected) < 1e-6, `${plan.total} != ${expected}`);
  assert.ok(plan.total >= 17 && plan.total <= 20.5, `合計 ${plan.total}s`);
});

test("planNolan: タイトル直前に全レーン無音の黒が入る", () => {
  const { plan } = fixture();
  assert.equal(plan.silences.length, 1);
  const stop = plan.segs[6];
  assert.equal(plan.silences[0].start.toFixed(3), stop.absStart.toFixed(3));
  assert.ok(Math.abs(plan.silences[0].end - plan.silences[0].start - snap(NOLAN_STOPDOWN_SEC)) < 1e-6);
});

test("planNolan: ASS はカード用スタイルだけを使い、カット中の文字は 1 つも無い", () => {
  const { plan } = fixture();
  const styles = new Set(plan.ass.map((e) => e.style));
  assert.deepEqual([...styles].sort(), ["CardNolan", "EndNolan", "PresentsNolan", "TitleNolan", "TitleSubNolan"]);
  // すべての文字イベントがカードの区間の中に収まっている
  const cards = plan.segs.filter((s) => s.kind === "card").map((s) => [s.absStart, s.absStart + s.outSec]);
  for (const e of plan.ass) {
    assert.ok(
      cards.some(([a, b]) => e.start >= a - 1e-6 && e.end <= b + 1e-6),
      `${e.style} ${e.start}-${e.end} がカードの外に出ている`
    );
  }
  // 生成した ASS に nolan のスタイル定義が入っている
  const ass = buildAss(plan.ass);
  assert.ok(ass.includes("Style: CardNolan,"));
  assert.ok(ass.includes("Style: TitleNolan,"));
});

test("buildComposeFilter: SFX レーンが入り、nolan のルックに切り替わる", () => {
  const { plan } = fixture();
  plan.sfx = plan.sfx.map((e) => ({ ...e, file: `assets/sfx/${e.name}.wav` }));
  const fc = buildComposeFilter(plan, { cutCount: plan.segs.length, assRel: "out/x/telop.ass", bgm: { dur: 20 } });
  // カット 9 本の後に SFX 3 本 → BGM は入力 12 番
  assert.ok(fc.includes("[9:a]"), fc.slice(0, 200));
  assert.ok(fc.includes("[11:a]"));
  assert.ok(fc.includes("[12:a]"), "BGM が SFX の後ろに来る");
  assert.ok(fc.includes("[sfxv]"));
  assert.ok(fc.includes("[sx0]"));
  // SFX は adelay でカード開始時刻に置かれる
  const ms = Math.round(plan.sfx[0].at * 1000);
  assert.ok(fc.includes(`adelay=${ms}|${ms}`));
  // nolan のルック（teal-orange の curves とブルームは使わない）
  assert.ok(fc.includes("saturation=0.80"));
  assert.ok(!fc.includes("all_mode=screen"));
  assert.ok(fc.includes("xfade") === false);
});

test("lookFilter: style で切り替わる（既定はこれまでどおり）", () => {
  const a = lookFilter("[vcat]", "x.ass", "[v]").join(";");
  const b = lookFilter("[vcat]", "x.ass", "[v]", "nolan").join(";");
  assert.ok(a.includes("saturation=1.10") && a.includes("all_mode=screen"));
  assert.ok(b.includes("saturation=0.80") && !b.includes("all_mode=screen"));
  assert.ok(b.includes("ass=f=x.ass") && b.includes("drawbox"));
});

// ------------------------------------------------------------------ prompts
test("nolan のスキーマとシステムプロンプト", () => {
  const schema = buildScriptSchema("nolan");
  assert.deepEqual(validateSchema(schema), []);
  assert.notEqual(schema, buildScriptSchema("narration"));
  assert.ok(schema.properties.scenes.description.includes("3 要素"));
  assert.ok(schema.properties.scenes.items.properties.narration.description.includes("必ず空文字"));

  const p = buildScriptSystemPrompt("nolan");
  assert.ok(p.includes("nolan: 3 カット"));
  assert.ok(p.includes("カメラは静か"));
  assert.ok(p.includes("パロディの原理"), "共通の原理は共有する");
  assert.ok(p.includes("舞台（location）"), "舞台の指示も共有する");
  assert.ok(!p.includes("案 A: ナレーション主導"));
  assert.ok(p.includes("セリフは**すべて英語**"), "セリフは英語で書かせる");
  assert.ok(schema.properties.scenes.items.properties.dialogue.description.includes("英語"));
});

test("buildVideoPrompt(nolan): 口パクのセリフ行と静かなカメラの指定が入る", () => {
  const scene = {
    scene_type: "mobilize", camera_beat: "locked-off low-angle wide shot",
    motion_beat: "strides through the door", ambient: "corridor hum",
    dialogue: "I'll make the call.", speaker: "boss", characters: ["boss"], video_prompt: "", image_prompt: "",
  };
  const p = buildVideoPrompt(scene, "nolan");
  assert.ok(p.includes(`says in English: "I'll make the call."`));
  assert.ok(p.includes("mouth is clearly visible"));
  assert.ok(p.includes("No handheld shake, no zoom"));
  // 既定 style ではこれまでどおりの文面
  const q = buildVideoPrompt(scene);
  assert.ok(q.includes(`speaks one short line in English: "I'll make the call."`));
  assert.ok(!q.includes("No handheld shake"));
});

test("buildEditPrompt(nolan): 鋼色・シンメトリー・口元の指定に差し替わる", () => {
  const scene = { image_prompt: "a wide shot", characters: ["boss"] };
  const refs = { chars: ["boss"], loc: "corridor", files: ["a", "b"] };
  assert.ok(buildEditPrompt(scene, refs, "nolan").endsWith(NOLAN_STYLE_SUFFIX));
  assert.ok(NOLAN_STYLE_SUFFIX.includes("desaturated steel-blue"));
  assert.ok(!buildEditPrompt(scene, refs).includes("desaturated steel-blue"));
});

test("SFX / BGM のプロンプト定義", () => {
  assert.deepEqual(SFX_SPECS.map((s) => s.name), ["braam", "braam2", "riser"]);
  assert.ok(SFX_SPECS.every((s) => s.durationSec >= 0.8 && s.durationSec <= 1.5));
  assert.ok(SFX_SPECS.every((s) => s.promptInfluence >= 0.5 && s.promptInfluence <= 0.7));
  const m = musicSpec("nolan", 20);
  assert.equal(m.lengthMs, 20000);
  assert.ok(m.prompt.includes("ticking clock"));
  assert.equal(musicSpec("narration").lengthMs, 45000);
});

// ------------------------------------------------------------------ 発話区間 / 中央寄せ
test("detectVoiceSpan: 最初のまとまった発話を採る（後半の大きい物音に引かれない）", () => {
  // 実測（out/lambda-nolan/vid/s1.mp4）: 2.4〜4.0s に発話、4.8〜5.6s にもっと大きい音
  const rms = [-53, -54, -52, -51, -49, -47, -31, -29, -31, -26, -37, -45, -24, -17, -33, -55];
  const levels = rms.map((r, i) => ({ t: i * 0.4, rms: r }));
  const span = detectVoiceSpan(levels, 0.4);
  assert.ok(Math.abs(span.start - 2.8) < 1e-6, `start=${span.start}`);
  assert.ok(Math.abs(span.end - 4.0) < 1e-6, `end=${span.end}`);
  // 1 窓だけの谷（3.2s の -31）は息継ぎとして繋ぐ
  assert.equal(detectVoiceSpan([{ t: 0, rms: -80 }, { t: 0.4, rms: -78 }], 0.4), null, "無音なら null");
});

test("pickSrcIn: 発話が窓に収まる位置を返す（余裕があれば中央に置く）", () => {
  // 3 秒だけ使う: 1.2 秒の発話 → 前後に 0.9 秒ずつ
  assert.ok(Math.abs(pickSrcIn({ start: 2.8, end: 4.0 }, { clipSec: 8, needSec: 3 }) - 1.9) < 1e-6);
  // 発話のほうが長ければ直前から
  assert.equal(pickSrcIn({ start: 2.0, end: 6.0 }, { clipSec: 8, needSec: 3 }), 1.75);
  // クリップの終端を越えない
  assert.equal(pickSrcIn({ start: 7.5, end: 8.0 }, { clipSec: 8, needSec: 3 }), 5);
  // 発話が見つからなければ頭から
  assert.equal(pickSrcIn(null, { clipSec: 8, needSec: 3 }), 0);
});

test("planNolan: 字間の分だけ x を右にずらして本当の中央に置く", () => {
  const { plan } = fixture();
  for (const e of plan.ass) {
    const x = Number(/\pos\((\d+),/.exec(e.tags)[1]);
    assert.equal(x, nolanCenterX(e.style), `${e.style} の x が ${x}`);
    assert.ok(x > 960, "libass は最後の字の後ろにも字間を足すので必ず 960 より右になる");
  }
});
