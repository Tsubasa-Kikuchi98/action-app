# action-app — アクション映画予告生成アプリ

社内AIハッカソン（テーマ「アクション」、数人規模・社内発表のみ）の成果物。
エピソード文（＋任意で写真）を入力すると、AIが台本・シーン画像・ナレーション・BGMを生成し、ffmpeg で 30〜60 秒の映画予告風 mp4 を出力する。

企画・調査資料: [docs/trailer-app-plan.md](docs/trailer-app-plan.md)（実現性・リスク・活用シーン）、[docs/AI_STACK_SETUP.md](docs/AI_STACK_SETUP.md)（環境構築）。

## 方針

- **法務面（商用ライセンス・帰属表記・肖像権）は考慮しない**（社内発表のみ）。ただしプラン制限・モデレーション等の技術的制約は考慮する。
- 「まず1本の予告編が最後まで出る」ことを最優先。品質・UI・並列化は後回し。
- 各工程は独立したスクリプトにし、中間生成物をファイルで残す（1工程だけ作り直せるように）。

## 技術スタック

| 工程 | 手段 | 備考 |
|---|---|---|
| 台本生成 | OpenAI `gpt-5.6-luna` + Structured Outputs（json_schema, strict） | 出力: `{ title, scenes[]{ narration, telop, image_prompt, duration_sec } }` |
| 画像生成 | OpenAI `gpt-image-2` / `1536x1024` / 開発中は `quality: "low"`、本番は `medium` | 写真ありは `images/edits` に参照画像を毎回添付。`Promise.all` で並列。Tier1 は 5枚/分。Phase 2 以降は動画の起点画像＋フォールバック |
| 動画生成（Phase 2） | Google Gemini API **Veo 3.1 Lite** `veo-3.1-lite-generate-preview` / 720p / image-to-video / 4・6・8 秒 | $0.05/秒、無料枠なし。音声は常に同梱（環境音として採用、`no dialogue, no speech` をプロンプトに固定）。生成 11秒〜最大6分・非同期ポーリング。生成物はサーバ保持2日 → 即DL。失敗時はそのシーンだけ静止画 Ken Burns にフォールバック。品質向上時は `veo-3.1-fast-generate-preview` にモデル名差し替え |
| ナレーション | OpenAI `gpt-4o-mini-tts` / voice `cedar` / `response_format: "wav"` | `instructions` で映画予告風の演技を指示 |
| BGM | ElevenLabs Music API（`force_instrumental: true`）。未契約時はフリー素材を `assets/bgm/` に置いて使う | Music API は有料契約者限定 |
| 効果音 | Phase 2 では作らない（Veo 同梱音声で代替）。Phase 3 で ElevenLabs SFX（編集点の whoosh/impact/braam）を再検討 | — |
| 合成 | ffmpeg 9.0.1（winget 導入済み） | シーン別レンダ → 最終 xfade 合成。動画クリップは 1080p に拡大、Veo 音声は環境音レーンとしてダッキング |
| 実装言語 | Node 22（ESM, `.mjs`）。ffmpeg の filter_complex 生成も Node で行う | 追加パッケージは最小限（`openai` のみ想定） |

Anthropic API は使わない（Claude Code サブスクに API は含まれない）。

## ディレクトリ構成（予定）

```
scripts/           各工程のスクリプト（gen-image.mjs は既存）
  script.mjs       ① 台本生成 → out/<job>/script.json
  images.mjs       ② 画像生成 → out/<job>/img/sN.png
  narration.mjs    ③ TTS      → out/<job>/nar/sN.wav
  video.mjs        ③' Veo     → out/<job>/vid/sN.mp4（Phase 2）
  bgm.mjs          ④ BGM      → out/<job>/bgm.mp3
  render.mjs       ⑤ ffmpeg   → out/<job>/scenes/sN.mp4 → out/<job>/trailer.mp4
  run.mjs          ①〜⑤ を順に実行（--stills で動画生成をスキップ）
assets/bgm/        フォールバック用フリーBGM
out/               生成物（git 管理外）
docs/              企画・調査資料
```

## 環境変数（.env、git 管理外）

- `OPENAI_API_KEY`（必須）
- `GEMINI_API_KEY`（Phase 2 動画生成。Google AI Studio で発行＋課金有効化）
- `ELEVENLABS_API_KEY`（BGM を API で作る場合のみ）
- `TTS_SPEED`（既定 1.15）、`IMG_QUALITY`（既定 low）、`IMG_SIZE`（既定 1536x1024）

## ffmpeg / Windows の注意（実機で確認済み・必ず守る）

- フォントは `fontfile='C\:/Windows/Fonts/YuGothB.ttc'`（スラッシュ区切り、コロンは `\:`）。**`font=` は使わない（セグフォルト）**。`.ttc` は face 0 しか読めない → 游ゴシック Bold を既定にする。
- テロップは `textfile='...txt':expansion=none` で渡す（`%` と半角 `:` の事故防止）。
- `-filter_complex_script` は ffmpeg 9 で削除済み → `-/filter_complex fc.txt`。ファイル内でもエスケープ規則は同じ。
- `zoompan` の前に `scale=iw*4:ih*4` を入れる（ジッター防止）。`fps=30` と `s=1920x1080` を必ず明示（既定は 25fps / 720p）。`d` はフレーム数（4秒なら `d=120`）。
- xfade の前に各入力へ `settb=AVTB,fps=30,format=yuv420p,setsar=1`。offset は Σクリップ長 − Σトランジション長 でプログラム計算する。
- `amix=...:normalize=0`、`loudnorm` の後に `aresample=48000`。ナレーションを sidechaincompress に使うときは `asplit` で分岐。
- MCP 登録は PowerShell から、`--scope user` か `--scope project` を明示（Git Bash は不可）。
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
#### A. 編集・演出（render.mjs、$0）
- [ ] カット割りの緩急: クライマックスは 4 秒クリップを 2 秒×2 に割る／スローモーション、タイトル直前に 0.8 秒の黒（無音）
- [ ] トランジション設計: fadewhite の使い所を絞り、スマッシュカット（カット直結）を混ぜる
- [ ] テロップ演出: 大型化・字間・グロー（複数レイヤー）・スケールイン、タイトルカードのタイポグラフィ
- [ ] ルック: teal-orange グレード、ビネット、フィルムグレイン、レターボックス 2.39:1（採否を比較して決める）
- [ ] 微細な手ブレ・ズーム（zoompan / crop の式）
#### B. 台本・コピー（script.mjs、$0.01）
- [ ] シーンタイプ（setup / turn / montage / title）をスキーマで強制し、3 幕の緩急を作る
- [ ] ナレ＝物語、テロップ＝キャッチの役割分離。体言止め・対比・数字。予告編コピーの見本を few-shot で与える
- [ ] 最終シーンは「無音＋テロップ」等の余韻パターンを選べるようにする
#### C. ナレーション（narration.mjs、$0.001）
- [ ] シーンタイプ別に `instructions` を切り替え（囁き→加速→張る）
- [ ] 声の比較: cedar / onyx / ash / marin を同じ台本で試聴
- [ ] **ElevenLabs eleven_v3**（audio tags、Free 枠）を同じ台本で生成し OpenAI と比較 → 採用を決める（`ELEVENLABS_API_KEY` が必要）
#### D. 動画の動き（video.mjs、$1.2/本）
- [ ] Veo プロンプトテンプレート: カメラワーク語彙（dolly-in / whip pan / handheld / slow-motion / rack focus）と被写体の明確な動作を強制、ショットサイズをシーンごとに変える
- [ ] 起点画像のプロンプト改善（動きの余白、被写体の向き、被写界深度）
- [ ] Lite で 1〜2 本比較 → 不足なら Fast を 1 本（要確認）
#### E. 評価
- [ ] 各イテレーションの 5 軸採点と変更点を docs/trailer-app-plan.md に記録
- [ ] 全軸 4 以上 → Phase 3 クローズ

## Phase 4 以降（候補）
- 効果音（ElevenLabs SFX で whoosh / impact / braam を `assets/sfx/` に常備）、BGM（フリー素材配置 or ElevenLabs Music）
- 写真入力による主役化（`images/edits` の Go/No-Go 検証）
- 進捗表示付き Web UI、トーン切替テンプレート、$50 チャージで OpenAI Tier 2、Veo 1080p
