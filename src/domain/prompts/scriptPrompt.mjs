// ① 台本生成の JSON スキーマとシステムプロンプト（純粋な文字列・データ）。
// 外部依存なし。API を呼ぶのは adapters/openai/text.mjs、組み立ての指揮は usecases/generateScript.mjs。
import {
  SCENE_TYPES, TELOP_TIMINGS, STYLES, SCENE_COUNT, NAR_TOTAL_MAX, DURATION_RAMP,
} from "../script/constants.mjs";
import { SPEAKERS, LOCATIONS, LOCATION_KEYS } from "../cast.mjs";
import { PARODY_PRINCIPLES, COPY_PRINCIPLES } from "./principles.mjs";

// strict モードでは minItems/maxItems が使えないため、シーン数はプロンプトと
// 後段のバリデーションで担保する。
export const SCRIPT_SCHEMA = {
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
      description: "（廃止）常に空文字を返す。タイトル後のオチのセリフは使わない。",
    },
    style: {
      type: "string",
      enum: STYLES,
      description: "narration = 案 A（ナレ主導・既定）、dialogue = 案 B（セリフとテロップ主導、ナレは 2 本だけ）。指示された方をそのまま返す。",
    },
    release_line: {
      type: "string",
      description: "最後のエンドカードに大きく出す公開表記。本物の予告の定型から選ぶ: 大ヒット上映中 / 近日公開 / この夏、公開 / 全国ロードショー。8 字以内。",
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
          "scene_type", "location", "cut_count", "visual_metaphor", "motion_beat", "camera_beat",
          "ambient", "dialogue", "speaker", "telop_timing", "screen_text", "characters",
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
          location: {
            type: "string",
            enum: LOCATION_KEYS,
            description:
              "このシーンの舞台。次から選ぶ: " +
              LOCATION_KEYS.map((k) => `${k}=${LOCATIONS[k].jp}`).join(" / ") +
              "。**予告全体で 2〜3 箇所に絞り、同じ場所のシーンには必ず同じキーを使う。**" +
              "image_prompt はここで選んだ場所と矛盾しないように書く。",
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
          speaker: { type: "string", enum: SPEAKERS, description: "dialogue の話者。hero=主人公（若手男性）/ senpai=先輩（30代前半女性）/ boss=上司（50代男性）。dialogue が空なら none。" },
          characters: {
            type: "array",
            description: "このシーンの画面に映る主要人物（hero / senpai / boss）。0〜3 個。無言の他社員は含めない。",
            items: { type: "string", enum: ["hero", "senpai", "boss"] },
          },
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
| 25.5-28.6 | タイトル | title + tagline + COMING SOON |
| 28.6-30.0 | エンドカード | **release_line（大ヒット上映中 / 近日公開）** |

- **ナレーションは 2 本だけ**（S3 の後＝turn か montage と、resolve）。それ以外のシーンの narration は**空文字**にする。
- ナレ 1 本あたり 18〜26 字。合計 ${NAR_TOTAL_MAX} 字以内。
- セリフは 4 本（拒絶／切迫／号砲／決め台詞）。button_line は使わない（空文字）。
- interstitials は 2 枚のまま（1 枚目 after_scene 2、2 枚目 after_scene 3 で stake）。`;
  }
  return `# 構成（案 A: ナレーション主導 / 30 秒・既定）
| 秒 | 要素 | 中身 | ナレ字数 |
|---|---|---|---|
| 0.0-1.4 | 提供カード | 「○○ PRESENTS」 | 0 |
| 1.4-6.0 | S1 cold_open（1 カット） | 静かなワイド「その日……」 | 16 |
| 6.0-10.4 | S2 setup（2 カット） | 「しかし……」＋ テロップ① | 16 |
| 10.4-11.8 | 中間カード① | 時期宣言「この夏、」 | 0 |
| 11.8-16.2 | S3 turn（4 カット） | **セリフ①（拒絶）** ＋ テロップ。ナレなし | 0 |
| 16.2-17.0 | 中間カード② | 賭け金 = stake | 0 |
| 17.0-22.6 | S4 montage（5〜6 カット） | **セリフ②（号砲）** ＋ テロップ②。ナレなし | 0 |
| 22.6-25.4 | S5 resolve（3 カット） | 「今、__が動き出す」 | 16 |
| 25.4-26.0 | stopdown | 黒＋完全無音 | 0 |
| 26.0-29.0 | タイトル | title + tagline + COMING SOON | 0 |
| 29.0-30.0 | エンドカード | **release_line（大ヒット上映中 / 近日公開）** | 0 |

- **映像は合計 20〜22 秒**、残り 8〜10 秒はカードと無音。duration_sec の合計はこの範囲に収める。
- **ナレ字数は降順ランプ 16 / 16 / 14 / 11 / 16 字、合計 ${NAR_TOTAL_MAX} 字以内**（montage が最短）。
- **各シーンの声は「ナレーション」か「セリフ」のどちらか一方だけ。両方は入れない。**
  - cold_open / setup / resolve = **ナレーションのみ**（dialogue は空文字）
  - turn / montage = **セリフのみ**（narration は空文字。turn＝拒絶／宣告、montage＝号砲）
  - セリフの無い声の空白はテロップと環境音が埋める。button_line は使わない（空文字）。最後はエンドカードで締める。
- ナレ字数ランプは声のあるシーンだけに適用（cold_open 16 / setup 16 / resolve 16、合計 50 字以内）。`;
}

export function buildScriptSystemPrompt(style = "narration") {
  return `あなたはハリウッド映画の予告編（トレーラー）を作る構成作家 兼 編集・演出担当です。
入力された「実際にあった仕事の失敗」を、本物のアクション映画の予告編の形式に流し込んでください。

${PARODY_PRINCIPLES}

${COPY_PRINCIPLES}

${structureBlock(style)}

# scene_type（冒頭は平和、次で発覚、最後は解決を見せずに切る）
1. cold_open — **平和な日常**。明るく穏やかなシーン（金曜の夕方、退勤、連休前の浮ついたオフィス）。**主人公**が失敗の「種」を残す（背後で回り続ける画面など）。観客だけが気づく。ナレは「その日……」の静かな立ち上がり
2. setup   — **発覚**。**先輩**が最初に問題に気づく瞬間。「しかし……」。表情が固まり、周囲が振り返る
3. turn    — 事態の深刻さが数字・言葉で突きつけられる。主人公と先輩が追い詰められる瞬間。セリフは主人公か先輩
4. montage — 対応行動（上司の召集・移動・突入・報告へ向かう）。**上司**が登場し指示を出す。セリフは上司（号砲）
5. resolve — **解決の直前で切る**。上司が受話器を取る／主人公の指が Enter に触れる／扉を開ける寸前。**結果は絶対に見せない**（復旧・請求取消・夜明け・「静かになった」は禁止）。ナレは問いか宣言で終える
※ シーン数（${SCENE_COUNT}）が 5 以外のときは、この流れをその数に圧縮／分割する。

# ナレーション（narration）
- 日本語。1シーン1文。**ナレーションは抽象的・情緒的に語る。具体的な事実（数字・金額・行動・固有名詞・「電話を取る」のような描写）は入れない。** 事実は映像・テロップ・画面内テロップ・賭け金カードが伝える。ナレは本物の映画 CM のように「時間・運命・選択・問い」の語彙で枠だけを作る。
  - 良い例: 「その日……すべては、静かに始まった。」「しかし……誰も、気づいていなかった。」「今、すべてが動き出す。」「選ぶのは、一人。」「戻れる保証は、どこにもない。」
  - 悪い例: 「請求は二十万円」「本部長が電話を取る」「ループを回したまま退勤した」（＝説明。テロップか映像に回す）
- **ナレとテロップの分担**: ナレ＝抽象（運命・時間・問い）、テロップ＝具体の断言（「連休前の夕方」「請求額」など短い事実）、画面内テロップ＝数字・時刻。
- **字数を必ず数えてから出力する。** 1 本ずつ指定字数以内に収め、5 本の合計を ${NAR_TOTAL_MAX} 字以内にする。超えたら語尾を削って詰める（「深夜まで復旧作業を続けた」→「深夜まで、復旧作業」のように体言止めにする等）。
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

# 視覚の演出（visual_metaphor → image_prompt / motion_beat）
- **これはアクション映画の予告。各シーンに「アクション映画の要素カタログ」から 1 つ以上（montage は 2 つ以上）を必ず入れる**（爆発・火花／疾走・飛び乗り／蹴り開け／群衆／豪雨・雷／スロー／乗り物／巨大な数字）。静かなオフィスドラマになっていたら書き直す。
- 各シーンでまず visual_metaphor を「**現実の出来事（そのまま）＋ アクション映画級の演出**」の 1 行で書く（例: 「連休前の退勤 → 夕日の逆光でエレベーターに乗る主人公、扉が閉まる瞬間に背後のサーバーラックが火花を散らし始める」）。**上の演出文法に必ず沿わせる**。
- **出来事を別物に置き換えない**（城門・石板・砂漠・宇宙・怪獣・ミサイル・碑文は禁止）。観客が 1 秒で何が起きているか分かること。
- **montage は対応行動**（召集・移動・突入・報告へ向かう）を 1〜1.5 秒で並べられる素材に。**resolve は解決の直前で止める**（受話器を取る・Enter に指・扉の前）。決着は映さない。
- **窓ガラスが割れる瞬間の破片と武器は書かない**（Veo が弾く）。「割れた直後」で代替する。
- image_prompt は **1 カットの静止画**（動画生成の起点フレーム）。montage でも「モンタージュ」「複数カット」を 1 枚に書かず、**最初の 1 カット（最もアクションの強い瞬間）だけ**を描く。カットの連なりは cut_count と motion_beat で表す。
- image_prompt はその演出をそのまま英語で描写する。
- **脅威・障害は実物の視覚要素で 1 つ描く**（赤く点滅する金額、回り続けるログ、火花を上げるラック、鳴り続ける電話）。抽象化しない。
- ショットサイズをシーンごとに変える（wide → medium → close-up → extreme close-up）。
- 現代日本の情景。画面内に文字・ロゴ・字幕を描かせない。流血・負傷・実在ブランド・実在人物の顔は書かない。

# 動きの指示（video_prompt / motion_beat / camera_beat / ambient）
- motion_beat は**力の動詞**を1つ（push, pull, strike, slam, bolt, sprint, hurl, wrench）。静的な動作は禁止。
- camera_beat は Veo 公式語彙を1つ。video_prompt は「camera_beat + motion_beat」を英語1文に。
- ambient はそのシーンで実際に鳴っている音を英語 2〜4 語で。音楽は書かない。

# 画面内テロップ（screen_text）
- モニタや時計に映る「実在する表示」として自然なものだけ。英数字中心。緊張が高いシーンに 1〜2 個、静かなシーンは空配列。

# 舞台（location）
- **舞台はキーで選ぶ。自由記述にしない。** 選べるのは次だけ: ${LOCATION_KEYS.map((k) => `${k}（${LOCATIONS[k].jp}）`).join(" / ")}。
- **予告全体で 2〜3 箇所に絞る。同じ場所のシーンは同じ location キーを使う。**（毎シーン舞台を変えると別作品に見える）
- image_prompt はその location と矛盾しないように書く。部屋の作り・照明・小物は基準画像側で固定されるので、image_prompt には**その場所で何が起きているか**（人物の動作・カメラ・光の変化）だけを書く。

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
