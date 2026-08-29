# action-app

アクションをテーマにしたアプリ（社内AIハッカソン）。

## ドキュメント

- [アプリ案ブレインストーミング（100案）](docs/ideas.md)
- [AI技術スタックとセットアップ手順](docs/AI_STACK_SETUP.md)
- [アプリ案の厳選結果](docs/shortlist.md)
- [予告生成アプリ 企画メモ（実現性・活用シーン）](docs/trailer-app-plan.md)
- [CLAUDE.md](CLAUDE.md) — 開発方針と Phase 1 ToDo

## 技術スタック（AI）

| 役割 | ツール |
|---|---|
| コーディング | Claude Code |
| イラスト生成 | OpenAI 画像生成 API（gpt-image-2）— `scripts/gen-image.mjs` |
| 動画生成 | Google Gemini API — Veo 3.1 Lite（image-to-video、720p）— `scripts/video.mjs` |
| BGM・効果音 | ElevenLabs（公式 MCP） |

## セットアップ

1. `.env.example` を `.env` にコピーし、`OPENAI_API_KEY` を設定（BGM を API 生成する場合は `ELEVENLABS_API_KEY` も）。
   全シーンを動画化する Phase 2 を使う場合は `GEMINI_API_KEY`（Google AI Studio で発行し、**課金を有効化**。Veo に無料枠はありません）も設定します。
2. `npm install`。ffmpeg 9 は winget 等で導入（PATH になければ winget の既定パスを自動探索します）。
3. 任意で `assets/bgm/` にフリー BGM を1曲置く（無ければ ffmpeg の合成音でプレースホルダを作ります）。
4. 予告編を生成: `npm run trailer -- "締切前夜に全員で徹夜してリリースを間に合わせた話" demo1`
5. 結果は `out/demo1/trailer.mp4`（1920x1080 / 30fps）。中間生成物は `out/demo1/` に残るので工程単位でやり直せます（`node scripts/images.mjs demo1 --force` 等）。

## パイプライン

```
① 台本(script.mjs) → ｛② 画像(images.mjs) ‖ ③' ナレ(narration.mjs) ‖ ④ BGM(bgm.mjs)｝
                   → ③ 動画(video.mjs, Veo) → ⑤ 合成(render.mjs)
```

`③ 動画` は起点画像（②）と 4/6/8 秒に丸めたシーン尺（③'）の両方に依存するため、並列グループの後に走ります。

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

主な環境変数は `.env.example` を参照（`VEO_MODEL` / `VEO_CONCURRENCY` / `VEO_TIMEOUT_SEC` / `VEO_BUDGET_SEC` / `SCENE_ROUND`）。

詳細は [docs/AI_STACK_SETUP.md](docs/AI_STACK_SETUP.md) と [CLAUDE.md](CLAUDE.md) を参照。
