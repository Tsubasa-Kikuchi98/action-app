// ①' 台本の拡張: 既存 script.json を「予告編の演出情報」で非破壊的に拡張する。
// 使い方: node scripts/enrich.mjs <job> [--force] [--dry-run]
//
// 既存フィールド（narration / telop / image_prompt / video_prompt / duration_sec /
// motion / nar_sec / clip_sec / base_sec / index）は**一切変更しない**。
// Veo クリップを作り直さずに演出だけ強化するための工程なので、
// 「絵と音の中身」に関わるフィールドには触れないのが鉄則。
//
// 追加するもの:
//   シーン単位 … scene_type / cut_count / motion_beat / camera_beat / ambient /
//                dialogue / speaker / telop_timing / screen_text
//   全体      … tagline / interstitials / release_line / presents / cast_lines
import {
  getOpenAI, MODELS, readScript, writeScript, jobPaths,
  timed, fmtUSD, isMain,
} from "./lib.mjs";

export const SCENE_TYPES = ["cold_open", "setup", "turn", "montage", "resolve"];
export const SPEAKERS = ["none", "male_young", "male_mature", "female_young", "female_mature"];
export const TELOP_TIMINGS = ["cut_head", "after_narration"];

/** セリフの上限（予告全体で 2〜3 本まで）。 */
export const MAX_DIALOGUE = Number(process.env.MAX_DIALOGUE ?? 3);

/** scene_type ごとの既定カット数（quality-research §A: 1,1,2,3,3）。 */
export const DEFAULT_CUT_COUNT = {
  cold_open: 1,
  setup: 1,
  turn: 2,
  montage: 3,
  resolve: 2,
};

/** scene_type ごとの既定テロップタイミング。 */
const DEFAULT_TELOP_TIMING = {
  cold_open: "after_narration",
  setup: "after_narration",
  turn: "cut_head",
  montage: "cut_head",
  resolve: "after_narration",
};

/** scene_type ごとの Veo 既定カメラ語彙（quality-research §B）。 */
export const DEFAULT_CAMERA_BEAT = {
  cold_open: "slow dolly in, wide shot",
  setup: "handheld push-in, medium shot",
  turn: "low-angle tracking shot, shallow depth of field",
  montage: "fast crane rising, wide shot",
  resolve: "slow pull-back crane, wide shot",
};

// ---------------------------------------------------------------- 既定値
/** index（1 始まり）と総シーン数から scene_type を推定する（旧 script.json 用）。 */
export function guessSceneType(i, n) {
  if (i === 0) return "cold_open";
  if (i === n - 1) return "resolve";
  if (n <= 3) return "turn";
  const r = (i - 1) / (n - 2); // 中間シーンの位置 0..1
  if (r < 0.34) return "setup";
  if (r < 0.67) return "turn";
  return "montage";
}

/**
 * script.json を「拡張フィールドが必ず存在する形」に正規化したビューを返す（非破壊）。
 * enrich していない旧 script.json（demo1 など）でも安全に動くよう、
 * カット割り・カード類は**演出なし**の既定値に落とす。
 */
export function enrichedView(data) {
  const n = data.scenes.length;
  const enriched = data.enriched === true;
  const scenes = data.scenes.map((s, i) => {
    const type = SCENE_TYPES.includes(s.scene_type) ? s.scene_type : guessSceneType(i, n);
    // 未 enrich の台本はカットを割らない（同じ静止画を何度も見せないため）
    const cut = enriched
      ? Math.max(1, Math.min(4, Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type])))
      : 1;
    return {
      ...s,
      index: s.index ?? i + 1,
      scene_type: type,
      cut_count: cut,
      motion_beat: String(s.motion_beat ?? "").trim(),
      camera_beat: String(s.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(s.ambient ?? "").trim(),
      dialogue: enriched ? String(s.dialogue ?? "").trim() : "",
      speaker: SPEAKERS.includes(s.speaker) ? s.speaker : "none",
      telop_timing: TELOP_TIMINGS.includes(s.telop_timing)
        ? s.telop_timing
        : DEFAULT_TELOP_TIMING[type],
      screen_text: enriched
        ? (Array.isArray(s.screen_text) ? s.screen_text : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 2)
        : [],
    };
  });
  return {
    ...data,
    enriched,
    scenes,
    tagline: String(data.tagline ?? "").trim(),
    release_line: String(data.release_line ?? "").trim(),
    presents: String(data.presents ?? "").trim(),
    cast_lines: (Array.isArray(data.cast_lines) ? data.cast_lines : [])
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 3),
    interstitials: (Array.isArray(data.interstitials) ? data.interstitials : [])
      .map((it) => ({
        text: String(it?.text ?? "").trim(),
        after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
      }))
      .filter((it) => it.text)
      .slice(0, 2),
  };
}

// ---------------------------------------------------------------- プロンプト
/** コピーの原則（script.mjs からも読み込んで使う）。 */
export const COPY_PRINCIPLES = `# 予告編コピーの原則（厳守）
- **問いと賭け金**: 予告全体のどこかに「数字・期限・二択」を必ず 1 つ入れる（例: 残り 3 分、朝までに、二つに一つ）。
- **結末を示さない**: 「解決した」「復旧した」と言い切らない。最後は問いか宣言で終える。
- **役割分離**: ナレーション＝語り（物語を進める）／テロップ＝断言（体言止め・対比・極短のキャッチ）。テロップはナレの要約にしない。
- **間**: 全角三点リーダー「……」で沈黙を作る。読点を並べず、文を切る。
- **読み**: 読みが二通りある漢字と社内固有名詞は開く（TTS の誤読対策）。
- **交互**: 見せ場 → 言葉 → 見せ場。説明を続けない。`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenes", "tagline", "interstitials", "release_line", "presents", "cast_lines"],
  properties: {
    scenes: {
      type: "array",
      description: "既存シーンと同じ数・同じ順の配列。",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "index", "scene_type", "cut_count", "motion_beat", "camera_beat",
          "ambient", "dialogue", "speaker", "telop_timing", "screen_text",
        ],
        properties: {
          index: { type: "integer", description: "対象シーンの index（1 始まり）。" },
          scene_type: {
            type: "string",
            enum: SCENE_TYPES,
            description: "予告の構造上の役割。先頭は cold_open、末尾は resolve。",
          },
          cut_count: {
            type: "integer",
            description: "このシーンを何カットに割るか。1〜4。基準は先頭から 1,1,2,3,3（終盤ほど多い）。",
          },
          motion_beat: {
            type: "string",
            description: "英語。被写体の力のある動作を 1 つだけ（例: slams a fist on the desk / bolts upright from the chair）。Veo 再生成用。",
          },
          camera_beat: {
            type: "string",
            description: "英語。Veo 公式のカメラ語彙を 1 つだけ（dolly in / tracking shot / crane / handheld / whip pan / rack focus / low angle / extreme close-up など）。",
          },
          ambient: {
            type: "string",
            description: "英語。そのシーンで聞こえる環境音を 2〜4 語で（例: server fans, distant thunder, keyboard clatter）。",
          },
          dialogue: {
            type: "string",
            description: "登場人物の日本語の決め台詞。6〜14 字。無い場合は空文字。予告全体で 2〜3 本だけ、turn / montage / resolve のいずれかに置く。",
          },
          speaker: {
            type: "string",
            enum: SPEAKERS,
            description: "dialogue の話者。dialogue が空なら none。",
          },
          telop_timing: {
            type: "string",
            enum: TELOP_TIMINGS,
            description: "テロップの出し方。cut_head = カット頭に叩きつける（turn / montage 向き）、after_narration = ナレの決め言葉に合わせる。",
          },
          screen_text: {
            type: "array",
            description: "画面内の小テロップ（モニタの警告・時刻表示など）。英数字中心で 0〜2 個、各 12 文字以内（例: 02:14 AM / ALERT / CRITICAL / -00:03:00）。不要なら空配列。",
            items: { type: "string" },
          },
        },
      },
    },
    tagline: {
      type: "string",
      description: "タイトルの下に出す一行のタグライン。日本語 12 字以内。結末を示さず、問いか宣言で終える（例: 夜明けは、来るのか。）。",
    },
    interstitials: {
      type: "array",
      description: "黒背景に白文字で挟む中間カード。ちょうど 2 枚。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "after_scene"],
        properties: {
          text: {
            type: "string",
            description: "日本語 10 字以内の断言（例: この夏 / 誰も、逃げられない）。",
          },
          after_scene: {
            type: "integer",
            description: "このカードを何番のシーンの直後に挟むか（1 始まり。最終シーンの後には置かない）。",
          },
        },
      },
    },
    release_line: {
      type: "string",
      description: "エンドカードの公開表記。日本語 12 字以内（例: この冬、社内公開）。",
    },
    presents: {
      type: "string",
      description: "冒頭カードの「○○ PRESENTS」。エピソードから所属・チームを推定する。日本語可、20 字以内（例: 情報システム部 PRESENTS）。",
    },
    cast_lines: {
      type: "array",
      description: "エンドカードに小さく載せる登場人物の役職名。2〜3 個、各 10 字以内（例: 若きエンジニア / 夜勤のリーダー）。実在の人名は使わない。",
      items: { type: "string" },
    },
  },
};

function buildSystemPrompt(n) {
  return `あなたはハリウッド映画の予告編（トレーラー）の編集・演出担当です。
すでに完成している ${n} シーンの台本に、**演出情報だけ**を追加します。
ナレーション・テロップ・画像プロンプト・尺は既に確定していて変更できません。与えられたものに合わせて演出を設計してください。

${COPY_PRINCIPLES}

# 構造（scene_type）
Cold Open → Act1 → Act2 → Act3 → Button の予告文法に当てはめる。
先頭は必ず cold_open、末尾は必ず resolve。間は setup → turn → montage の順に緊張を上げる。

# カット割り（cut_count）
終盤ほどカットを細かくする（カットランプ）。基準は先頭から 1, 1, 2, 3, 3。
1 カットあたり 0.9 秒を下回らないよう、短いシーンでは無理に増やさない。

# セリフ（dialogue）
- **予告全体で 2〜3 本だけ**。それ以外のシーンは空文字にする。
- 現場で切迫して発する一言。6〜14 字。説明しない。命令形・宣言・問いのいずれか（例: 「まだ終わってない」「時間がない」「全員、戻れ」）。
- turn / montage / resolve のいずれかに置く。cold_open と setup には置かない。
- speaker はエピソードの登場人物像から選ぶ。dialogue が空なら none。

# 画面内テロップ（screen_text）
モニタや時計に映る「実在する表示」として自然なものだけ。英数字中心。日本語の情緒的なコピーは入れない（それはテロップの仕事）。
緊張が高いシーンに 1〜2 個、静かなシーンには置かない（空配列）。

# Veo 用の動きの指示（motion_beat / camera_beat / ambient）
- motion_beat は**力の動詞**を 1 つ（push, pull, strike, slam, bolt, sprint, hurl, wrench）。「座って見つめる」のような静的な動作は禁止。
- camera_beat は Veo 公式語彙から 1 つだけ。シーンごとにショットサイズを変える（wide → medium → close-up → extreme close-up を混ぜる）。
- ambient はそのシーンで実際に鳴っている音。音楽は書かない。

出力は指定された JSON スキーマに厳密に従い、scenes は必ずちょうど ${n} 要素、index は 1 から ${n} まで昇順にすること。`;
}

// ---------------------------------------------------------------- 本体
/** 既に拡張済みかどうか（--force なしのスキップ判定に使う）。 */
export function isEnriched(data) {
  return data?.enriched === true;
}

export async function enrichScript(job, { force = false, dryRun = false } = {}) {
  const data = readScript(job);
  const n = data.scenes.length;

  if (!force && isEnriched(data)) {
    console.log(`[enrich] skip (既に拡張済み。作り直すには --force)`);
    return { data, cost: 0, skipped: true };
  }

  if (dryRun) {
    console.log(buildSystemPrompt(n));
    console.log("\n---- JSON SCHEMA ----");
    console.log(JSON.stringify(SCHEMA, null, 2));
    return { data, cost: 0, dryRun: true };
  }

  const openai = getOpenAI();
  const brief = data.scenes
    .map(
      (s, i) =>
        `#${i + 1} (${s.duration_sec ?? "?"}s)\n  ナレ: ${s.narration}\n  テロップ: ${s.telop}\n  絵: ${s.image_prompt}`
    )
    .join("\n");

  const { result, usage, sec, cost } = await timed(job, "enrich", async () => {
    const resp = await openai.responses.create({
      model: MODELS.script,
      input: [
        { role: "system", content: buildSystemPrompt(n) },
        {
          role: "user",
          content:
            `# 元になった出来事\n${data.episode ?? "(不明)"}\n\n` +
            `# 作品タイトル\n${data.title}\n\n` +
            `# 確定済みの ${n} シーン\n${brief}\n\n` +
            `この予告に演出情報を付けてください。`,
        },
      ],
      text: { format: { type: "json_schema", name: "trailer_enrichment", strict: true, schema: SCHEMA } },
    });
    return { result: resp, usage: resp.usage, model: MODELS.script };
  });

  const raw = result.output_text ?? "";
  if (!raw) throw new Error("モデルからテキスト出力が得られませんでした");
  const add = JSON.parse(raw);

  // --- マージ（既存フィールドには一切触れない） ---------------------------
  const byIndex = new Map();
  for (const s of add.scenes ?? []) byIndex.set(Number(s.index), s);

  // セリフは全体で MAX_DIALOGUE 本まで。cold_open / setup には置かせない。
  const dlgOrder = ["turn", "montage", "resolve"];
  const candidates = data.scenes
    .map((s, i) => ({ i, a: byIndex.get(i + 1) }))
    .filter(({ a }) => a && String(a.dialogue ?? "").trim())
    .filter(({ a }) => dlgOrder.includes(a.scene_type))
    .slice(0, MAX_DIALOGUE);
  const keepDialogue = new Set(candidates.map((c) => c.i));

  data.scenes = data.scenes.map((s, i) => {
    const a = byIndex.get(i + 1) ?? {};
    const type = SCENE_TYPES.includes(a.scene_type) ? a.scene_type : guessSceneType(i, n);
    const dialogue = keepDialogue.has(i) ? String(a.dialogue ?? "").trim().slice(0, 20) : "";
    return {
      ...s, // ← 既存フィールドを温存
      scene_type: type,
      cut_count: Math.max(1, Math.min(4, Math.round(Number(a.cut_count) || DEFAULT_CUT_COUNT[type]))),
      motion_beat: String(a.motion_beat ?? "").trim(),
      camera_beat: String(a.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(a.ambient ?? "").trim(),
      dialogue,
      speaker: dialogue && SPEAKERS.includes(a.speaker) && a.speaker !== "none" ? a.speaker : dialogue ? "male_mature" : "none",
      telop_timing: TELOP_TIMINGS.includes(a.telop_timing) ? a.telop_timing : DEFAULT_TELOP_TIMING[type],
      screen_text: (Array.isArray(a.screen_text) ? a.screen_text : [])
        .map((t) => String(t).replace(/[\r\n]+/g, " ").trim())
        .filter((t) => t && t.length <= 14)
        .slice(0, 2),
    };
  });

  data.tagline = String(add.tagline ?? "").replace(/[\r\n]+/g, " ").trim();
  data.release_line = String(add.release_line ?? "").replace(/[\r\n]+/g, " ").trim();
  data.presents = String(add.presents ?? "").replace(/[\r\n]+/g, " ").trim();
  data.cast_lines = (Array.isArray(add.cast_lines) ? add.cast_lines : [])
    .map((t) => String(t).replace(/[\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 3);
  data.interstitials = (Array.isArray(add.interstitials) ? add.interstitials : [])
    .map((it) => ({
      text: String(it?.text ?? "").replace(/[\r\n]+/g, " ").trim(),
      after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
    }))
    .filter((it) => it.text)
    .slice(0, 2);
  data.enriched = true;
  data.enriched_at = new Date().toISOString();

  writeScript(job, data);

  // --- ログ ---------------------------------------------------------------
  console.log(`[enrich] ${jobPaths(job).script}`);
  console.log(`  presents: ${data.presents || "(なし)"} / tagline: ${data.tagline || "(なし)"}`);
  console.log(`  release: ${data.release_line || "(なし)"} / cast: ${data.cast_lines.join(" / ") || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / セリフ「${s.dialogue}」(${s.speaker})` : "";
    const st = s.screen_text.length ? ` / 画面 ${s.screen_text.join(",")}` : "";
    console.log(`   s${s.index} ${s.scene_type} cut=${s.cut_count} telop=${s.telop_timing}${dlg}${st}`);
    console.log(`      camera: ${s.camera_beat} / motion: ${s.motion_beat} / amb: ${s.ambient}`);
  }
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, cost, sec, usage };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const job = args.find((a) => !a.startsWith("--")) ?? "demo1";
  await enrichScript(job, {
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  });
}
