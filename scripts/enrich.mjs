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
//                dialogue / speaker / telop_timing / screen_text / visual_metaphor
//   全体      … tagline / interstitials / release_line / presents / cast_lines /
//                button_line / review_line / stake
import {
  getOpenAI, MODELS, readScript, writeScript, jobPaths,
  timed, fmtUSD, isMain,
} from "./lib.mjs";

export const SCENE_TYPES = ["cold_open", "setup", "turn", "montage", "resolve"];
export const SPEAKERS = ["none", "male_young", "male_mature", "female_young", "female_mature"];
// on_silence = 環境音とナレを一瞬だけ落として「テロップだけ」を見せる（render が 0.4 秒ゲートする）
export const TELOP_TIMINGS = ["cut_head", "after_narration", "on_silence"];

/** 台本の型。narration = 案 A（ナレ主導・既定）、dialogue = 案 B（セリフ・テロップ主導）。 */
export const STYLES = ["narration", "dialogue"];
export const DEFAULT_STYLE = STYLES.includes(process.env.TRAILER_STYLE ?? "") ? process.env.TRAILER_STYLE : "narration";

/** セリフの上限。案 A は 3 本、案 B は 4 本（拒絶／号砲／息継ぎ／落ち）。 */
export const MAX_DIALOGUE = Number(process.env.MAX_DIALOGUE ?? 3);
export const maxDialogue = (style) => (style === "dialogue" ? Math.max(4, MAX_DIALOGUE) : MAX_DIALOGUE);

/** scene_type ごとの cut_count 上限（trailer-structure §9: montage だけ 6 まで）。 */
export const CUT_CAP = { cold_open: 4, setup: 4, turn: 4, montage: 6, resolve: 4 };
export const cutCap = (type) => CUT_CAP[type] ?? 4;

/** duration_sec の既定ランプ（trailer-structure §9: montage を最長にする）。 */
export const DURATION_RAMP = [6, 4, 4, 6, 4];

/** 惹句師 関根忠郎の禁句（trailer-structure §4 / §9-4）。検出したら warn するが削除はしない。 */
export const FORBIDDEN_WORDS = ["感動", "衝撃", "絆", "涙", "愛", "奇跡", "最高傑作", "今世紀最大", "全米が泣いた"];

/** テキスト中の禁句を返す。 */
export function findForbidden(text) {
  const t = String(text ?? "");
  return FORBIDDEN_WORDS.filter((w) => t.includes(w));
}

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
      ? Math.max(1, Math.min(cutCap(type), Math.round(Number(s.cut_count) || DEFAULT_CUT_COUNT[type])))
      : 1;
    return {
      ...s,
      narration: String(s.narration ?? "").trim(),
      visual_metaphor: String(s.visual_metaphor ?? "").trim(),
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
    style: STYLES.includes(data.style) ? data.style : "narration",
    tagline: String(data.tagline ?? "").trim(),
    // Phase 3 / パロディ強化。旧 script.json には無いので空文字に落ちる（render 側で分岐）。
    button_line: enriched ? String(data.button_line ?? "").trim() : "",
    review_line: enriched ? String(data.review_line ?? "").trim() : "",
    stake: enriched ? String(data.stake ?? "").trim() : "",
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

/**
 * このアプリの核心＝「仕事の失敗をアクション映画の予告編にして笑う」ための原理。
 * docs/trailer-tropes.md（変換辞書・文法・笑いのコツ・NG）と
 * docs/trailer-structure.md §7（パロディの原理）§5（テロップ型）から構成。
 * script.mjs / enrich.mjs の両方の SYSTEM_PROMPT に埋め込む。
 */
export const PARODY_PRINCIPLES = `# このコンテンツの正体（最重要）
作るのは「仕事で起きた失敗を、アクション映画の予告編にして面白おかしく消化する」映像です。
**形式（ナレの重厚さ・カット割り・カード・音の起伏）は本物の予告に 100% 忠実に。中身は日常のまま。**その落差だけが笑いになります。

## パロディの原理（これを破ると笑いが消える）
1. **出来事を大げさな言葉に言い換えない。** 「サーバが落ちた」を「世界が終わる」と書いた瞬間に笑えなくなる。事実は事実のまま、粛々と重厚に読む。
2. **誇張してよいのは、語り口・カメラ・音・カードの重厚さだけ。** 中身（何が起きたか）は誇張しない。
3. **賭け金は具体的な数値にする。小さいほど可笑しい。**（「被害総額 1,200 円」「残された時間は 3 分」「復旧まであと 2 コマンド」）
4. **登場人物は最後まで真顔。** 誰一人ふざけない。観客だけが笑う構造にする。
5. **視覚だけはハリウッドに翻訳する。** 地味な現実（サーバ障害）を派手な絵（サーバーラックの連鎖爆発）に置き換える。ただし**言葉はそれに引きずられない**。

# 視覚の翻訳文法（image_prompt / motion_beat / visual_metaphor はこれに従う）
1. **データ消失 → 物理的な崩落・爆発**。消えた量を建造物の規模に換算（1 レコード＝棚が倒れる、全件＝街が落ちる）
2. **時間切れ・期限 → 時限装置のカウントダウン**。期限は必ず「見える数字」に（壁一面の時計、赤いデジタル表示、閉じる隔壁）
3. **見えないバグ・原因不明 → 暗闇に潜む何か**。正体は最後まで映さない。足音、水位、影、点滅だけ
4. **上司・顧客・承認プロセス → 黒服の組織／司令部／連なる城門**。人格ではなく「構造」として描く
5. **コード・システム内部 → 配線・パイプ・回路・古代の碑文**。新しいコードは光る配線、レガシーは苔むした石版
6. **デプロイ・リリース → ロケット発射／橋の爆破解体**。不可逆な一押し。カウントダウン、点火、見上げる顔
7. **ロールバック・復旧 → 時間逆行**。瓦礫が逆再生で舞い戻る。失敗なら途中で静止して再び崩れる
8. **環境差異・仕様の認識違い → 並行世界／鏡像**。同じ空間を左右に並べ、片方だけ正常。境界線に人を立たせる
9. **情報漏洩・誤送信 → 意図しない相手に届いてしまうもの**。誤射したミサイル、街頭ビジョンの機密、持ち去られるケース
10. **権限不足・接続断 → 開かない隔壁／切れた命綱**。「あと一歩なのに物理的に届かない」構図

11. **移動 → 追走・突入シーン**。現実の交通手段を 1 段階派手にする（電車 → 走り出した特急に飛び乗る、タクシー → 雨の高速を疾走、リモート接続 → ヘリからロープ降下して窓から侵入）
12. **ログイン・認証 → 金庫室・隔壁の解錠**。多要素認証は「最後の扉」
13. **原因特定 → 暗闇を照らすサーチライト／碑文の解読**
14. **復旧コマンド → 時限装置の解除**。カウントダウンは 00:03 で止める
15. **復旧完了 → 街に灯りが戻る／瓦礫が逆再生で戻る／夜明け**。歓声ではなく「静寂と真顔」
16. **チーム → 集結する部隊**。各地で同時にコートを掴む連続カット、司令室の円卓

## 反撃・復旧パートの翻訳（montage / resolve は必ずここから選ぶ）
失敗（崩壊）だけでなく、**解消に向かう行動も「召集 → 出動・移動 → 突入 → 作戦会議 → 決着」の英雄譚に翻訳する**。
地味な現実（Slack を見て PC を開く）ほど、映像を派手にする。
- 召集: 深夜のアラート → 暗い寝室に赤い回転灯、震えたスマホの瞬間に飛び起きる／「全員集合」の Slack → 街のビルの窓が次々灯り、各地で同時にコートを掴んで走り出す
- 出動・移動: 終電で会社へ → 走り出した特急のデッキに飛び乗る／タクシー → 雨の高速を疾走、ハンドルを切る手のアップ／リモート接続 → 屋上のヘリからロープ降下しオフィスの窓から侵入、ケーブルを差した瞬間に画面が緑に灯る
- 突入: オフィス到着 → 自動ドアを蹴り開けてスローで入場、背後で照明が順に点く／サーバールームへ → 長い廊下を走り、厚い隔壁が冷気と青い光とともに開く／本番ログイン → 金庫室の最後の扉が重い音で開く
- 作戦会議: 状況整理 → 円卓にネットワーク図を広げ全員が一点を見る、誰かが赤いペンで丸を打つ／原因特定 → 暗闇をサーチライトが走り「それ」を照らし出す
- 決着: 復旧コマンド → 時限装置の解除、カウントダウンが 00:03 で止まる、Enter を押す指をスローで／ロールバック成功 → 瓦礫が逆再生で舞い戻り最後の一片が嵌まる／サービス復旧 → 停電した街が一区画ずつ灯る、夜明けの光。**歓声は出さない。全員真顔**
- **montage は 1〜1.5 秒のカットで「走る／飛び乗る／蹴り開ける／隔壁が開く」を並べる素材にする**（cut_count を多く取る理由がこれ）。
- **button で現実との対比を回収する**（ヘリで突入したのに、直したのは再起動）。

## 翻訳の例（失敗 → 演出）
- 本番 DB に DROP TABLE → Enter に指が触れた瞬間、背後の巨大サーバーラックが端から順に連鎖爆発
- バックアップが無い → 砂嵐の荒野、地平線まで続く空のラックの残骸。風にテープが転がる
- 深夜 3 時の障害コール → 真っ暗な寝室に赤い回転灯。パジャマのまま玄関を蹴り開ける
- SSL 証明書の期限切れ → 壁一面の時計が一斉に 00:00:00、赤灯とともに隔壁が次々閉じる
- Slack 誤爆 → 発射されたミサイルが目標を外れ、味方陣地へ弧を描く。管制室全員が無言
- レビュー指摘 200 件 → 取調室の机に書類が雪崩。ドアの隙間からさらに書類が差し込まれる
- 出所不明の cron → 無人の館の柱時計が毎晩同じ時刻に鳴り、地下の機械が独りで動く
- 技術的負債 → 夜の路地裏、振り返るたび背後の影が距離を詰める。走っても足音だけ近づく

# 笑いの作り方
- **大仰なナレーションで、極小の事物を語る**（「この国は、紙で動く」→ 映るのは朱肉と三文判）
- **クライマックス直後に脱力するオチ**（大爆発の次に「再起動したら直りました」）＝ button_line の役割
- **助かり方をしょぼくする**（世界を救う最終手段が Ctrl+Z、キャッシュ削除、電源入れ直し）
- **敵の正体が自分**（碑文を解読したら git blame に自分の名前）── 人を貶めずに笑える最も安全で強いオチ
- **全員真顔**。ふざけた言葉づかい・顔文字・「www」は絶対に使わない

# 禁止事項
- 人を貶めない。矛先は「システム・時間・環境」。人物は最後まで戦う主人公として描く
- 特定個人が分かる情報（実名・席・口癖・日付）は書かない。役割語（司令官、技術者）に置換する
- 実在の事故・事件・災害の模倣はしない。架空のスケールに振り切る（要塞、宇宙、怪獣）
- 動画 AI が弾く描写を書かない: 流血・負傷・実在ブランドのロゴ・実在人物の顔。結果と気配で見せる（「衝撃で書類が舞う」「影だけが迫る」）
- **窓ガラスが割れる瞬間の破片の飛散と武器は書かない**（Veo が弾く）。「割れた直後」の絵で代替する
- Veo が描きやすいもの: 走る、車、列車、ドア、廊下、隔壁、モニターの点灯、夜明け
- 属性いじり（性別・年齢・国籍・雇用形態・特定顧客）はしない

# 禁句（1 度でも使ったら書き直す）
感動 / 衝撃 / 絆 / 涙 / 愛 / 奇跡 / 最高傑作 / 今世紀最大 / 全米が泣いた

# テロップの型カタログ（**同じ型を 2 回使わない**）
- 時の提示: 「その日、」「午前 2 時 14 分」
- 反転: 「しかし、」「誰も知らなかった」
- 時期宣言: 「この夏、」「ついに、」
- 賭け金: 「残された時間は 3 分」「被害総額 1,200 円」
- 開戦: 「今、動き出す」「反撃が、始まる」
- 断言: 「全てが、変わる」「誰も、逃げられない」`;

const SCHEMA = {
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
          "index", "scene_type", "cut_count", "motion_beat", "camera_beat",
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

function buildSystemPrompt(n) {
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

// ---------------------------------------------------------------- 本体
/** 既に拡張済みかどうか（--force なしのスキップ判定に使う）。 */
export function isEnriched(data) {
  return data?.enriched === true;
}

export async function enrichScript(job, { force = false, dryRun = false } = {}) {
  const data = readScript(job);
  const n = data.scenes.length;

  // --dry-run は「既に拡張済み」でもプロンプトを確認できるよう先に処理する
  if (dryRun) {
    console.log(buildSystemPrompt(n));
    console.log("\n---- JSON SCHEMA ----");
    console.log(JSON.stringify(SCHEMA, null, 2));
    return { data, cost: 0, dryRun: true };
  }

  if (!force && isEnriched(data)) {
    console.log(`[enrich] skip (既に拡張済み。作り直すには --force)`);
    return { data, cost: 0, skipped: true };
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
      cut_count: Math.max(1, Math.min(cutCap(type), Math.round(Number(a.cut_count) || DEFAULT_CUT_COUNT[type]))),
      motion_beat: String(a.motion_beat ?? "").trim(),
      camera_beat: String(a.camera_beat ?? "").trim() || DEFAULT_CAMERA_BEAT[type],
      ambient: String(a.ambient ?? "").trim(),
      visual_metaphor: String(a.visual_metaphor ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 60),
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
  data.button_line = String(add.button_line ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 20);
  data.review_line = String(add.review_line ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 14);
  data.stake = String(add.stake ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 16);
  data.style = STYLES.includes(data.style) ? data.style : "narration";
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
  console.log(`  review: ${data.review_line || "(なし)"} / stake: ${data.stake || "(なし)"} / button: ${data.button_line || "(なし)"}`);
  console.log(`  release: ${data.release_line || "(なし)"} / cast: ${data.cast_lines.join(" / ") || "(なし)"}`);
  console.log(`  中間カード: ${data.interstitials.map((it) => `「${it.text}」@s${it.after_scene}後`).join(", ") || "(なし)"}`);
  for (const s of data.scenes) {
    const dlg = s.dialogue ? ` / セリフ「${s.dialogue}」(${s.speaker})` : "";
    const st = s.screen_text.length ? ` / 画面 ${s.screen_text.join(",")}` : "";
    console.log(`   s${s.index} ${s.scene_type} cut=${s.cut_count} telop=${s.telop_timing}${dlg}${st}`);
    console.log(`      camera: ${s.camera_beat} / motion: ${s.motion_beat} / amb: ${s.ambient}`);
    if (s.visual_metaphor) console.log(`      翻訳: ${s.visual_metaphor}`);
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
