// ① 台本生成: エピソード文 → out/<job>/script.json
// 使い方: node scripts/script.mjs "<エピソード文>" <job>
//         node scripts/script.mjs --dry-run          （API を呼ばずスキーマとプロンプトだけ検証）
//
// Responses API + Structured Outputs（json_schema / strict）で
// { title, tagline, presents, release_line, cast_lines, interstitials,
//   scenes: [{ narration, telop, image_prompt, video_prompt, duration_sec,
//              scene_type, cut_count, motion_beat, camera_beat, ambient,
//              dialogue, speaker, telop_timing, screen_text }] } を得る。
//
// Phase 3: 演出情報（scene_type / cut_count / dialogue / カード類）を**最初から**出させる。
// 既存ジョブは scripts/enrich.mjs で同じフィールドを後付けできる（旧 script.json 互換）。
import { getOpenAI, MODELS, timed, writeScript, jobPaths, fmtUSD, isMain } from "./lib.mjs";
import {
  SCENE_TYPES, SPEAKERS, TELOP_TIMINGS, DEFAULT_CUT_COUNT, DEFAULT_CAMERA_BEAT,
  COPY_PRINCIPLES, guessSceneType, MAX_DIALOGUE,
} from "./enrich.mjs";

// Phase 2: 全シーンを Veo で動画化するため 5 シーン構成。
// 8 秒固定のモデルに切り替えた場合は 3 に落とす（env SCENE_COUNT で上書き可）。
export const SCENE_COUNT = Number(process.env.SCENE_COUNT ?? 5);

// strict モードでは minItems/maxItems が使えないため、シーン数はプロンプトと
// 後段のバリデーションで担保する。
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "tagline", "presents", "release_line", "cast_lines", "interstitials", "scenes"],
  properties: {
    title: {
      type: "string",
      description: "映画予告のタイトル。日本語10文字前後の力強い体言止め。",
    },
    tagline: {
      type: "string",
      description: "タイトルの下に出す一行のタグライン。日本語 12 字以内。結末を示さず問いか宣言で終える（例: 夜明けは、来るのか。）。",
    },
    presents: {
      type: "string",
      description: "冒頭カードの「○○ PRESENTS」。エピソードから所属・チームを推定する。20 字以内。",
    },
    release_line: {
      type: "string",
      description: "エンドカードの公開表記。日本語 12 字以内（例: この冬、社内公開）。",
    },
    cast_lines: {
      type: "array",
      description: "エンドカードに小さく載せる登場人物の役職名。2〜3 個、各 10 字以内。実在の人名は使わない。",
      items: { type: "string" },
    },
    interstitials: {
      type: "array",
      description: "黒背景に白文字で挟む中間カード。ちょうど 2 枚。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "after_scene"],
        properties: {
          text: { type: "string", description: "日本語 10 字以内の断言（例: この夏 / 誰も、逃げられない）。" },
          after_scene: { type: "integer", description: "何番のシーンの直後に挟むか（1 始まり。最終シーンの後には置かない）。" },
        },
      },
    },
    scenes: {
      type: "array",
      description: `シーンの配列。必ずちょうど ${SCENE_COUNT} 要素。`,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "narration", "telop", "image_prompt", "video_prompt", "duration_sec",
          "scene_type", "cut_count", "motion_beat", "camera_beat", "ambient",
          "dialogue", "speaker", "telop_timing", "screen_text",
        ],
        properties: {
          narration: {
            type: "string",
            description: "日本語のナレーション。1シーンあたり1文、15字前後を目安（多少前後してよい）。低音の予告ナレーターがテンポよく読む前提。",
          },
          telop: {
            type: "string",
            description: "画面下部に出す日本語テロップ。12字以内。改行なし。ナレの要約ではなく断言。",
          },
          image_prompt: {
            type: "string",
            description: "英語の画像生成プロンプト。映画的な1カットの静止画を描写する。文字は入れない。",
          },
          video_prompt: {
            type: "string",
            description:
              "英語の動画生成プロンプト。camera_beat と motion_beat を1文にまとめたもの。外見（色調・レンズ）は書かない（コード側で付与する）。",
          },
          duration_sec: {
            type: "number",
            description: "このシーンの尺（秒）。Veo の制約に合わせて 4 / 6 / 8 のいずれか。",
          },
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
            description: "英語。被写体の力のある動作を1つだけ（slams / bolts / sprints / wrenches など）。静的な動作は禁止。",
          },
          camera_beat: {
            type: "string",
            description: "英語。Veo 公式のカメラ語彙を1つだけ（dolly in / tracking shot / crane / handheld / whip pan / rack focus / low angle / extreme close-up など）。",
          },
          ambient: {
            type: "string",
            description: "英語。そのシーンで鳴っている環境音を 2〜4 語で（例: server fans, distant thunder）。音楽は書かない。",
          },
          dialogue: {
            type: "string",
            description: `登場人物の日本語の決め台詞。6〜14字。無い場合は空文字。予告全体で 2〜${MAX_DIALOGUE} 本だけ、turn / montage / resolve のいずれかに置く。`,
          },
          speaker: { type: "string", enum: SPEAKERS, description: "dialogue の話者。dialogue が空なら none。" },
          telop_timing: {
            type: "string",
            enum: TELOP_TIMINGS,
            description: "cut_head = カット頭に叩きつける（turn / montage 向き）、after_narration = ナレの決め言葉に合わせる。",
          },
          screen_text: {
            type: "array",
            description: "画面内の小テロップ。英数字中心で 0〜2 個、各 12 文字以内（例: 02:14 AM / ALERT）。不要なら空配列。",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `あなたはハリウッド映画の予告編（トレーラー）を作る構成作家 兼 編集・演出担当です。
入力された「実際にあった出来事（社内エピソード）」を、大げさで熱い映画予告に仕立ててください。

# 構成（全${SCENE_COUNT}シーン）
Cold Open → Act1 → Act2 → Act3 → Button の予告文法に当てはめる。
1. cold_open —「その日……」の静かな立ち上がり。**冒頭3秒で強いビジュアルを1つ**立てる
2. setup   —「しかし……」で始まる不穏な展開
3. turn    — 最も追い詰められた瞬間。短い言葉で畳みかける
4. montage — 反撃。「今、__が動き出す」
5. resolve — 締め。**結末は示さない**。問いか宣言で終える
※ ${SCENE_COUNT} が 5 以外のときは、この流れを ${SCENE_COUNT} 個に圧縮／分割する。

${COPY_PRINCIPLES}

# ナレーション（narration）
- 日本語。1シーンにつき1文、**15字前後が目安**（12〜20字程度）。体言止めと余韻を多用し、長い説明はしない。
- 予告編の常套句を織り込む: 「その日……」「しかし」「誰も知らなかった」「この夏」「今、動き出す」。
- 誇張は歓迎。人を貶めない。社内で見せて笑える範囲に収める。
- 固有名詞（人名・製品名）は入力に出てきたものだけ使う。無ければ役割名（若きエンジニア、チーム）で表す。

# テロップ（telop）
- 日本語12字以内。ナレーションの要約ではなく**断言**。記号は「、」「。」を使わない（「―」「…」は可）。改行しない。

# 尺とカット割り（duration_sec / cut_count）
- duration_sec は**降順ランプ**を基本にする: 先頭から 6, 5, 4, 4, 4（Veo の制約で 4 / 6 / 8 のみ。5 は使えないので 6 か 4 に寄せる）。
- cut_count は先頭から 1, 1, 2, 3, 3。終盤ほどカットを細かく割る。

# 画像プロンプト（image_prompt）
- 英語。1カットの映画的な静止画として成立する描写（被写体・構図・光・雰囲気）。
- **舞台は予告全体で最低3箇所に散らす**（オフィスだけにしない。屋外・車内・屋上・階段・サーバ室・街など）。
- **脅威・障害を具体的な視覚要素で1つ描く**（赤い警告灯、カウントダウン、割れたガラス、迫る影 など。抽象的にしない）。
- ショットサイズをシーンごとに変える（wide → medium → close-up → extreme close-up）。
- 動きの余白（headroom / lead room）を残す。極端なクローズアップと手の複雑な動作は避ける。
- 現代日本の情景。画面内に文字・ロゴ・字幕を描かせない。実在人物の名前や特定できる顔立ちは指定しない。

# 動きの指示（video_prompt / motion_beat / camera_beat / ambient）
- motion_beat は**力の動詞**を1つ（push, pull, strike, slam, bolt, sprint, hurl, wrench）。「座って見つめる」のような静的な動作は禁止。
- camera_beat は Veo 公式語彙を1つ（dolly in / tracking shot / crane / handheld push-in / whip pan / rack focus / low angle / top-down）。
- video_prompt は「camera_beat + motion_beat」を英語1文にまとめる。外見（色調・レンズ・グレイン）は書かない。
- ambient はそのシーンで実際に鳴っている音を英語 2〜4 語で。音楽は書かない。

# セリフ（dialogue）
- **予告全体で 2〜${MAX_DIALOGUE} 本だけ**。それ以外のシーンは空文字。turn / montage / resolve のいずれかに置く。
- 現場で切迫して発する一言。6〜14字。命令形・宣言・問いのいずれか。説明しない。

# 画面内テロップ（screen_text）
- モニタや時計に映る「実在する表示」として自然なものだけ。英数字中心。緊張が高いシーンに 1〜2 個、静かなシーンは空配列。

# カード（presents / interstitials / release_line / tagline / cast_lines）
- interstitials はちょうど 2 枚。中盤の切れ目に挟む短い断言。

出力は指定された JSON スキーマに厳密に従い、scenes は必ずちょうど ${SCENE_COUNT} 要素にすること。`;

/** strict モードの json_schema として使える形かをローカルで検証する（--dry-run 用）。 */
export function validateSchema(node, path = "$") {
  const errs = [];
  if (node.type === "object") {
    if (node.additionalProperties !== false) errs.push(`${path}: additionalProperties: false が必要`);
    const props = Object.keys(node.properties ?? {});
    const req = node.required ?? [];
    for (const k of props) if (!req.includes(k)) errs.push(`${path}: required に ${k} が無い（strict では全プロパティ必須）`);
    for (const k of req) if (!props.includes(k)) errs.push(`${path}: required の ${k} が properties に無い`);
    for (const [k, v] of Object.entries(node.properties ?? {})) errs.push(...validateSchema(v, `${path}.${k}`));
  } else if (node.type === "array") {
    for (const k of ["minItems", "maxItems", "uniqueItems"]) {
      if (k in node) errs.push(`${path}: strict では ${k} を使えない`);
    }
    if (node.items) errs.push(...validateSchema(node.items, `${path}[]`));
  }
  return errs;
}

/** モデル出力を正規化する（旧 script.json との互換のため既定値で埋める）。 */
function normalize(data, episode) {
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) throw new Error("scenes が空です");
  if (data.scenes.length !== SCENE_COUNT) {
    console.warn(`  [warn] scenes が ${data.scenes.length} 件でした → ${SCENE_COUNT} 件に調整します`);
    data.scenes = data.scenes.slice(0, SCENE_COUNT);
    while (data.scenes.length < SCENE_COUNT) data.scenes.push({ ...data.scenes[data.scenes.length - 1] });
  }
  const n = data.scenes.length;

  // セリフは全体で MAX_DIALOGUE 本まで（cold_open / setup には置かせない）
  const allowed = new Set(["turn", "montage", "resolve"]);
  let kept = 0;

  data.scenes = data.scenes.map((s, i) => {
    const type = SCENE_TYPES.includes(s.scene_type) ? s.scene_type : guessSceneType(i, n);
    const rawDlg = String(s.dialogue ?? "").replace(/[\r\n]+/g, " ").trim();
    const dialogue = rawDlg && allowed.has(type) && kept < MAX_DIALOGUE ? (kept++, rawDlg.slice(0, 20)) : "";
    return {
      narration: String(s.narration ?? "").trim(),
      telop: String(s.telop ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 15),
      image_prompt: String(s.image_prompt ?? "").trim(),
      video_prompt: String(s.video_prompt ?? "").trim(),
      // Veo は 4 / 6 / 8 秒のみ。narration.mjs がナレ実尺に応じて丸め上げる。
      duration_sec: [4, 6, 8].includes(Number(s.duration_sec)) ? Number(s.duration_sec) : 4,
      index: i + 1,
      scene_type: type,
      cut_count: Math.max(1, Math.min(4, Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type]))),
      motion_beat: String(s.motion_beat ?? "").trim(),
      camera_beat: String(s.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(s.ambient ?? "").trim(),
      dialogue,
      speaker: dialogue && SPEAKERS.includes(s.speaker) && s.speaker !== "none" ? s.speaker : dialogue ? "male_mature" : "none",
      telop_timing: TELOP_TIMINGS.includes(s.telop_timing)
        ? s.telop_timing
        : ["turn", "montage"].includes(type) ? "cut_head" : "after_narration",
      screen_text: (Array.isArray(s.screen_text) ? s.screen_text : [])
        .map((t) => String(t).replace(/[\r\n]+/g, " ").trim())
        .filter((t) => t && t.length <= 14)
        .slice(0, 2),
    };
  });

  data.title = String(data.title ?? "無題").replace(/[\r\n]+/g, " ").trim();
  data.tagline = String(data.tagline ?? "").replace(/[\r\n]+/g, " ").trim();
  data.presents = String(data.presents ?? "").replace(/[\r\n]+/g, " ").trim();
  data.release_line = String(data.release_line ?? "").replace(/[\r\n]+/g, " ").trim();
  data.cast_lines = (Array.isArray(data.cast_lines) ? data.cast_lines : [])
    .map((t) => String(t).replace(/[\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 3);
  data.interstitials = (Array.isArray(data.interstitials) ? data.interstitials : [])
    .map((it) => ({
      text: String(it?.text ?? "").replace(/[\r\n]+/g, " ").trim(),
      after_scene: Math.max(1, Math.min(n - 1, Math.round(Number(it?.after_scene) || 1))),
    }))
    .filter((it) => it.text)
    .slice(0, 2);
  data.episode = episode;
  data.model = MODELS.script;
  data.created_at = new Date().toISOString();
  // enrich.mjs と同じ「拡張済み」マーカー。render はこれを見てカット割り等を有効にする。
  data.enriched = true;
  return data;
}

export async function generateScript(episode, job) {
  const openai = getOpenAI();
  const { result, usage, sec, cost } = await timed(job, "script", async () => {
    const resp = await openai.responses.create({
      model: MODELS.script,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `次のエピソードを映画予告の台本にしてください。\n\n---\n${episode}\n---` },
      ],
      text: { format: { type: "json_schema", name: "trailer_script", strict: true, schema: SCHEMA } },
    });
    return { result: resp, usage: resp.usage, model: MODELS.script };
  });

  const raw = result.output_text ?? "";
  if (!raw) throw new Error(`モデルからテキスト出力が得られませんでした:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);

  const data = normalize(JSON.parse(raw), episode);
  writeScript(job, data);

  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`[script] ${jobPaths(job).script}`);
  console.log(`  title: ${data.title}${data.tagline ? ` / ${data.tagline}` : ""}`);
  console.log(`  presents: ${data.presents || "(なし)"} / release: ${data.release_line || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  console.log(`  scenes: ${data.scenes.length} / 合計 ${total.toFixed(1)}s`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / 「${s.dialogue}」` : "";
    console.log(`   s${s.index} [${s.scene_type}] ${s.duration_sec}s cut=${s.cut_count} ${s.telop} — ${s.narration}${dlg}`);
  }
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, sec, cost, usage };
}

// 直接実行された場合
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--dry-run")) {
    const errs = validateSchema(SCHEMA);
    console.log("---- SYSTEM PROMPT ----");
    console.log(SYSTEM_PROMPT);
    console.log("\n---- JSON SCHEMA (strict) ----");
    console.log(JSON.stringify(SCHEMA, null, 2));
    console.log(`\n---- 検証 ----`);
    if (errs.length) {
      for (const e of errs) console.error(`  NG ${e}`);
      process.exit(1);
    }
    console.log("  OK: strict モードで使える形です（API は呼んでいません）");
    process.exit(0);
  }
  const pos = args.filter((a) => !a.startsWith("--"));
  const [episode, job = "demo1"] = pos;
  if (!episode) {
    console.error('usage: node scripts/script.mjs "<エピソード文>" <job>   /   node scripts/script.mjs --dry-run');
    process.exit(1);
  }
  await generateScript(episode, job);
}
