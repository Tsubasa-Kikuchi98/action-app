# action-app — アクション映画予告生成アプリ

社内AIハッカソン（テーマ「アクション」、数人規模・社内発表のみ）の成果物。
エピソード文（＋任意で写真）を入力すると、AIが台本・シーン画像・ナレーション・BGMを生成し、ffmpeg で 30〜60 秒の映画予告風 mp4 を出力する。

**コンセプト（2026-08-30）: 仕事で起きた失敗を、アクション映画の予告編風にして面白おかしく消化する。** 事実の忠実な再現は不要。地味な現実をハリウッドの派手な視覚表現に「翻訳」する（システム障害 → サーバーが爆発）。変換辞書・文法・笑いのコツ・NG は [docs/trailer-tropes.md](docs/trailer-tropes.md)。

企画・調査資料: [docs/trailer-app-plan.md](docs/trailer-app-plan.md)（実現性・リスク・活用シーン）、[docs/AI_STACK_SETUP.md](docs/AI_STACK_SETUP.md)（環境構築）。

## 方針

- **法務面（商用ライセンス・帰属表記・肖像権）は考慮しない**（社内発表のみ）。ただしプラン制限・モデレーション等の技術的制約は考慮する。
- 「まず1本の予告編が最後まで出る」ことを最優先。品質・UI・並列化は後回し。
- 各工程は独立したスクリプトにし、中間生成物をファイルで残す（1工程だけ作り直せるように）。

## 技術スタック

| 工程 | 手段 | 備考 |
|---|---|---|
| 台本生成 | OpenAI `gpt-5.6-luna` + Structured Outputs（json_schema, strict） | 出力: `{ title, tagline, presents, review_line, stake, button_line, style, release_line, cast_lines, interstitials, scenes[]{ narration, telop, dialogue, visual_metaphor, image_prompt, video_prompt, scene_type, cut_count, telop_timing, ... } }`。パロディの原理・視覚の翻訳文法は `PARODY_PRINCIPLES`（enrich.mjs）に集約 |
| 画像生成 | OpenAI `gpt-image-2` / `1536x1024` / 開発中は `quality: "low"`、本番は `medium` | 写真ありは `images/edits` に参照画像を毎回添付。`Promise.all` で並列。Tier1 は 5枚/分。Phase 2 以降は動画の起点画像＋フォールバック |
| 動画生成（Phase 2） | Google Gemini API **Veo 3.1 Lite** `veo-3.1-lite-generate-preview` / 720p / image-to-video / 4・6・8 秒 | $0.05/秒、無料枠なし。音声は常に同梱（環境音として採用、`no dialogue, no speech` をプロンプトに固定）。生成 11秒〜最大6分・非同期ポーリング。生成物はサーバ保持2日 → 即DL。失敗時はそのシーンだけ静止画 Ken Burns にフォールバック。品質向上時は `veo-3.1-fast-generate-preview` にモデル名差し替え |
| ナレーション | OpenAI `gpt-4o-mini-tts` / voice `cedar` / `response_format: "wav"` / `speed` 1.0 | `instructions` は openai.fm 公式のラベル形式。共通ブロック ＋ scene_type 別ブロック。生成後に前後の無音を自動トリム |
| セリフ（Phase 3） | 同 TTS。ナレとは別 voice（`ash` / `onyx` / `nova` / `shimmer`）で `out/<job>/dlg/sN.wav` | 台本の `dialogue`（予告全体で 2〜3 本）。render で小部屋の残響を付けて「現場の声」にする |
| BGM | ElevenLabs Music API（`force_instrumental: true`）。未契約時はフリー素材を `assets/bgm/` に置いて使う | Music API は有料契約者限定 |
| 効果音 | Phase 2 では作らない（Veo 同梱音声で代替）。Phase 3 で ElevenLabs SFX（編集点の whoosh/impact/braam）を再検討 | — |
| 合成 | ffmpeg 9.0.1（winget 導入済み） | シーン別レンダ → 最終 xfade 合成。動画クリップは 1080p に拡大、Veo 音声は環境音レーンとしてダッキング |
| 実装言語 | Node 22（ESM, `.mjs`）。ffmpeg の filter_complex 生成も Node で行う | 追加パッケージは最小限（`openai` のみ想定） |

Anthropic API は使わない（Claude Code サブスクに API は含まれない）。

## ディレクトリ構成（予定）

```
scripts/           各工程のスクリプト（gen-image.mjs は既存）
  script.mjs       ① 台本生成 → out/<job>/script.json
  enrich.mjs       ①' 演出情報の付与（既存フィールドは変更しない）→ script.json
  images.mjs       ② 画像生成 → out/<job>/img/sN.png
  narration.mjs    ③ TTS      → out/<job>/nar/sN.wav・out/<job>/dlg/sN.wav（セリフ）
  video.mjs        ③' Veo     → out/<job>/vid/sN.mp4（Phase 2）
  bgm.mjs          ④ BGM      → out/<job>/bgm.mp3
  render.mjs       ⑤ ffmpeg   → out/<job>/cuts/cNNN.mp4 ＋ telop.ass → out/<job>/trailer.mp4
  run.mjs          ①〜⑤ を順に実行（--stills で動画生成をスキップ）
assets/bgm/        フォールバック用フリーBGM
out/               生成物（git 管理外）
docs/              企画・調査資料
```

## 環境変数（.env、git 管理外）

- `OPENAI_API_KEY`（必須）
- `GEMINI_API_KEY`（Phase 2 動画生成。Google AI Studio で発行＋課金有効化）
- `ELEVENLABS_API_KEY`（BGM を API で作る場合のみ）
- `TTS_SPEED`（既定 **1.0**）、`TTS_VOICE`（既定 cedar）、`TTS_TRIM`（既定 on）、`IMG_QUALITY`（既定 low）、`IMG_SIZE`（既定 1536x1024）
- Phase 3 の演出調整: `AMBIENT_VOL`（既定 **0.9**）、`AMBIENT_TARGET_DB`（既定 -20）、`DLG_VOL` / `BTN_VOL`、`BGM_VOL`、`XFADE_SEC`、`LETTERBOX`、`PRESENTS_SEC` / `REVIEW_SEC` / `INTER_SEC` / `STOPDOWN_SEC` / `TITLE_SEC` / `BUTTON_MIN` / `BUTTON_MAX` / `SILENT_TELOP_SEC`、`VEO_GEN_SEC`（既定 8）
- 台本の型: `TRAILER_STYLE`（`narration` 既定 / `dialogue`。`node scripts/script.mjs ... --style=dialogue` でも指定可）、`NAR_TOTAL_MAX`（既定 80）

## ffmpeg / Windows の注意（実機で確認済み・必ず守る）

- フォントは `fontfile='C\:/Windows/Fonts/YuGothB.ttc'`（スラッシュ区切り、コロンは `\:`）。**`font=` は使わない（セグフォルト）**。`.ttc` は face 0 しか読めない → 游ゴシック Bold を既定にする。
- テロップは `textfile='...txt':expansion=none` で渡す（`%` と半角 `:` の事故防止）。
- `-filter_complex_script` は ffmpeg 9 で削除済み → `-/filter_complex fc.txt`。ファイル内でもエスケープ規則は同じ。
- `zoompan` の前に `scale=iw*4:ih*4` を入れる（ジッター防止）。`fps=30` と `s=1920x1080` を必ず明示（既定は 25fps / 720p）。`d` はフレーム数（4秒なら `d=120`）。
- xfade の前に各入力へ `settb=AVTB,fps=30,format=yuv420p,setsar=1`。offset は Σクリップ長 − Σトランジション長 でプログラム計算する。
- `amix=...:normalize=0`、`loudnorm` の後に `aresample=48000`。ナレーションを sidechaincompress に使うときは `asplit` で分岐。
- MCP 登録は PowerShell から、`--scope user` か `--scope project` を明示（Git Bash は不可）。
- （Phase 3 実装で判明）`ass` フィルタに `fontsdir=C\:/Windows/Fonts` は渡せない（`No option name near '/Windows/Fonts'` = `\:` エスケープが効かない）→ 指定しなければ fontconfig が `Yu Gothic` を解決する。`xfade` の 2 入力は**両方に** `settb=AVTB,fps=30,format=yuv420p,setsar=1` を掛ける（片方が `concat`・片方が単一クリップだと timebase が 1/30 と 1/1000000 で食い違い失敗する）。ASS の drawing 座標は「文字ボックスの左端 + 座標」で描かれるので、罫線は `\an7` ＋ `\pos(左端,y)` ＋ 0 起点の座標で置く。
- （Phase 3 調査で判明）`blend` は `format=gbrp` で行い後で `yuv420p` に戻す（YUV のままだとマゼンタ化）。動画入力に `zoompan` を使うときは `fps=30` を**前**に置く（24fps 入力が縮む）。`crop` の w/h に `t` は使えない（x/y は可）。`asubboost` は約 10 LU 下がるので低域は `bass=` で。重い `curves` は AI 映像の暗部を潰す。`ass` フィルタ（libass）が使え、テロップは `ass=f=out/<job>/telop.ass` で字間・フェード・スケールを一括制御できる。`minterpolate` は使わない（遅く破綻しやすい）。

## Phase 1 — 最小プロトタイプ（**クローズ 2026-08-29**）

静止画（gpt-image-2）＋ Ken Burns ＋ TTS ＋ BGM を ffmpeg で合成し、1本の予告編を最後まで出す。
成果: `scripts/{lib,script,images,narration,bgm,render,run}.mjs`、`out/demo1`・`demo2`（約 47〜58 秒、1本 $0.1、実時間 90 秒）。
判明した注意点は「ffmpeg / Windows の注意」に集約済み。

## Phase 2 — 全シーン動画化（**クローズ 2026-08-29**）

全体を 20 秒前後に短縮し、全シーンを Veo 3.1 Lite（image-to-video、720p、4/6/8 秒）で動画化。音声は Veo 同梱を環境音として採用。
成果: `scripts/video.mjs` 追加、script/narration/render/run 拡張、`--stills` フラグ、`VEO_BUDGET_SEC` 予算ガード。`out/demo3`（24.6 秒、5 シーン全動画化、1本 $1.29、実時間 118 秒）。
判明した注意点: Lite は `negativePrompt` 非対応（否定語はプロンプト本文に付与）／起点画像は 16:9 にクロップしてから渡す（3:2 のままだと黒帯ごと動画化）／並列 3 で 429 なし。
ライブデモ運用方針は docs/trailer-app-plan.md に記録済み。

## Phase 3 — 面白さ・迫力の向上（**進行中 2026-08-29〜**）

### 目的とクローズ条件
- 解像度ではなく「面白さ・迫力・映画予告らしさ」を上げる。対象は **ナレーション品質** と **動画品質（台本・動き・編集・演出）**。
- **BGM と効果音はスコープ外**（触らない）。
- クローズ条件: 菊池が固定エピソード（demo3「深夜の障害対応」）で生成物を再生し、5 軸（テンポ／ナレの熱量／コピーの切れ／動きの迫力／映画らしさ）が全て 4/5 以上と判断した時点。採点は docs/trailer-app-plan.md に記録。

### 進め方の原則
- **無料レバーから作り込む**: A 編集・演出（ffmpeg 再レンダ、$0）→ B 台本・コピー（$0.01）→ C ナレーション（$0.001）→ D Veo プロンプト（$1.2/本）。A〜C は demo3 の既存クリップを再利用し Veo を再生成しない。
- Veo は **Lite でプロンプト改善 → 不足なら Fast** を 1 本試す。
- **累計課金が $10 を超えそうな場合は都度菊池に確認**してから実行する（A〜C は該当なし）。
- 比較は同じ入力（demo3 のエピソード文）で A/B。render のみの変更は `node scripts/render.mjs demo3 --force` で即比較できる。

### ToDo
#### 0. 調査
- [x] 包括調査 → docs/quality-research.md（打ち手トップ 10、適用案、検証済みフィルタ断片）。試作 out/demo3/trailer_v2_preview.mp4
#### A. 編集・演出（render.mjs、$0）— **イテレーション 1 完了**
- [x] カット割りの緩急: `cut_count` に従って各クリップを split/trim（前半優先）。1 カットの上限を scene_type 別に決めて必ずカットランプになるようにした。montage の 1 カットは `setpts`＋`atempo` でスロー、加速点に白 2 フレーム、タイトル直前に 0.5 秒の黒（**全レーン無音**）
- [x] トランジション設計: **ハードカット主体**。xfade は cold_open→setup の 1 箇所だけ（0.45s）
- [x] テロップ演出: drawtext → **ASS 1 枚**（`out/<job>/telop.ass`、全テキストを絶対時刻で持つ）。70px / Spacing 14 / `fad` / スケールイン。`telop_timing` で「カット頭に叩く」「ナレの決め言葉に合わせる」を切替。出しっぱなしにならないよう表示秒に上限
- [x] ルック: teal-orange グレード ＋ ビネット ＋ ブルーム ＋ グレイン ＋ レターボックス 2.39:1（138px）
- [x] 微細な手ブレ・ズーム: turn / montage に `crop` の x/y 式で手ブレ、全カットに疑似寄り（1.06〜1.8 倍）とドリフト
- [x] **音**（今回の最重要）: 環境音を主役級に（`AMBIENT_VOL` 0.25→0.9、クリップごとに mean −20dB へ正規化、ナレ中だけ sidechain で −6dB）／セリフレーン（`aecho` で小部屋の響き）／ナレの後処理チェーン（EQ→コンプ→短エコー→リミッタ）／最終段 `loudnorm` → `alimiter` → stopdown ゲート
- [x] 冒頭 PRESENTS カード・中間カード 2 枚・タグライン付きタイトルカード・`release_line`・キャスト行
#### B. 台本・コピー（script.mjs / enrich.mjs、$0.02）— **完了**
- [x] `scene_type`（cold_open / setup / turn / montage / resolve）と `cut_count` をスキーマで強制
- [x] ナレ＝語り、テロップ＝断言の役割分離。数字・期限・二択を必ず 1 つ。結末を示さない。三点リーダーで間を作る
- [x] `dialogue`（決め台詞 2〜3 本）／`screen_text`（画面内の小テロップ）／`tagline`／`interstitials`／`release_line`／`presents`／`cast_lines` をスキーマに追加
- [x] `scripts/enrich.mjs` で**既存フィールドを一切変えずに**旧 script.json を拡張できるようにした（Veo を再生成せず演出だけ載せられる）
- [x] 最終シーンは「無音＋テロップ」等の余韻パターンを選べるようにする → `telop_timing: "on_silence"`（声を言い切った直後に全レーンを 0.4 秒落として文字だけ残す）で実装
- [x] **コンセプトの実装**: docs/trailer-tropes.md（パロディの原理・視覚の翻訳文法 10・変換例 8・笑いのコツ・NG・禁句・テロップ型カタログ）を `PARODY_PRINCIPLES` として enrich.mjs に集約し、script.mjs / enrich.mjs の両プロンプトで共有
- [x] **反撃・復旧パートの翻訳**（docs/trailer-tropes.md §5「召集 → 出動・移動 → 突入 → 作戦会議 → 決着」）をプロンプトに追加。montage / resolve は必ずここから選ばせ、montage は 1〜1.5 秒カット用の移動・突入素材にする。Veo が弾く「割れる瞬間の破片・武器」も禁止に追加
- [x] スキーマ追加: `button_line`（タイトル後の落ち）／`review_line`（煽りテロップのパロディ）／`stake`（賭け金の数値表現）／`style`（narration | dialogue）／シーンの `visual_metaphor`（現実 → 演出の翻訳 1 行）／`telop_timing` に `on_silence`
- [x] `duration_sec` のランプを 6,4,4,6,4（montage 最長）に、`cut_count` 上限を montage だけ 6 に
- [x] `lintScript()`（$0）で禁句・ナレ合計字数（80 字）・stake の数字・中間カード位置・テロップ重複・セリフ本数を warn（**削除はしない**）
- [x] 案 B（`--style=dialogue` / env `TRAILER_STYLE`）: ナレ 2 本＋セリフ 4 本＋文字カード主導。narration が空のシーンは TTS を作らず nar_sec=0・尺は台本値
- [ ] 案 A / 案 B を**実映像**で比較する（`out/demo4`（案 A）・`out/demo5`（案 B）は台本と音声のみ。画像・動画は未生成）
- [ ] 台本 1 本の実コストが $0.045〜0.054（reasoning 2.3〜3.1k tok）。プロンプトが長いので圧縮するか、キャッシュ前提で運用する
#### C. ナレーション（narration.mjs、$0.01）— **完了**
- [x] `TTS_SPEED` を 1.0 に戻し、速度は `Pacing:` で制御
- [x] `instructions` を openai.fm 公式のラベル形式（空行区切り）に。共通ブロック ＋ scene_type 別ブロック（囁き→加速→張る）
- [x] TTS の前後の無音を自動トリム（文中の「……」の間は残す）。ナレ 0.2〜0.4s / セリフ 0.8〜0.9s 短縮できた
- [x] セリフをナレとは別 voice で生成（speaker → ash / onyx / nova / shimmer）
- [ ] 声の比較: cedar / onyx / ash / marin を同じ台本で試聴（実音の聴き比べは菊池の判断待ち）
- [ ] **ElevenLabs eleven_v3**（audio tags、Free 枠）と比較（`ELEVENLABS_API_KEY` が未設定のため未着手）
#### D. 動画の動き（video.mjs、$1.2〜2.0/本）— **準備のみ完了・実行は判断待ち 💰**
- [x] Veo プロンプトを **motion-first テンプレート**に更新（camera_beat / motion_beat / env_beat / `Ambient noise:` / セリフは引用符）。`--dry-run` で API を呼ばずに確認できる
- [x] 8 秒生成 → render 側で前半だけ使う設計に変更（`VEO_GEN_SEC` 既定 8、`VEO_BUDGET_SEC` 48）
- [ ] 実際に Veo を再生成する（5 シーン × 8 秒 = $2.00。`node scripts/video.mjs demo3 --force`）
- [x] 起点画像のプロンプト改善 → demo4 で実施（石板崩落／赤灯の保管庫／金庫室／夜の街の部隊／逆再生の破片）
- [ ] Lite で 1〜2 本比較 → 不足なら Fast を 1 本（要確認）
#### E. 評価
- [x] イテレーション 1 完了、菊池の採点待ち（`out/demo3/trailer.mp4` 35.7 秒 / 14 カット / セリフ 3 本 / −13.7 LUFS）
- [ ] 各イテレーションの 5 軸採点と変更点を docs/trailer-app-plan.md に記録
- [ ] 全軸 4 以上 → Phase 3 クローズ

## Phase 4 以降（候補）
- 効果音（ElevenLabs SFX で whoosh / impact / braam を `assets/sfx/` に常備）、BGM（フリー素材配置 or ElevenLabs Music）
- 写真入力による主役化（`images/edits` の Go/No-Go 検証）
- 進捗表示付き Web UI、トーン切替テンプレート、$50 チャージで OpenAI Tier 2、Veo 1080p
