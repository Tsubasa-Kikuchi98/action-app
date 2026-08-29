// ① 台本生成: エピソード文 → out/<job>/script.json
// 使い方: node scripts/script.mjs "<エピソード文>" <job>
//
// Responses API + Structured Outputs（json_schema / strict）で
// { title, scenes: [{ narration, telop, image_prompt, duration_sec }] } を得る。
import { getOpenAI, MODELS, timed, writeScript, jobPaths, fmtUSD, isMain } from "./lib.mjs";

// Phase 2: 全シーンを Veo で動画化するため 5 シーン構成（合計 20 秒前後）。
// 8 秒固定のモデルに切り替えた場合は 3 に落とす（env SCENE_COUNT で上書き可）。
export const SCENE_COUNT = Number(process.env.SCENE_COUNT ?? 5);

// strict モードでは minItems/maxItems が使えないため、シーン数はプロンプトと
// 後段のバリデーションで担保する。
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "scenes"],
  properties: {
    title: {
      type: "string",
      description: "映画予告のタイトル。日本語10文字前後の力強い体言止め。",
    },
    scenes: {
      type: "array",
      description: `シーンの配列。必ずちょうど ${SCENE_COUNT} 要素。`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["narration", "telop", "image_prompt", "video_prompt", "duration_sec"],
        properties: {
          narration: {
            type: "string",
            description: "日本語のナレーション。1シーンあたり1文、15字前後を目安（多少前後してよい）。低音の予告ナレーターがテンポよく読む前提。",
          },
          telop: {
            type: "string",
            description: "画面下部に出す日本語テロップ。15字以内。改行なし。",
          },
          image_prompt: {
            type: "string",
            description: "英語の画像生成プロンプト。映画的な1カットの静止画を描写する。文字は入れない。",
          },
          video_prompt: {
            type: "string",
            description:
              "英語の動画生成プロンプト。image_prompt の静止画を起点に、カメラワークと被写体の動作を1〜2文で書く。セリフ・文字は書かない（否定語はコード側で付与する）。",
          },
          duration_sec: {
            type: "number",
            description: "このシーンの尺（秒）。Veo の制約に合わせて 4 / 6 / 8 のいずれか。既定は 4。",
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `あなたはハリウッド映画の予告編（トレーラー）を作る構成作家です。
入力された「実際にあった出来事（社内エピソード）」を、大げさで熱い映画予告に仕立ててください。

# 構成（全${SCENE_COUNT}シーン・合計20秒前後）
1. 導入 —「その日、〇〇は__だった」のような静かな立ち上がり
2. 転機 —「しかし__」で始まる不穏な展開
3. 危機 — 最も追い詰められた瞬間。短い言葉で畳みかける
4. 決意・反撃 —「この夏」「今、__が動き出す」のような盛り上がり
5. 締め — タイトルコール用。作品タイトルを言い切る短い一言（「COMING SOON」は動画側で出すので書かない）
※ ${SCENE_COUNT} が 5 以外のときは、この流れを ${SCENE_COUNT} 個に圧縮／分割して割り当てる。

# ナレーション（narration）
- 日本語。1シーンにつき1文、**15字前後が目安**（12〜20字程度に収まればよい。厳密な上限ではない）。
- 体言止めと余韻を多用する。長い説明は禁止。全シーン合計で読み上げ20秒前後になる分量。
- 予告編の常套句を必ず織り込む: 「その日…」「しかし」「誰も知らなかった」「この夏」「今、動き出す」など。
- 誇張は歓迎。ただし人を貶めたり、実在人物を悪く描いたりしない。社内で見せて笑える範囲に収める。
- 固有名詞（人名・製品名）は入力に出てきたものだけ使う。無ければ役割名（若きエンジニア、チーム）で表す。

# テロップ（telop）
- 日本語15字以内。ナレーションの要約ではなく、キャッチコピーとして刺さる短い言葉。
- 記号は「、」「。」を使わない。「―」「…」は可。改行しない。

# 画像プロンプト（image_prompt）
- 英語で書く。1カットの映画的な静止画として成立する描写にする。
- 被写体・構図・光・雰囲気を含める（例: low angle, silhouette against monitor glow, rain on window）。
- 現代日本のオフィス／街を舞台にする。画面内に文字・ロゴ・字幕を描かせない。
- 実在人物の名前や特定できる顔立ちの指定はしない。

# 動画プロンプト（video_prompt）
- 英語で書く。image_prompt の静止画を起点にした 4 秒程度の動きを 1〜2 文で描写する。
- 必ず「カメラワーク」と「被写体の動作」の両方を含める
  （例: slow dolly-in as the engineer lifts his head from the monitor; handheld push-in while sparks fly past）。
- 場面転換や複数カットは書かない（1カット1モーション）。人物に喋らせない。
- 画面内の文字・字幕・ロゴを描かせない。

# 尺（duration_sec）
- **必ず 4 とする**（Veo の制約で 4 / 6 / 8 のみ。ナレの実尺に応じて後段で自動的に 6 / 8 へ丸め上げる）。

出力は指定された JSON スキーマに厳密に従い、scenes は必ずちょうど ${SCENE_COUNT} 要素にすること。`;

export async function generateScript(episode, job) {
  const openai = getOpenAI();
  const { result, usage, sec, cost } = await timed(job, "script", async () => {
    const resp = await openai.responses.create({
      model: MODELS.script,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `次のエピソードを映画予告の台本にしてください。\n\n---\n${episode}\n---`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "trailer_script",
          strict: true,
          schema: SCHEMA,
        },
      },
    });
    return { result: resp, usage: resp.usage, model: MODELS.script };
  });

  const raw = result.output_text ?? "";
  if (!raw) throw new Error(`モデルからテキスト出力が得られませんでした:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);

  const data = JSON.parse(raw);

  // --- バリデーション / 正規化 -------------------------------------------
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) {
    throw new Error("scenes が空です");
  }
  if (data.scenes.length !== SCENE_COUNT) {
    console.warn(`  [warn] scenes が ${data.scenes.length} 件でした → ${SCENE_COUNT} 件に調整します`);
    data.scenes = data.scenes.slice(0, SCENE_COUNT);
    while (data.scenes.length < SCENE_COUNT) {
      data.scenes.push({ ...data.scenes[data.scenes.length - 1] });
    }
  }
  data.scenes = data.scenes.map((s, i) => ({
    narration: String(s.narration ?? "").trim(),
    telop: String(s.telop ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 15),
    image_prompt: String(s.image_prompt ?? "").trim(),
    video_prompt: String(s.video_prompt ?? "").trim(),
    // Veo は 4 / 6 / 8 秒のみ。初期値は 4 で、narration.mjs がナレ実尺に応じて丸め上げる。
    duration_sec: [4, 6, 8].includes(Number(s.duration_sec)) ? Number(s.duration_sec) : 4,
    index: i + 1,
  }));
  data.title = String(data.title ?? "無題").replace(/[\r\n]+/g, " ").trim();
  data.episode = episode;
  data.model = MODELS.script;
  data.created_at = new Date().toISOString();

  writeScript(job, data);

  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`[script] ${jobPaths(job).script}`);
  console.log(`  title: ${data.title}`);
  console.log(`  scenes: ${data.scenes.length} / 合計 ${total.toFixed(1)}s`);
  for (const s of data.scenes) {
    console.log(`   s${s.index} (${s.duration_sec}s) ${s.telop} — ${s.narration}`);
  }
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, sec, cost, usage };
}

// 直接実行された場合
if (isMain(import.meta.url)) {
  const [episode, job = "demo1"] = process.argv.slice(2);
  if (!episode) {
    console.error('usage: node scripts/script.mjs "<エピソード文>" <job>');
    process.exit(1);
  }
  await generateScript(episode, job);
}
