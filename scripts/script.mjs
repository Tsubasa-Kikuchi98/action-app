// ① 台本生成: エピソード文 → out/<job>/script.json
// 使い方: node scripts/script.mjs "<エピソード文>" <job> [--style=narration|dialogue]
//         node scripts/script.mjs --dry-run          （API を呼ばずスキーマとプロンプトだけ検証）
//         TRAILER_STYLE=dialogue node scripts/script.mjs "<エピソード文>" <job>
//
// Responses API + Structured Outputs（json_schema / strict）で
// { title, tagline, presents, release_line, cast_lines, interstitials,
//   button_line, review_line, stake, style,
//   scenes: [{ narration, telop, image_prompt, video_prompt, duration_sec,
//              scene_type, cut_count, motion_beat, camera_beat, ambient,
//              visual_metaphor, dialogue, speaker, telop_timing, screen_text }] } を得る。
//
// Phase 3（コンセプト版）: 「仕事の失敗をアクション映画の予告編にして笑う」パロディの原理を
// プロンプトの中心に置く。形式は本物の予告に 100% 忠実・中身は日常のまま・視覚だけハリウッドに翻訳。
// 既存ジョブは scripts/enrich.mjs で同じフィールドを後付けできる（旧 script.json 互換）。
import { getOpenAI, MODELS, timed, writeScript, jobPaths, fmtUSD, isMain } from "./lib.mjs";
import {
  SCENE_TYPES, SPEAKERS, TELOP_TIMINGS, STYLES, DEFAULT_STYLE, DEFAULT_CUT_COUNT,
  DEFAULT_CAMERA_BEAT, DURATION_RAMP, COPY_PRINCIPLES, PARODY_PRINCIPLES,
  guessSceneType, cutCap, maxDialogue, findForbidden,
} from "./enrich.mjs";

// Phase 2: 全シーンを Veo で動画化するため 5 シーン構成。
// 8 秒固定のモデルに切り替えた場合は 3 に落とす（env SCENE_COUNT で上書き可）。
export const SCENE_COUNT = Number(process.env.SCENE_COUNT ?? 5);

/** ナレーションの合計字数の上限（trailer-structure §9-2）。超えたら warn する。 */
export const NAR_TOTAL_MAX = Number(process.env.NAR_TOTAL_MAX ?? 80);

// strict モードでは minItems/maxItems が使えないため、シーン数はプロンプトと
// 後段のバリデーションで担保する。
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "tagline", "presents", "release_line", "cast_lines", "interstitials",
    "button_line", "review_line", "stake", "style", "scenes",
  ],
  properties: {
    title: {
      type: "string",
      description: "映画予告のタイトル。日本語10文字前後の力強い体言止め。中身は日常のまま（大げさな言い換えをしない）。",
    },
    tagline: {
      type: "string",
      description: "タイトルの下に出す一行のタグライン。日本語 12 字以内。結末を示さず問いか宣言で終える（例: 夜明けは、来るのか。）。",
    },
    presents: {
      type: "string",
      description: "冒頭カードの「○○ PRESENTS」。エピソードから所属・チームを推定する。20 字以内。",
    },
    review_line: {
      type: "string",
      description:
        "煽りテロップのパロディ（「全米が泣いた」の社内版）。12 字以内。" +
        "**出来事の説明ではなく、これを観た誰かの大げさな反応**を書く（例: 情シスが泣いた / 全社員が震撼 / 経理部、絶句）。" +
        "「〜が起きた」「全員が〜した」のような事実の要約は不可。実在の媒体名・人名は使わない。",
    },
    stake: {
      type: "string",
      description:
        "賭け金の数値表現。12 字以内で**必ず数字を含める**（例: 残された時間は 3 分 / 被害総額 1,200 円 / 復旧まであと 2 手）。" +
        "値が小さく具体的なほど可笑しい。エピソードから実際に読み取れる数字を優先する。",
    },
    button_line: {
      type: "string",
      description:
        "タイトルカードの後に置く「落ち」。8〜14 字。重厚さを完全に捨てた素の一言で現実に戻す" +
        "（例: で、これ誰がやるの / 再起動したら直りました / 明日も定時では帰れない）。予告で最大の笑いどころ。",
    },
    style: {
      type: "string",
      enum: STYLES,
      description: "narration = 案 A（ナレ主導・既定）、dialogue = 案 B（セリフとテロップ主導、ナレは 2 本だけ）。指示された方をそのまま返す。",
    },
    release_line: {
      type: "string",
      description: "エンドカードの公開表記。日本式（例: この冬、社内公開 / 近日、社内公開 / 七月十日、全社公開）。12 字以内。",
    },
    cast_lines: {
      type: "array",
      description:
        "エンドカードの Pedigree Card のパロディ。**役職名だけ**を重々しく 2〜3 個、各 10 字以内" +
        "（例: 主演 経理部 課長 / 特別出演 情シス）。実在の人名は使わない。",
      items: { type: "string" },
    },
    interstitials: {
      type: "array",
      description: "黒背景に白文字で挟む中間カード。ちょうど 2 枚。1 枚目は after_scene 2、2 枚目は after_scene 3。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "after_scene"],
        properties: {
          text: { type: "string", description: "日本語 10 字以内の断言（例: この夏 / 誰も、逃げられない）。2 枚目は stake をそのまま使ってよい。" },
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
          "scene_type", "cut_count", "visual_metaphor", "motion_beat", "camera_beat",
          "ambient", "dialogue", "speaker", "telop_timing", "screen_text",
        ],
        properties: {
          narration: {
            type: "string",
            description:
              "日本語のナレーション。1シーン1文。低音の予告ナレーターが重々しく読む前提だが、" +
              "**出来事は大げさに言い換えない**（起きた事実をそのまま読む）。style が dialogue のシーンでは空文字にしてよい。",
          },
          telop: {
            type: "string",
            description: "画面下部に出す日本語テロップ。12字以内。改行なし。ナレの要約ではなく断言。型カタログから選び、同じ型を 2 回使わない。",
          },
          image_prompt: {
            type: "string",
            description: "英語の画像生成プロンプト。visual_metaphor をそのまま絵にした映画的な1カット。文字は入れない。",
          },
          video_prompt: {
            type: "string",
            description:
              "英語の動画生成プロンプト。camera_beat と motion_beat を1文にまとめたもの。外見（色調・レンズ）は書かない（コード側で付与する）。",
          },
          duration_sec: {
            type: "number",
            description: `このシーンの尺（秒）。Veo の制約で 4 / 6 / 8 のみ。基準は先頭から ${DURATION_RAMP.join(", ")}（montage が最長）。`,
          },
          scene_type: {
            type: "string",
            enum: SCENE_TYPES,
            description: "予告の構造上の役割。先頭は cold_open、末尾は resolve。",
          },
          cut_count: {
            type: "integer",
            description: "このシーンを何カットに割るか。基準は先頭から 1,1,2,4,3。**montage だけ 6 まで**、他は 4 まで。",
          },
          visual_metaphor: {
            type: "string",
            description:
              "日本語 1 行。この失敗を何のアクション演出に翻訳したかを「現実 → 演出」の形で書く" +
              "（例: 本番 DB 削除 → サーバーラックの連鎖爆発）。image_prompt と motion_beat はこれに従う。" +
              "ナレとテロップはこの比喩に引きずられない（言葉は日常のまま）。",
          },
          motion_beat: {
            type: "string",
            description: "英語。visual_metaphor を実行する力のある動作を1つだけ（slams / bolts / sprints / wrenches など）。静的な動作は禁止。",
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
            description:
              "登場人物の日本語の決め台詞。6〜14字。無い場合は空文字。turn / montage / resolve のいずれかに置く。" +
              "役割は 1 拒絶（turn の頭）2 号砲（montage の頭）3 息継ぎ（montage 後半の軽口）。説明台詞は禁止。",
          },
          speaker: { type: "string", enum: SPEAKERS, description: "dialogue の話者。dialogue が空なら none。" },
          telop_timing: {
            type: "string",
            enum: TELOP_TIMINGS,
            description:
              "cut_head = カット頭に叩きつける（turn / montage 向き）、after_narration = ナレの決め言葉に合わせる、" +
              "on_silence = 音を一瞬落としてテロップだけを見せる（予告全体で 0〜1 回まで）。",
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

/** style 別の構成指示（trailer-structure §8 案 A / 案 B）。 */
function structureBlock(style) {
  if (style === "dialogue") {
    return `# 構成（案 B: セリフ・テロップ主導 / 30 秒）
| 秒 | 要素 | 中身 |
|---|---|---|
| 0.0-3.2 | S1 cold_open | **ナレなし**。環境音だけ。強いビジュアル 1 つ |
| 3.2-4.4 | 文字カード① | 「その日、」 |
| 4.4-8.4 | S2 setup（2 カット） | **セリフ①（状況）** ＋ 画面内テロップ |
| 8.4-9.4 | 文字カード② | 「しかし、」 |
| 9.4-13.8 | S3 turn（3 カット） | **セリフ②（切迫）** ＋ テロップ |
| 13.8-15.4 | 唯一のナレ① | 「__に、逃げ場はない」 |
| 15.4-16.4 | 文字カード③ | 賭け金 = stake |
| 16.4-22.4 | S4 montage（最大 6 カット） | **セリフ③（号砲）**、テロップ |
| 22.4-24.8 | S5 resolve | ナレ②（短く）＋ **セリフ④（決め台詞）** |
| 24.8-25.5 | stopdown | 黒＋無音 |
| 25.5-28.6 | タイトル | title + tagline + release_line |
| 28.6-30.0 | button | **button_line（落ち）** |

- **ナレーションは 2 本だけ**（S3 の後＝turn か montage と、resolve）。それ以外のシーンの narration は**空文字**にする。
- ナレ 1 本あたり 18〜26 字。合計 ${NAR_TOTAL_MAX} 字以内。
- セリフは 4 本（拒絶／切迫／号砲／決め台詞）。button_line が 5 つ目の「落ち」になる。
- interstitials は 2 枚のまま（1 枚目 after_scene 2、2 枚目 after_scene 3 で stake）。`;
  }
  return `# 構成（案 A: ナレーション主導 / 30 秒・既定）
| 秒 | 要素 | 中身 | ナレ字数 |
|---|---|---|---|
| 0.0-1.4 | 提供カード | 「○○ PRESENTS」 | 0 |
| 1.4-6.0 | S1 cold_open（1 カット） | 静かなワイド「その日……」 | 16 |
| 6.0-10.4 | S2 setup（2 カット） | 「しかし……」＋ テロップ① | 16 |
| 10.4-11.8 | 中間カード① | 時期宣言「この夏、」 | 0 |
| 11.8-16.2 | S3 turn（4 カット） | 畳みかけ ＋ **セリフ①（拒絶）** | 14 |
| 16.2-17.0 | 中間カード② | 賭け金 = stake | 0 |
| 17.0-22.6 | S4 montage（5〜6 カット） | 短いナレ ＋ テロップ② ＋ **セリフ②（号砲）** | 11 |
| 22.6-25.4 | S5 resolve（3 カット） | 「今、__が動き出す」 | 16 |
| 25.4-26.0 | stopdown | 黒＋完全無音 | 0 |
| 26.0-29.0 | タイトル | title + tagline + release_line | 0 |
| 29.0-30.0 | button | **button_line（落ち）** | 0 |

- **映像は合計 20〜22 秒**、残り 8〜10 秒はカードと無音。duration_sec の合計はこの範囲に収める。
- **ナレ字数は降順ランプ 16 / 16 / 14 / 11 / 16 字、合計 ${NAR_TOTAL_MAX} 字以内**（montage が最短）。
- セリフは 2〜3 本（拒絶＝turn の頭／号砲＝montage の頭／息継ぎ＝montage 後半）。4 本目の「落ち」は button_line。`;
}

export function buildSystemPrompt(style = "narration") {
  return `あなたはハリウッド映画の予告編（トレーラー）を作る構成作家 兼 編集・演出担当です。
入力された「実際にあった仕事の失敗」を、本物のアクション映画の予告編の形式に流し込んでください。

${PARODY_PRINCIPLES}

${COPY_PRINCIPLES}

${structureBlock(style)}

# scene_type
1. cold_open —「その日……」の静かな立ち上がり。**冒頭3秒で強いビジュアルを1つ**立てる
2. setup   —「しかし……」で始まる不穏な展開
3. turn    — 最も追い詰められた瞬間。短い言葉で畳みかける
4. montage — 反撃。「今、__が動き出す」
5. resolve — 締め。**結末は示さない**。問いか宣言で終える
※ ${SCENE_COUNT} が 5 以外のときは、この流れを ${SCENE_COUNT} 個に圧縮／分割する。

# ナレーション（narration）
- 日本語。1シーン1文。**出来事そのものは言い換えない**（「テーブルを消した」を「世界を消した」にしない）。
- **字数を必ず数えてから出力する。** 1 本ずつ指定字数以内に収め、5 本の合計を ${NAR_TOTAL_MAX} 字以内にする。超えたら語尾を削って詰める（「〜を続けた」→「〜を続けた」ではなく体言止めにする等）。
- 予告の常套句で「枠」だけ作る: 「その日……」「しかし」「誰も知らなかった」「この夏」「今、動き出す」。
- 固有名詞（人名・製品名）は入力に出てきたものだけ。無ければ役割語（若きエンジニア、チーム）で表す。
- 読みが二通りある漢字と社内語は開く（TTS の誤読対策）。

# テロップ（telop）
- 日本語12字以内。ナレの要約ではなく**断言**。記号は「、」「。」を使わない（「―」「…」は可）。改行しない。
- 型カタログ（時の提示／反転／時期宣言／賭け金／開戦／断言）から選び、**同じ型を 2 回使わない**。
- **stake / review_line / interstitials と同じ文言をテロップに使わない。**同じ言葉を画面で 2 度見せると、それだけで予告が素人くさくなる。賭け金は中間カード②の担当なのでテロップ側では言わない。

# 尺とカット割り（duration_sec / cut_count）
- duration_sec は先頭から ${DURATION_RAMP.join(", ")}（Veo の制約で 4 / 6 / 8 のみ。**montage を最長にする**）。
- cut_count は先頭から 1, 1, 2, 4, 3。montage だけ 6 まで許す。終盤ほどカットを細かく割る。

# 視覚の翻訳（visual_metaphor → image_prompt / motion_beat）
- 各シーンでまず visual_metaphor を決める（「現実 → 演出」の 1 行）。**上の翻訳文法 16 ルールに必ず沿わせる**。
- **montage と resolve は「反撃・復旧パートの翻訳」（召集 → 出動・移動 → 突入 → 作戦会議 → 決着）から選ぶ**。失敗の崩壊だけを繰り返さない。
  montage は移動・突入（走る／飛び乗る／蹴り開ける／隔壁が開く）を 1〜1.5 秒で並べられる素材にし、resolve は決着（カウントダウンが止まる／瓦礫が戻る／街に灯りが戻る／夜明け）にする。
- **窓ガラスが割れる瞬間の破片と武器は書かない**（Veo が弾く）。「割れた直後」で代替する。
- image_prompt はその演出をそのまま英語で描写する。**舞台は予告全体で最低3箇所に散らす**（オフィスだけにしない）。
- **脅威・障害を具体的な視覚要素で1つ描く**（赤い警告灯、カウントダウン、崩れるラック、迫る影）。抽象的にしない。
- ショットサイズをシーンごとに変える（wide → medium → close-up → extreme close-up）。
- 現代日本の情景。画面内に文字・ロゴ・字幕を描かせない。流血・負傷・実在ブランド・実在人物の顔は書かない。

# 動きの指示（video_prompt / motion_beat / camera_beat / ambient）
- motion_beat は**力の動詞**を1つ（push, pull, strike, slam, bolt, sprint, hurl, wrench）。静的な動作は禁止。
- camera_beat は Veo 公式語彙を1つ。video_prompt は「camera_beat + motion_beat」を英語1文に。
- ambient はそのシーンで実際に鳴っている音を英語 2〜4 語で。音楽は書かない。

# 画面内テロップ（screen_text）
- モニタや時計に映る「実在する表示」として自然なものだけ。英数字中心。緊張が高いシーンに 1〜2 個、静かなシーンは空配列。

# telop_timing
- turn / montage は cut_head、cold_open / setup / resolve は after_narration を基本にする。
- **on_silence をちょうど 1 回使う**（turn か montage のうち、最も効かせたい 1 枚）。音を一瞬落として文字だけを残す一撃で、パロディの「重厚な形式」が最も強く出る。

# style
今回は **style: "${style}"** で書くこと。出力の style フィールドにも "${style}" を入れる。

出力は指定された JSON スキーマに厳密に従い、scenes は必ずちょうど ${SCENE_COUNT} 要素にすること。`;
}

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

const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

/** モデル出力を正規化する（旧 script.json との互換のため既定値で埋める）。 */
export function normalize(data, episode, style = DEFAULT_STYLE) {
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) throw new Error("scenes が空です");
  if (data.scenes.length !== SCENE_COUNT) {
    console.warn(`  [warn] scenes が ${data.scenes.length} 件でした → ${SCENE_COUNT} 件に調整します`);
    data.scenes = data.scenes.slice(0, SCENE_COUNT);
    while (data.scenes.length < SCENE_COUNT) data.scenes.push({ ...data.scenes[data.scenes.length - 1] });
  }
  const n = data.scenes.length;
  const wantStyle = STYLES.includes(style) ? style : "narration";

  // セリフは全体で maxDialogue 本まで（cold_open / setup には置かせない）
  // 案 B（dialogue）だけは setup にも置ける（S2 のセリフ①が構成上必要なため）
  const allowed = new Set(wantStyle === "dialogue" ? ["setup", "turn", "montage", "resolve"] : ["turn", "montage", "resolve"]);
  const dlgMax = maxDialogue(wantStyle);
  let kept = 0;
  let onSilence = 0;

  data.scenes = data.scenes.map((s, i) => {
    const type = SCENE_TYPES.includes(s.scene_type) ? s.scene_type : guessSceneType(i, n);
    const rawDlg = oneLine(s.dialogue);
    const dialogue = rawDlg && allowed.has(type) && kept < dlgMax ? (kept++, rawDlg.slice(0, 20)) : "";

    let timing = TELOP_TIMINGS.includes(s.telop_timing)
      ? s.telop_timing
      : ["turn", "montage"].includes(type) ? "cut_head" : "after_narration";
    // on_silence は予告全体で 1 回まで（音を落とす演出は繰り返すと効かない）
    if (timing === "on_silence" && ++onSilence > 1) timing = "cut_head";

    return {
      narration: oneLine(s.narration),
      telop: oneLine(s.telop).slice(0, 15),
      image_prompt: String(s.image_prompt ?? "").trim(),
      video_prompt: String(s.video_prompt ?? "").trim(),
      // Veo は 4 / 6 / 8 秒のみ。narration.mjs がナレ実尺に応じて丸め上げる。
      duration_sec: [4, 6, 8].includes(Number(s.duration_sec))
        ? Number(s.duration_sec)
        : DURATION_RAMP[i] ?? 4,
      index: i + 1,
      scene_type: type,
      cut_count: Math.max(1, Math.min(cutCap(type), Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type]))),
      visual_metaphor: oneLine(s.visual_metaphor).slice(0, 60),
      motion_beat: String(s.motion_beat ?? "").trim(),
      camera_beat: String(s.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(s.ambient ?? "").trim(),
      dialogue,
      speaker: dialogue && SPEAKERS.includes(s.speaker) && s.speaker !== "none" ? s.speaker : dialogue ? "male_mature" : "none",
      telop_timing: timing,
      screen_text: (Array.isArray(s.screen_text) ? s.screen_text : [])
        .map((t) => oneLine(t))
        .filter((t) => t && t.length <= 14)
        .slice(0, 2),
    };
  });

  data.title = oneLine(data.title) || "無題";
  data.tagline = oneLine(data.tagline);
  data.presents = oneLine(data.presents);
  data.release_line = oneLine(data.release_line);
  data.style = wantStyle;
  data.button_line = oneLine(data.button_line).slice(0, 20);
  data.review_line = oneLine(data.review_line).slice(0, 14);
  data.stake = oneLine(data.stake).slice(0, 16);
  data.cast_lines = (Array.isArray(data.cast_lines) ? data.cast_lines : [])
    .map(oneLine).filter(Boolean).slice(0, 3);
  data.interstitials = (Array.isArray(data.interstitials) ? data.interstitials : [])
    .map((it) => ({
      text: oneLine(it?.text),
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

/**
 * 台本を読んで「原理を外していないか」を警告する（削除・書き換えはしない）。
 * 課金せずに何度でも回せるので、生成直後に必ず通す。
 */
export function lintScript(data) {
  const warns = [];
  const texts = [
    data.title, data.tagline, data.presents, data.release_line, data.button_line,
    data.review_line, data.stake, ...(data.cast_lines ?? []),
    ...(data.interstitials ?? []).map((it) => it.text),
    ...data.scenes.flatMap((s) => [s.narration, s.telop, s.dialogue]),
  ];
  const bad = [...new Set(texts.flatMap(findForbidden))];
  if (bad.length) warns.push(`禁句が含まれています: ${bad.join(" / ")}`);

  const narTotal = data.scenes.reduce((a, s) => a + s.narration.length, 0);
  if (narTotal > NAR_TOTAL_MAX) warns.push(`ナレ合計 ${narTotal} 字（上限 ${NAR_TOTAL_MAX} 字）`);

  if (!data.button_line) warns.push("button_line が空です（タイトル後の落ちが無い）");
  if (!data.review_line) warns.push("review_line が空です");
  if (!data.stake) warns.push("stake が空です");
  else if (!/[0-9０-９一二三四五六七八九十百千万]/.test(data.stake)) warns.push(`stake に数字がありません: ${data.stake}`);

  const noMeta = data.scenes.filter((s) => !s.visual_metaphor).map((s) => `s${s.index}`);
  if (noMeta.length) warns.push(`visual_metaphor が空: ${noMeta.join(", ")}`);
  const noArrow = data.scenes.filter((s) => s.visual_metaphor && !/[→>]/.test(s.visual_metaphor)).map((s) => `s${s.index}`);
  if (noArrow.length) warns.push(`visual_metaphor が「現実 → 演出」の形になっていない: ${noArrow.join(", ")}`);

  const dlg = data.scenes.filter((s) => s.dialogue).length;
  const wantDlg = data.style === "dialogue" ? 4 : 3;
  if (dlg < 2) warns.push(`セリフが ${dlg} 本しかありません（${data.style === "dialogue" ? "案 B は 4 本" : "2〜3 本"}）`);
  if (dlg > wantDlg) warns.push(`セリフが ${dlg} 本あります（上限 ${wantDlg}）`);

  const pos = (data.interstitials ?? []).map((it) => it.after_scene).join(",");
  if (data.scenes.length === 5 && pos !== "2,3") warns.push(`中間カードの位置が ${pos || "(なし)"}（想定は 2,3）`);

  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  if (total < 18 || total > 26) warns.push(`映像の合計尺 ${total}s（想定 20〜22s）`);

  const telops = data.scenes.map((s) => s.telop).filter(Boolean);
  if (new Set(telops).size !== telops.length) warns.push("同じテロップが 2 回出ています");

  if (data.style === "dialogue") {
    const nars = data.scenes.filter((s) => s.narration).length;
    if (nars > 2) warns.push(`案 B なのにナレが ${nars} 本あります（2 本まで）`);
  } else {
    const empty = data.scenes.filter((s) => !s.narration).map((s) => `s${s.index}`);
    if (empty.length) warns.push(`案 A なのに narration が空のシーン: ${empty.join(", ")}`);
  }
  return warns;
}

export function printScript(data) {
  const total = data.scenes.reduce((a, s) => a + s.duration_sec, 0);
  console.log(`  title: ${data.title}${data.tagline ? ` / ${data.tagline}` : ""}`);
  console.log(`  style: ${data.style} / presents: ${data.presents || "(なし)"} / release: ${data.release_line || "(なし)"}`);
  console.log(`  review: ${data.review_line || "(なし)"} / stake: ${data.stake || "(なし)"}`);
  console.log(`  button: ${data.button_line || "(なし)"} / cast: ${data.cast_lines.join(" / ") || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  console.log(`  scenes: ${data.scenes.length} / 合計 ${total.toFixed(1)}s`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / 「${s.dialogue}」(${s.speaker})` : "";
    console.log(`   s${s.index} [${s.scene_type}] ${s.duration_sec}s cut=${s.cut_count} ${s.telop_timing}`);
    console.log(`      ナレ: ${s.narration || "(なし)"}${dlg}`);
    console.log(`      テロップ: ${s.telop} / 翻訳: ${s.visual_metaphor || "(なし)"}`);
  }
}

export async function generateScript(episode, job, { style = DEFAULT_STYLE } = {}) {
  const openai = getOpenAI();
  const wantStyle = STYLES.includes(style) ? style : "narration";
  const systemPrompt = buildSystemPrompt(wantStyle);
  const { result, usage, sec, cost } = await timed(job, "script", async () => {
    const resp = await openai.responses.create({
      model: MODELS.script,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `次の「仕事で起きた失敗」を映画予告の台本にしてください（style: ${wantStyle}）。\n\n---\n${episode}\n---` },
      ],
      text: { format: { type: "json_schema", name: "trailer_script", strict: true, schema: SCHEMA } },
    });
    return { result: resp, usage: resp.usage, model: MODELS.script };
  }, { style: wantStyle });

  const raw = result.output_text ?? "";
  if (!raw) throw new Error(`モデルからテキスト出力が得られませんでした:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);

  const data = normalize(JSON.parse(raw), episode, wantStyle);
  writeScript(job, data);

  console.log(`[script] ${jobPaths(job).script}`);
  printScript(data);
  const warns = lintScript(data);
  for (const w of warns) console.warn(`  [warn] ${w}`);
  console.log(`  usage: ${JSON.stringify(usage)} / ${sec.toFixed(1)}s / 推定 ${fmtUSD(cost)}`);
  return { data, sec, cost, usage, warns };
}

// 直接実行された場合
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const styleArg = args.find((a) => a.startsWith("--style="))?.split("=")[1];
  const style = STYLES.includes(styleArg ?? "") ? styleArg : DEFAULT_STYLE;

  if (args.includes("--dry-run")) {
    const errs = validateSchema(SCHEMA);
    console.log("---- SYSTEM PROMPT ----");
    console.log(buildSystemPrompt(style));
    console.log("\n---- JSON SCHEMA (strict) ----");
    console.log(JSON.stringify(SCHEMA, null, 2));
    console.log(`\n---- 検証 (style=${style}) ----`);
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
    console.error('usage: node scripts/script.mjs "<エピソード文>" <job> [--style=narration|dialogue]   /   node scripts/script.mjs --dry-run');
    process.exit(1);
  }
  await generateScript(episode, job, { style });
}
