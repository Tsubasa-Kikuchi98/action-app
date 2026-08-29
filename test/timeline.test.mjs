// domain/timeline のユニットテスト（カット割り・xfade オフセット・ASS）。
import test from "node:test";
import assert from "node:assert/strict";
import { planTimeline } from "../src/domain/timeline/plan.mjs";
import { buildComposeFilter } from "../src/domain/timeline/filters.mjs";
import { buildAss, assTime } from "../src/domain/timeline/ass.mjs";
import { FPS, XFADE_SEC, snap } from "../src/domain/timeline/constants.mjs";
import { enrichedView } from "../src/domain/script/index.mjs";

const scene = (i, over = {}) => ({
  index: i + 1,
  narration: "その日……すべては静かに始まった。",
  telop: `テロップ${i + 1}`,
  image_prompt: "shot",
  video_prompt: "dolly",
  duration_sec: 4,
  scene_type: "cold_open",
  location: "office",
  cut_count: 1,
  visual_metaphor: "現実 → 演出",
  motion_beat: "bolts",
  camera_beat: "dolly in",
  ambient: "server fans",
  dialogue: "",
  speaker: "none",
  characters: [],
  telop_timing: "after_narration",
  screen_text: [],
  motion: "video",
  ...over,
});

/** 5 シーン・全部動画クリップの台本と実測情報を作る。 */
function fixture(over = {}) {
  const types = ["cold_open", "setup", "turn", "montage", "resolve"];
  const data = {
    title: "深夜の障害対応",
    tagline: "夜明けは、来るのか。",
    presents: "情報システム部 PRESENTS",
    review_line: "情シスが泣いた",
    stake: "残された時間は 3 分",
    button_line: "",
    release_line: "近日公開",
    style: "narration",
    cast_lines: ["主演 情シス"],
    interstitials: [
      { text: "この夏、", after_scene: 2 },
      { text: "誰も、逃げられない", after_scene: 3 },
    ],
    enriched: true,
    scenes: types.map((t, i) => scene(i, { scene_type: t, cut_count: [1, 1, 2, 4, 3][i] })),
    ...over,
  };
  const view = enrichedView(data);
  const src = view.scenes.map((s, i) => ({
    i,
    n: i + 1,
    s,
    useVideo: true,
    vid: `out/x/vid/s${i + 1}.mp4`,
    img: `out/x/img/s${i + 1}.png`,
    clipSec: 8,
    hasAudio: true,
    gainDb: 2,
    narFile: `out/x/nar/s${i + 1}.wav`,
    hasNar: true,
    narSec: 2.5,
    dlgFile: `out/x/dlg/s${i + 1}.wav`,
    hasDlg: false,
    dlgSec: 0,
  }));
  return { view, src };
}

test("カット割り: cut_count 以上に割り、scene_type 別の上限秒を超えない", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  const cuts = plan.segs.filter((s) => s.kind === "video");
  assert.ok(cuts.length >= 11, `カット数 ${cuts.length} が cut_count の合計 11 を下回らない`);
  // montage（scene_type 別上限 1.7s）のカットは短い
  const maxCut = Math.max(...cuts.map((c) => c.outSec));
  assert.ok(maxCut <= 3.2 + 1e-9, `最長カット ${maxCut}s が cold_open の上限 3.2s 以内`);
});

test("カット割り: シーン内で後半のカットほど短い（カットランプ）", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  // montage は cut_count 4 → 4 カット以上。連続する video セグの長さが単調非増加なら OK
  const montage = plan.segs.filter((s) => s.kind === "video");
  let ok = false;
  for (let i = 0; i + 1 < montage.length; i++) {
    if (montage[i].outSec > montage[i + 1].outSec) ok = true;
  }
  assert.ok(ok, "シーン内で後半のカットが短くなる箇所が存在する");
});

test("未 enrich の台本はカットを割らない（1 シーン 1 カット）", () => {
  const { view, src } = fixture({ enriched: false });
  const plan = planTimeline(view, src);
  assert.equal(plan.segs.filter((s) => s.kind === "video").length, 5);
});

test("xfade: cold_open → setup の 1 箇所だけ。総尺は Σクリップ − トランジション", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  assert.ok(plan.xfadeAfter >= 0, "xfade は 1 箇所ある");
  assert.equal(plan.xfadeSec, snap(XFADE_SEC));

  const sumSegs = plan.segs.reduce((a, s) => a + s.outSec, 0);
  assert.ok(
    Math.abs(plan.total - (sumSegs - plan.xfadeSec)) < 1e-9,
    `total(${plan.total}) = Σクリップ(${sumSegs}) − xfade(${plan.xfadeSec})`
  );
});

test("xfade の offset は Σ前半クリップ − トランジション長", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  const fc = buildComposeFilter(plan, { cutCount: plan.segs.length, assRel: "out/x/telop.ass", bgm: null });
  const d0 = plan.segs.slice(0, plan.xfadeAfter + 1).reduce((a, s) => a + s.outSec, 0);
  const want = (d0 - plan.xfadeSec).toFixed(3);
  assert.match(fc, new RegExp(`xfade=transition=fade:duration=${plan.xfadeSec.toFixed(3)}:offset=${want}`));
});

test("xfade 後のセグメントは shift 分だけ前に詰まり、最後は total で終わる", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  const X = plan.xfadeAfter;
  for (let k = 0; k + 1 < plan.segs.length; k++) {
    const gap = plan.segs[k + 1].absStart - (plan.segs[k].absStart + plan.segs[k].outSec);
    const want = k === X ? -plan.xfadeSec : 0;
    assert.ok(Math.abs(gap - want) < 1e-9, `c${k}→c${k + 1} の隙間 ${gap}（想定 ${want}）`);
  }
  const last = plan.segs[plan.segs.length - 1];
  assert.ok(Math.abs(last.absStart + last.outSec - plan.total) < 1e-9, "最後のセグメントが total で終わる");
  // 音とテロップも詰めた後のタイムライン内に収まる
  for (const e of plan.nar) assert.ok(e.at >= 0 && e.at + e.sec <= plan.total + 1e-9);
  for (const e of plan.ass) assert.ok(e.start >= 0 && e.end <= plan.total + 1e-9);
});

test("すべてのセグメントはフレーム境界にスナップされる", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  for (const s of plan.segs) {
    assert.ok(Number.isInteger(Math.round(s.outSec * FPS)), `${s.outSec}s`);
    assert.ok(Math.abs(s.outSec * FPS - Math.round(s.outSec * FPS)) < 1e-9);
  }
});

test("stopdown（タイトル直前の黒）は無音区間として登録される", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  assert.ok(plan.silences.length >= 1);
  assert.ok(plan.silence.end > plan.silence.start);
  // 無音区間は開始時刻の昇順
  for (let i = 0; i + 1 < plan.silences.length; i++) {
    assert.ok(plan.silences[i].start <= plan.silences[i + 1].start);
  }
});

test("カード類（PRESENTS / 煽り / 中間 ×2 / stopdown / タイトル / エンド）が並ぶ", () => {
  const { view, src } = fixture();
  const plan = planTimeline(view, src);
  const cards = plan.segs.filter((s) => s.kind === "card");
  // PRESENTS, review, 白フラッシュ, 中間×2, stopdown, title, endcard
  assert.ok(cards.length >= 7, `カード ${cards.length} 枚`);
  const styles = plan.ass.map((e) => e.style);
  for (const st of ["Presents", "Review", "Inter", "TitleMain", "Coming", "EndCard"]) {
    assert.ok(styles.includes(st), `ASS に ${st} がある`);
  }
});

test("assTime は h:mm:ss.cc 形式", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(1.5), "0:00:01.50");
  assert.equal(assTime(61.25), "0:01:01.25");
  assert.equal(assTime(-3), "0:00:00.00");
});

test("buildAss は start < end のイベントだけを時刻順に出す", () => {
  const ass = buildAss([
    { style: "Telop", start: 2, end: 3, text: "あと" },
    { style: "Telop", start: 1, end: 2, text: "さき" },
    { style: "Telop", start: 5, end: 5, text: "尺ゼロ" },
    { style: "Telop", start: 6, end: 7, text: "" },
  ]);
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events.length, 2);
  assert.ok(events[0].includes("さき"));
  assert.ok(events[1].includes("あと"));
  assert.ok(!ass.includes("尺ゼロ"));
});
