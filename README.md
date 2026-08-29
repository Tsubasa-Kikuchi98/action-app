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
| BGM・効果音 | ElevenLabs（公式 MCP） |

## セットアップ

1. `.env.example` を `.env` にコピーし、`OPENAI_API_KEY` を設定（BGM を API 生成する場合は `ELEVENLABS_API_KEY` も）。
2. `npm install`。ffmpeg 9 は winget 等で導入（PATH になければ winget の既定パスを自動探索します）。
3. 任意で `assets/bgm/` にフリー BGM を1曲置く（無ければ ffmpeg の合成音でプレースホルダを作ります）。
4. 予告編を生成: `npm run trailer -- "締切前夜に全員で徹夜してリリースを間に合わせた話" demo1`
5. 結果は `out/demo1/trailer.mp4`（1920x1080 / 30fps）。中間生成物は `out/demo1/` に残るので工程単位でやり直せます（`node scripts/images.mjs demo1 --force` 等）。

詳細は [docs/AI_STACK_SETUP.md](docs/AI_STACK_SETUP.md) と [CLAUDE.md](CLAUDE.md) を参照。
