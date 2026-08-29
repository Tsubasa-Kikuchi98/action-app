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

## Phase 1 — 最小プロトタイプ（**2026-08-29 完了**。`npm run trailer -- "エピソード" <job>` で out/<job>/trailer.mp4 が出る）
OpenAIのAPIキーの保存は完了しました。
### 0. 準備
- [x] OpenAI Platform で $5 チャージし API キーを `.env` に保存（`OPENAI_API_KEY`）
- [x] ffmpeg はユーザー PATH に登録済み（スクリプトは winget の実体パスにもフォールバック）
- [x] `npm init -y` → `npm i openai dotenv`、`package.json` に `"type": "module"`
- [ ] `assets/bgm/` にフリーBGM を1曲置く（DOVA-SYNDROME 等。ElevenLabs 契約前の代替）
- [x] `.gitignore` に `out/` と `assets/bgm/*.mp3` を追加

### 1. 台本生成（scripts/script.mjs）
- [x] JSON スキーマ確定（title / scenes[6] { narration, telop, image_prompt, duration_sec }）
- [x] システムプロンプト作成（映画予告の文法: 「その日…」「しかし…」「この夏」「COMING SOON」、6シーン・合計 30〜40 秒、telop は 15 字以内、image_prompt は英語で映画的に）
- [x] `node scripts/script.mjs "エピソード文" <job>` → `out/<job>/script.json` が出る

### 2. 画像生成（scripts/images.mjs）
- [x] script.json の image_prompt から `gpt-image-2` で 1536x1024 / low を6枚並列生成 → `out/<job>/img/s1..6.png`
- [x] 共通スタイル接尾辞（cinematic, anamorphic, teal-orange, film grain）をプロンプトに付与
- [ ] **Go/No-Go 検証**: 顔写真1枚を `images/edits` に渡して通るか確認し、結果を docs/trailer-app-plan.md に記録（Phase 1 では写真なしが既定）

### 3. ナレーション（scripts/narration.mjs）
- [x] シーンごとに `gpt-4o-mini-tts`（cedar, wav）で生成 → `out/<job>/nar/s1..6.wav`
- [x] `instructions` を実音で確認 → 「やや速め・力強く」+ `speed: 1.15`（`TTS_SPEED` で調整可）に決定
- [x] 各 wav の実尺を取得（ffprobe）し、シーン尺 = max(duration_sec, ナレ尺 + 0.5s) に補正して script.json に書き戻す

### 4. BGM（scripts/bgm.mjs）
- [x] `assets/bgm/` のファイルをコピーするだけの実装で先に通す
- [x] （任意）ElevenLabs Starter 契約後、Music API で 45 秒インストを生成する分岐を追加

### 5. 合成（scripts/render.mjs）
- [x] シーン別レンダ: 画像 + zoompan(Ken Burns) + drawtext(テロップ, フェードイン) + ナレーション wav → `scenes/sN.mp4`（-crf 18）
- [x] タイトルカード（黒背景 + 白文字 + 「COMING SOON」）を末尾に追加
- [x] 最終合成: xfade（fade / fadewhite 0.16s）チェーン + BGM ダッキング + loudnorm → `trailer.mp4`（1920x1080 / 30fps / +faststart）
- [x] filter_complex は Node で文字列生成し `out/<job>/fc.txt` に書いてから `-/filter_complex` で渡す

### 6. 一気通貫（scripts/run.mjs）
- [x] `node scripts/run.mjs "エピソード文" demo1` で ①〜⑤ が順に走り `out/demo1/trailer.mp4` が出る
- [x] 各工程の所要時間と API `usage` をログに出す（コスト実測）
- [x] 社内ネタで1本生成して再生確認 → Phase 1 完了

## Phase 2 ToDo — 全シーン動画化（Veo 3.1 Lite、20 秒前後の予告編）

決定事項（2026-08-29）: 全体を 20 秒程度に短縮する代わりに全シーンを Veo で動画化。最安の Lite 720p から始める。音声は Veo 同梱のものを採用し、効果音の追加は Phase 3 で再検討。1本あたり動画 約$1.0〜1.2（＋既存工程 $0.1）。

### 0. 準備
- [x] Google AI Studio で API キー発行・課金有効化 → `.env` に `GEMINI_API_KEY`
- [x] `npm i @google/genai`（v2.19.0）
- [x] **仕様の実機確認**（2026-08-29）: `durationSeconds: 4` は**通る**（4/6/8 が有効）。8秒固定への切り替えは不要。1本 4秒の生成に約 35 秒（投入3秒＋ポーリング3回）。出力は **1280x720 / 24fps / h264 + aac 48kHz stereo**、尺はちょうど 4.000s
- [x] Veo のレート制限: 並列3で同時投入しても 429 は発生せず（5本を並列3で 70 秒）。`VEO_CONCURRENCY` で調整可
- [x] **`negativePrompt` は Lite では使えない**（400 INVALID_ARGUMENT: "`negativePrompt` isn't supported by this model"）→ 否定語はプロンプト本文の末尾に固定付与する（`VEO_NEGATIVE_PROMPT=on` で config 送信も試せる）
- [x] **起点画像は 16:9 にクロップしてから渡す**。gpt-image-2 の 1536x1024（3:2）をそのまま渡すと Veo が黒帯ごと動画化してしまう → video.mjs が 1280x720 にクロップして `vid/_src_sN.png` に保存

### 1. 台本の作り直し（scripts/script.mjs）
- [x] 5シーン構成（`SCENE_COUNT`、env で上書き可）、ナレーションは**各 15 字前後を目安**（厳密な上限にはしない）、合計 20 秒前後
- [x] 各シーンに `video_prompt`（英語・カメラの動きと被写体の動作）を追加。"no dialogue, no speech, no on-screen text" は video.mjs 側で固定付与
- [x] `duration_sec` はナレ実尺 + 0.6s から **4 / 6 / 8 のいずれかに丸め上げ**（narration.mjs の `roundSceneSec`）。既定 4 秒。`SCENE_ROUND=off` で Phase 1 相当の連続値に戻る
- [x] `video_prompt` / `motion` が無い旧 script.json（Phase 1）でも render が動くこと

### 2. 動画生成（scripts/video.mjs）
- [x] `out/<job>/img/sN.png` を起点に `veo-3.1-lite-generate-preview` / 720p / 16:9 / `personGeneration: "allow_adult"` で image-to-video
- [x] 全シーンを並列投入（`VEO_CONCURRENCY` 既定 3、429 は指数バックオフ）→ 10 秒間隔でポーリング → 完了次第 `out/<job>/vid/sN.mp4` に即ダウンロード（サーバ保持は 2 日）
- [x] タイムアウト（`VEO_TIMEOUT_SEC` 既定 480 秒）・失敗・モデレーション拒否は **そのシーンだけ静止画にフォールバック**し、script.json に `motion: "video" | "still"` と `motion_reason` / `clip_sec` を記録
- [x] usage/コストを log.jsonl に記録（`usage.video_sec` × $0.05）
- [x] 既存クリップはスキップ、`--force` で再生成。`--stills` で全シーン静止画扱い
- [x] 事故防止: 1 ジョブの生成予定秒数が `VEO_BUDGET_SEC`（既定 48 秒）を超えると API を呼ぶ前に停止する

### 3. 合成の拡張（scripts/render.mjs）
- [x] シーン入力が動画なら: 720p → 1080p に拡大（lanczos）、`trim` で `duration_sec` に合わせ、クリップが短ければ `tpad=stop_mode=clone` で最終フレームを伸ばす。テロップ drawtext は現状どおり
- [x] Veo 同梱音声を「環境音レーン」として追加: `volume=0.25`（≒ −12dB、`AMBIENT_VOL` で調整）＋ ナレーションで `sidechaincompress` ダッキング → amix
- [x] 静止画フォールバックシーンとの混在でも xfade チェーンが崩れないこと（両経路とも `settb=AVTB` / 30fps / yuv420p / setsar=1 / aac 48kHz 2ch に統一）
- [x] タイトルカードは 2.5 秒に短縮

### 4. 一気通貫と運用
- [x] run.mjs に動画生成を組み込み。`--stills` で Phase 1 相当の静止画のみ生成
      構成は ① 台本 → ｛② 画像 ‖ ③' ナレ ‖ ④ BGM｝並列 → ③ 動画 → ⑤ 合成。
      ③ を並列グループに入れないのは、起点画像（②）と 4/6/8 に丸めた尺（③'）の両方に依存するため
- [x] 1本生成して確認（demo3 / 2026-08-29）: 5シーンすべて動画化に成功、静止画フォールバック 0。
      1920x1080 / 30fps / h264+aac 48kHz 2ch / 24.58秒 / 16.7MB。ナレ前の区間に Veo 環境音が乗っている（mean −22.7dB）
- [x] 所要時間を実測し、ライブデモの運用方針を docs/trailer-app-plan.md に記録（実時間 118 秒、事前生成 2〜3 本＋ライブ 1 本）
- [x] コスト実測（demo3）: **合計 $1.29**（目標 $1.3 以下を達成）。内訳 Veo 24秒 $1.20 / 画像5枚 $0.08 / 台本 $0.013 / TTS ≒$0。
      実時間 117.6 秒（台本 12.7 / 並列 21.9 / 動画 70.0 / 合成 13.0）

### Phase 3 以降（候補）
- 効果音の再検討（ElevenLabs SFX で編集点の whoosh / impact / braam を数個作って `assets/sfx/` に常備）
- 画質向上（Veo Fast / 1080p、gpt-image-2 medium）、写真入力による主役化（Go/No-Go 結果次第）
- 進捗表示付き Web UI、トーン切替テンプレート、$50 チャージで Tier 2
