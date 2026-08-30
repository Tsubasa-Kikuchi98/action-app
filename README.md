# action-app

アクションをテーマにしたアプリ（社内AIハッカソン）。

## ドキュメント

- [アプリ案ブレインストーミング（100案）](docs/ideas.md)
- [AI技術スタックとセットアップ手順](docs/AI_STACK_SETUP.md)
- [アプリ案の厳選結果](docs/shortlist.md)
- [予告生成アプリ 企画メモ（実現性・活用シーン）](docs/trailer-app-plan.md)
- [CLAUDE.md](CLAUDE.md) — 開発方針・ディレクトリ構成・ffmpeg の注意・Phase ごとの ToDo

## 技術スタック（AI）

| 役割 | ツール |
|---|---|
| コーディング | Claude Code |
| イラスト生成 | OpenAI 画像生成 API（gpt-image-2）— `scripts/gen-image.mjs` |
| 動画生成 | Google Gemini API — Veo 3.1 Lite（image-to-video、720p）— `scripts/video.mjs` |
| BGM | ElevenLabs Music API（`POST /v1/music`）— `scripts/bgm.mjs` |
| 効果音 | ElevenLabs Sound Generation（`POST /v1/sound-generation`）— `scripts/sfx.mjs` |
| ナレーション・セリフ | OpenAI TTS（gpt-4o-mini-tts）— `scripts/narration.mjs` |

## 使い方

配布形態は 2 つあります。**他の PC で使うだけなら A**（Node も ffmpeg も要りません）。

### A. exe で使う（推奨・配布用）

1. `dist/action-app-<version>-portable.exe` を USB や共有フォルダで配り、**書き込めるフォルダ**
   （デスクトップや `C:\work\action-app\` など。Program Files は避ける）にコピーする。
2. ダブルクリックで起動する。初回だけ Windows SmartScreen が出るので「詳細情報 → 実行」。
   （コード署名をしていないため。社内配布なので署名は取っていません）
3. ヘッダの **「設定」** から API キーを入れて保存する。
   - `OPENAI_API_KEY`（必須）… 台本・画像・ナレーション
   - `GEMINI_API_KEY`（必須）… 動画生成（Veo）。「動画をスキップ」で生成するなら無くてもよい
   - `ELEVENLABS_API_KEY`（任意）… BGM・効果音。未設定なら ffmpeg の合成音
4. エピソード文を入れて「動画生成」。完成した mp4 は **exe と同じフォルダの `out/<ジョブ名>/trailer.mp4`**。

exe には ffmpeg / ffprobe・基準画像（`assets/refs/`）・効果音（`assets/sfx/`）を同梱しており、
初回起動時に `assets/` を exe の隣にコピーします。以後はそのフォルダのものを使うので、
差し替えたいときは `assets/` の中身を置き換えてください。

- 生成物と素材の置き場（ROOT）は **exe と同じフォルダ**。書き込めない場所に置いた場合だけ
  `%APPDATA%\action-app\` にフォールバックします（ヘッダ右側に実際の ROOT が出ます）。
- API キーは `%APPDATA%\action-app\config.json` に平文で保存します（社内利用のため）。
  exe の隣に `.env` を置いた場合は **`.env` が優先**されます。
- ffmpeg は「同梱 → 環境変数 `FFMPEG_DIR` / `FFMPEG_PATH` → PATH → winget」の順に探します。

### B. ソースから使う（開発）

```powershell
.\scripts\setup.ps1     # Node/ffmpeg の確認 → winget で ffmpeg 導入 → npm i → .env 作成
```

手でやる場合:

1. `.env.example` を `.env` にコピーし、`OPENAI_API_KEY` を設定（BGM・効果音を API 生成する場合は `ELEVENLABS_API_KEY` も。未設定でも ffmpeg の合成音にフォールバックして最後まで通ります）。
   全シーンを動画化する Phase 2 を使う場合は `GEMINI_API_KEY`（Google AI Studio で発行し、**課金を有効化**。Veo に無料枠はありません）も設定します。
2. `npm install`。ffmpeg 9 は winget 等で導入（PATH になければ winget の既定パスを自動探索します）。
3. **基準画像**（人物・ロケの一貫性用）はリポジトリに入っていないので、この PC で 1 度だけ作ります（約 $0.25）:
   ```bash
   node scripts/refs.mjs --chars --locs office,meeting,corridor
   ```
   → `assets/refs/char_*.png` と `assets/refs/loc_*.png`。**exe を配る場合はこれが同梱される**ので、
   配布先の PC で作り直す必要はありません。
4. 任意で `assets/bgm/` にフリー BGM を1曲置く（無ければ ffmpeg の合成音でプレースホルダを作ります）。
5. 予告編を生成: `npm run trailer -- "締切前夜に全員で徹夜してリリースを間に合わせた話" demo1`
6. 結果は `out/demo1/trailer.mp4`（1920x1080 / 30fps）。中間生成物は `out/demo1/` に残るので工程単位でやり直せます（`node scripts/images.mjs demo1 --force` 等）。

### 配布用 exe を作る

```bash
npm run prepare:ffmpeg   # この PC の ffmpeg/ffprobe を build/ffmpeg/ にコピー（約 420MB・git 管理外）
npm run dist             # → dist/action-app-1.0.0-portable.exe（約 227MB）
```

`electron-builder` の `portable` ターゲット（インストーラなしの単一 exe）です。
同梱物は `build/ffmpeg/`・`assets/refs/`・`assets/sfx/`・`assets/bgm/`。
`.env` と `out/` は **exe に含めません**（API キーが配布物に混ざらないようにするため）。

### 予告の型（style）

`--style=<型>`（または `TRAILER_STYLE`）で構成を切り替えます。

| style | 尺 | 声 | 文字 |
|---|---|---|---|
| `narration`（既定） | 約 29 秒 / 5 シーン | ナレ ＋ セリフ（TTS） | テロップ ＋ カード |
| `dialogue` | 約 30 秒 / 5 シーン | セリフ主導（TTS） | 文字カード主導 |
| `nolan` | **20 秒 / 3 カット** | **ナレなし。セリフは Veo が口パクで喋る** | **カードだけ**（カット内は文字ゼロ） |

```bash
node scripts/script.mjs "<エピソード文>" myjob --style=nolan
node scripts/images.mjs myjob && node scripts/video.mjs myjob
node scripts/sfx.mjs && node scripts/bgm.mjs myjob && node scripts/render.mjs myjob --force
```

## デスクトップアプリ（Phase 4）

エピソード文をテキストボックスに入れて「動画生成」を押すだけで `out/<job>/trailer.mp4` まで作る
Electron アプリ。開発時は `npm run app`、配布時は portable exe（上の「A. exe で使う」）。

```bash
npm install                 # electron は devDependency
cp .env.example .env        # OPENAI_API_KEY / GEMINI_API_KEY を設定
npm run app                 # 実 API で生成する

TRAILER_MOCK=1 npm run app  # API を呼ばずに UI を確認する（合成だけ本物の ffmpeg）
```

画面は 1 枚。エピソード入力・構成（`nolan` 既定 / `narration`）・ジョブ名（既定 `job-YYYYMMDD-HHmm`）を
指定して「動画生成」を押すと、工程行（① 台本 → ⓪ 基準画像 → ② シーン画像 → ③' 音声/BGM/効果音 →
③ 動画（Veo）→ ⑤ 合成）に状態・経過秒・概算費用が出ます。Veo は「n/3 本完了」。完成すると
その場で mp4 を再生でき、「フォルダを開く」「台本を見る」と過去ジョブ一覧（クリックで再生）が使えます。
「中止」は以後の工程を止めます（実行中の工程は最後まで走ります）。途中で失敗しても、
その工程の行が赤くなるだけで中間生成物は `out/<job>/` に残ります。

- `TRAILER_MOCK=1` は台本・画像・動画・TTS・BGM・効果音をダミー（ffmpeg で作った単色 PNG /
  トーン wav / 静止 mp4）に差し替えます。**合成は本物の ffmpeg** を通るので、UI と
  タイムライン設計の両方を $0 で確認できます。表示される費用は「実 API なら幾らか」の想定額です。
- 起動しないときは `ELECTRON_RUN_AS_NODE` が設定されていないか確認してください
  （設定されていると electron が素の Node として起動し `electron` モジュールを解決できません）。

## コード構成（クリーンアーキテクチャ）

依存は**内向きのみ**（`domain ← usecases ← adapters ← cli`）。
`scripts/*.mjs` は `src/cli/*.mjs` を呼ぶだけの**互換エントリ**なので、コマンドの使い方は従来どおりです。

```
src/
  domain/     外部依存ゼロ。台本の型・正規化・lint、固定キャスト、各種プロンプト（文字列）、
              タイムライン設計（カット割り・xfade オフセット・ASS・filter_complex の生成）、単価表
  usecases/   工程のオーケストレーション（台本 / 演出 / 基準画像 / 画像 / ナレ / 動画 / BGM / 効果音 / 合成 / 一気通貫）。
              ポート（引数で渡す依存）にだけ依存する
  adapters/   ポートの実装。openai（text / image / tts）、gemini（veo）、
              ffmpeg（exec / filters / ass）、elevenlabs（sfx / music）、
              storage（jobStore / files / refsStore / env）
  cli/        引数解析（args.mjs）と依存の組み立て（deps.mjs の createDeps()）だけ
scripts/      互換エントリ（各 2 行）。gen-image.mjs だけはパイプライン外の単発ツール
test/         domain の純関数のユニットテスト
```

各層の詳しいファイル一覧とルールは [CLAUDE.md](CLAUDE.md#ディレクトリ構成クリーンアーキテクチャ) を参照。

## テスト

```bash
npm test    # node --test "test/**/*.test.mjs" — API を呼ばないので $0
```

domain の純関数（normalize の排他ルール、シーン尺の 4/6/8 丸め、カット割り、
xfade オフセット = Σクリップ − Σトランジション、lint の禁句検出、Veo プロンプトの組み立て）と、
層の依存の向きを検査します。

## パイプライン

```
① 台本(script.mjs) → ①' 演出(enrich.mjs, 不足時のみ)
   → ｛② 画像(images.mjs) ‖ ③' ナレ+セリフ(narration.mjs) ‖ ④ BGM(bgm.mjs)｝
   → ③ 動画(video.mjs, Veo) → ⑤ 合成(render.mjs)
```

`③ 動画` は起点画像（②）と 4/6/8 秒に丸めたシーン尺（③'）の両方に依存するため、並列グループの後に走ります。

`①' 演出`（`node scripts/enrich.mjs <job>`）は既存の台本を**壊さずに**演出情報だけ足す工程です
（シーンタイプ / カット数 / 決め台詞 / 中間カード / タグライン / エンドカード）。
Phase 1・2 で作った古い `script.json` を作り直さずに Phase 3 の演出を載せるために使います
（`script.mjs` は最初から同じフィールドを出すので、新規生成では走りません）。
`③' ナレ` はナレーションに加えて `dialogue` のある**シーンの決め台詞をナレとは別の声**で生成し、`out/<job>/dlg/sN.wav` に置きます。
`⑤ 合成`では Veo 同梱の環境音が主役級の音量で鳴ります（`AMBIENT_VOL` 既定 0.9・ナレ中だけダッキング。`AMBIENT_TARGET_DB` でクリップ間の音量を揃える）。

## Phase 2（全シーン動画化）

`GEMINI_API_KEY` があると、各シーンの静止画を起点に **Veo 3.1 Lite** で image-to-video を行い、
動きのある 20 秒前後の予告編になります。Veo 同梱の音声は環境音レーンとして採用し、ナレーションでダッキングします。

```bash
# 全シーン動画化（既定）
npm run trailer -- "深夜の障害対応で全員が集結して復旧させた話" demo3

# Phase 1 相当（静止画 Ken Burns のみ・Veo を使わない＝追加費用なし）
npm run trailer -- "..." demo3 -- --stills
node scripts/run.mjs "..." demo3 --stills

# 動画だけ作り直す（既存クリップはスキップ。--force で再生成）
node scripts/video.mjs demo3
```

動画生成に失敗・タイムアウト・安全フィルタ拒否となったシーンは、**そのシーンだけ静止画 Ken Burns にフォールバック**します
（理由は `out/<job>/script.json` の `motion_reason` と `out/<job>/log.jsonl` に残ります）。

### 費用の目安（1本 = 5シーン）

| 工程 | 単価 | 1本あたり |
|---|---|---|
| 台本（gpt-5.6-luna） | — | 約 $0.02 |
| 画像（gpt-image-2 / low） | $0.016/枚 | 約 $0.08 |
| ナレーション（gpt-4o-mini-tts） | — | 約 $0.01 |
| **動画（Veo 3.1 Lite 720p）** | **$0.05/秒** | **$1.00〜1.50**（4秒×5〜6秒×5） |
| 合計 | | **約 $1.1〜1.6** |

Veo には無料枠がありません。事故防止のため 1 ジョブの生成秒数に上限があり（`VEO_BUDGET_SEC`、既定 48 秒）、
超える見込みのときは API を呼ぶ前に停止します。`--stills` を付ければ Veo は一切呼ばれません。

主な環境変数は `.env.example` を参照（`VEO_MODEL` / `VEO_CONCURRENCY` / `VEO_TIMEOUT_SEC` / `VEO_BUDGET_SEC` / `SCENE_ROUND` / `VEO_GEN_SEC`）。
`node scripts/video.mjs <job> --dry-run` で **API を呼ばずに** Veo へ送るプロンプトと想定費用だけ確認できます。

## Phase 3（編集・演出の作り込み）

既存クリップを再利用したまま、カットランプ（終盤ほど短いカット）・疑似寄り・手ブレ・スロー・白フラッシュ・
中間カード・stopdown（タイトル直前の無音の黒）・ASS テロップ・2.39:1 レターボックスを `render.mjs` が組み立てます。

```bash
# 既存の台本に演出情報だけ足す（$0.02 / 既存フィールドは変更しない）
node scripts/enrich.mjs demo3

# ナレ + セリフを作り直す（$0.01 弱）
node scripts/narration.mjs demo3 --force

# 編集だけ作り直す（$0・Veo も画像も呼ばない）
node scripts/render.mjs demo3 --force
```

演出の調整は `.env` の `AMBIENT_VOL` / `DLG_VOL` / `BGM_VOL` / `XFADE_SEC` / `LETTERBOX` / 各カードの尺で行えます。

詳細は [docs/AI_STACK_SETUP.md](docs/AI_STACK_SETUP.md) と [CLAUDE.md](CLAUDE.md) を参照。
