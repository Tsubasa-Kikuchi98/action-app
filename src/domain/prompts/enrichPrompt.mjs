// ①' 演出付与（enrich）の JSON スキーマとシステムプロンプト（純粋な文字列・データ）。
// 既存フィールドを一切変えずに旧 script.json を拡張するための工程なので、
// スキーマに「絵と音の中身」（narration / telop / image_prompt / duration_sec）は含めない。
import { SCENE_TYPES, TELOP_TIMINGS } from "../script/constants.mjs";
import { SPEAKERS, LOCATIONS, LOCATION_KEYS } from "../cast.mjs";
import { PARODY_PRINCIPLES, COPY_PRINCIPLES } from "./principles.mjs";

export const ENRICH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "scenes", "tagline", "interstitials", "release_line", "presents", "cast_lines",
    "button_line", "review_line", "stake",
  ],
  properties: {
    scenes: {
      type: "array",
      description: "既存シーンと同じ数・同じ順の配列。",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "index", "scene_type", "location", "cut_count", "motion_beat", "camera_beat",
          "ambient", "dialogue", "speaker", "telop_timing", "screen_text",
          "visual_metaphor",
        ],
        properties: {
          index: { type: "integer", description: "対象シーンの index（1 始まり）。" },
          scene_type: {
            type: "string",
            enum: SCENE_TYPES,
            description: "予告の構造上の役割。先頭は cold_open、末尾は resolve。",
          },
          location: {
            type: "string",
            enum: LOCATION_KEYS,
            description:
              "このシーンの舞台。既存の image_prompt に描かれている場所に最も近いキーを選ぶ" +
              `（${LOCATION_KEYS.map((k) => `${k}=${LOCATIONS[k].jp}`).join(" / ")}）。` +
              "予告全体で 2〜3 箇所に絞り、同じ場所のシーンには必ず同じキーを使う。",
          },
          cut_count: {
            type: "integer",
            description: "このシーンを何カットに割るか。基準は先頭から 1,1,2,4,3。montage だけ 6 まで、他は 4 まで。",
          },
          visual_metaphor: {
            type: "string",
            description:
              "日本語 1 行。この失敗を何のアクション演出に翻訳したかを書く（例: 本番 DB 削除 → サーバーラックの連鎖爆発）。" +
              "motion_beat はこの翻訳に従うこと。言葉（ナレ・テロップ）はこの比喩に引きずられない。",
          },
          motion_beat: {
            type: "string",
            description: "英語。visual_metaphor を実行する被写体の力のある動作を 1 つだけ（例: slams a fist on the desk / bolts upright from the chair）。Veo 再生成用。",
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
            description: "テロップの出し方。cut_head = カット頭に叩きつける（turn / montage 向き）、after_narration = ナレの決め言葉に合わせる、on_silence = 音を一瞬落としてテロップだけを見せる（予告全体で 0〜1 回）。",
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
    button_line: {
      type: "string",
      description:
        "タイトルカードの後に一言だけ置く「落ち」。8〜14 字。大仰さを捨てて現実に戻る素の一言" +
        "（例: で、これ誰がやるの / 再起動したら直りました / 明日も定時では帰れない）。予告で最も重要な笑いどころ。",
    },
    review_line: {
      type: "string",
      description:
        "煽りテロップのパロディ。12 字以内（例: 情シスが泣いた / 全社員が震撼 / 経理部、絶句）。「全米が泣いた」の社内版。実在媒体名は使わない。",
    },
    stake: {
      type: "string",
      description:
        "賭け金の数値表現。12 字以内で必ず数字を含める（例: 残された時間は 3 分 / 被害総額 1,200 円 / 復旧まであと 2 手）。小さいほど可笑しい。",
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

export function buildEnrichSystemPrompt(n) {
  return `あなたはハリウッド映画の予告編（トレーラー）の編集・演出担当です。
すでに完成している ${n} シーンの台本に、**演出情報だけ**を追加します。
ナレーション・テロップ・画像プロンプト・尺は既に確定していて変更できません。与えられたものに合わせて演出を設計してください。

${PARODY_PRINCIPLES}

${COPY_PRINCIPLES}

# 構造（scene_type）
Cold Open → Act1 → Act2 → Act3 → Button の予告文法に当てはめる。
先頭は必ず cold_open、末尾は必ず resolve。間は setup → turn → montage の順に緊張を上げる。

# カット割り（cut_count）
終盤ほどカットを細かくする（カットランプ）。基準は先頭から 1, 1, 2, 4, 3。**montage だけ 6 まで**、他の scene_type は 4 まで。
1 カットあたり 0.9 秒を下回らないよう、短いシーンでは無理に増やさない。

# 舞台（location）
舞台は次のキーから選ぶ: ${LOCATION_KEYS.map((k) => `${k}（${LOCATIONS[k].jp}）`).join(" / ")}。
**予告全体で 2〜3 箇所に絞る。同じ場所のシーンは必ず同じ location キーを使う。**
既存の image_prompt に書かれている場所に最も近いキーを選ぶこと（絵は作り直さない）。

# 視覚の翻訳（visual_metaphor）
各シーンに「この失敗を何のアクション演出に翻訳したか」を日本語 1 行で書く（例: 本番 DB 削除 → サーバーラックの連鎖爆発）。
既存の image_prompt から離れすぎないこと（絵は作り直さない）。motion_beat はこの翻訳を実行する動作にする。

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

# 落ち・煽り・賭け金（button_line / review_line / stake）
- **button_line**: タイトルカードの後に置く「落ち」。8〜14 字。重厚さを一切捨てた素の一言で現実に戻す（例: で、これ誰がやるの / 再起動したら直りました）。ここが一番の笑いどころ。
- **review_line**: 煽りテロップのパロディ。12 字以内（例: 情シスが泣いた / 全社員が震撼）。実在媒体名は使わない。
- **stake**: 賭け金。12 字以内で**必ず数字を含める**（例: 残された時間は 3 分 / 被害総額 1,200 円）。小さいほど可笑しい。
- 2 枚目の中間カード（after_scene = 3）の文言には stake をそのまま使ってよい。

# セリフの 4 つの役割（trailer-structure §6）
1. 拒絶／宣告（turn の頭）2. 号砲（montage の頭）3. 息継ぎ（montage 後半の軽口）4. 落ち（= button_line）
説明台詞は禁止。

# 中間カードの位置
1 枚目は after_scene 2（1/3 地点・時期宣言「この夏、」など）、2 枚目は after_scene 3（montage 直前・賭け金 = stake）。

# エンドカード
- release_line は日本式表記（「__月__日、社内公開」「近日、社内公開」「この冬、全社ロードショー」）。
- cast_lines は Pedigree Card のパロディ。**役職名だけを重々しく**並べる（「主演 経理部 課長」「特別出演 情シス」）。実名は使わない。

出力は指定された JSON スキーマに厳密に従い、scenes は必ずちょうど ${n} 要素、index は 1 から ${n} まで昇順にすること。`;
}
