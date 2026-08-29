# AI技術スタックとセットアップ手順

最終更新: 2026-08-29（公式ドキュメント確認 + 本PC（Windows 11 / Claude Code 2.1.201）で実機検証）。予告生成アプリ固有の技術詳細は [trailer-app-plan.md](trailer-app-plan.md)。

補足: 本PCには調査過程で **ffmpeg 9.0.1（winget: Gyan.FFmpeg）** が導入済み。

## 0. 結論：採用スタック

| 役割 | ツール | 契約 | Claude Code からの呼び方 |
|---|---|---|---|
| コーディング | **Claude Code** | 既存サブスク | — |
| イラスト生成 | **OpenAI 画像生成 API（gpt-image-2）** | OpenAI API 前払いクレジット **$5〜**（ChatGPTサブスク不要） | ① `scripts/gen-image.mjs`（直叩き、推奨）／② MCP `@napolab/gpt-image-mcp` |
| BGM・効果音 | **ElevenLabs（Music + SFX）** | **Starter $6/月**（Music API は有料契約者限定。Free 不可） | 公式ホスト型 MCP（OAuth、1行で導入） |
| （Suno） | 自動連携は **不採用** | — | 使う場合は Web UI で手動生成し素材を配置 |

### 当初案からの変更点と理由

1. **ChatGPT/Codex で画像生成 → OpenAI API 直接利用に変更**
   - Codex（CLI・Claude Code 用公式プラグイン `openai/codex-plugin-cc`）は**コーディング支援専用で画像生成機能がない**。`codex mcp-server` も公式に deprecated。
   - 画像生成は OpenAI **API Platform**（ChatGPT とは課金系統が別）で、API キー + 前払いクレジットのみで使える。サブスク不要。
   - 費用感: gpt-image-2 で 1024×1024 が low 約$0.006/枚、medium 約$0.053/枚、high 約$0.21/枚。**横長 1536×1024 の方が安い**（low $0.005 / medium $0.041 / high $0.165。トークン計算式による算出値、初回の `usage` で実測確認）。**$5 で試作は十分**。
   - **レート制限**: $5 チャージ＝Tier 1 は画像 **5枚/分**。ライブデモで多数生成するなら $50 チャージで Tier 2（20枚/分）。
   - gpt-image-1-mini / gpt-image-1.5 は 2026-12-01 廃止予定 → gpt-image-2 に統一。
2. **Suno → ElevenLabs に変更**
   - Suno には 2026-08 時点で**公式 API・公式 MCP が存在しない**。
   - 出回っている `suno-mcp` / `suno-api` 系は自分のアカウントの Cookie/JWT でブラウザ自動操作する方式で、Suno 利用規約（robots/scraping 禁止、非公開手段でのアクセス禁止）に**文言上そのまま抵触** → アカウント停止リスクが高く、社内成果物には不適。
   - リセラー型 API（AceDataCloud 等）は規約リスクは下がるが第三者経由・単価非公開。
   - ElevenLabs は**公式ホスト型 MCP** があり OAuth で API キー管理不要。Music v2 は商用クリア済み。
   - Suno の音質にこだわる場合: **Pro を契約し Web UI で手動生成**が規約上唯一安全な使い方。無料枠は **2026-09-03 から生涯7回のトライアルDLのみ**・非商用限定・帰属表記必須（https://help.suno.com/en/articles/13614785）。

---

## 1. 前提環境（確認済み）

- Node.js 22.17 / npm 10.9 / Python 3.12 / uv 0.7 / Claude Code 2.1.201
- **MCP の登録・削除は必ず PowerShell から行う**（Git Bash 禁止。理由は §5）

## 2. OpenAI 画像生成のセットアップ

### 2-1. API キー取得（約5分）
1. https://platform.openai.com/ にサインイン（ChatGPT と同じアカウントで可。課金は別）
2. Settings → Billing → **Add to credit balance** で **$5** 以上チャージ（前払い必須。1年で失効）
3. Settings → API keys → **Create new secret key**（プロジェクトキー推奨）
4. PowerShell で環境変数に保存し、シェルを開き直す:
   ```powershell
   setx OPENAI_API_KEY "sk-..."
   ```

### 2-2. 方式①: スクリプト直叩き（推奨・MCP不要）
[scripts/gen-image.mjs](../scripts/gen-image.mjs) を使う。Claude Code の Bash から呼べる。

```powershell
node scripts/gen-image.mjs "pixel art hero sprite, side view, transparent background" assets/hero.png
# オプション: 環境変数 IMG_MODEL(既定 gpt-image-2) / IMG_SIZE(1024x1024) / IMG_QUALITY(low)
```

採用理由: 第三者 npm パッケージに API キーを渡さない／常に最新モデル・全パラメータが使える／コンテキストを消費しない。

### 2-3. 方式②: MCP サーバー（Claude に自律的に画像生成させたい場合）
コミュニティ製で gpt-image-2 対応・最新（2026-05 更新）の `@napolab/gpt-image-mcp` を使用。

```powershell
claude mcp add --scope user gpt-image -e OPENAI_API_KEY=$env:OPENAI_API_KEY -- npx -y @napolab/gpt-image-mcp
claude mcp list
```

チームで共有する場合は project スコープ（`.mcp.json` に書き出し、git にコミット）。**生のキーは書かず `${VAR}` 形式で**:
```powershell
claude mcp add --scope project gpt-image -e OPENAI_API_KEY='${OPENAI_API_KEY}' -- npx -y @napolab/gpt-image-mcp
```

生成される `.mcp.json`:
```json
{
  "mcpServers": {
    "gpt-image": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@napolab/gpt-image-mcp"],
      "env": { "OPENAI_API_KEY": "${OPENAI_API_KEY}" }
    },
    "elevenlabs": {
      "type": "http",
      "url": "https://api.elevenlabs.io/v1/mcp"
    }
  }
}
```

## 3. ElevenLabs（BGM・効果音）のセットアップ

1. https://elevenlabs.io/ でアカウント作成し **Starter（$6/月、30,000クレジット）以上を契約**。Music API は有料契約者限定で Free では呼べない。Free の生成物は商用不可＋帰属表記必須
2. PowerShell で MCP 登録（ホスト型・OAuth）:
   ```powershell
   claude mcp add --scope user --transport http elevenlabs https://api.elevenlabs.io/v1/mcp
   ```
3. `claude` を起動 → `/mcp` → `elevenlabs` を選び **Authenticate** → ブラウザでサインイン
4. 商用ライセンスは**全有料プラン（Starter 以上）に付属**と公式明記（Film/TV/大規模ゲームは Enterprise）。目安: Music 900クレジット/分、SFX 200/生成（`duration_seconds` 指定時 40/秒）

注意: 旧手順にある `uvx elevenlabs-mcp`（自前ホスト型リポジトリ）は **2026-08-20 にアーカイブ・非推奨化**。使わない。

## 4. 動作確認

```powershell
claude mcp list            # elevenlabs: ✔ Connected（gpt-image を入れた場合はそれも）
claude mcp get elevenlabs
node scripts/gen-image.mjs "test: a red cube" test.png
```
セッション内で `/mcp` からも接続状態・ON/OFF を確認できる。

## 5. Windows 固有の注意（実機で再現確認済み）

1. **`cmd /c` ラッパーは不要**。素の `npx` で接続できる（Claude Desktop 時代の古い情報は無視）。
2. **Git Bash から `claude mcp add` を実行しない**。MSYS のパス変換で `/c` → `C:/` に化ける。
3. **Git Bash と PowerShell でプロジェクトキーの表記が異なる**（`c:/Users/...` vs `C:\Users\...`）ため、`local` スコープ（既定）で登録したサーバーは別シェルから起動した Claude Code に見えない。→ **`--scope user` か `--scope project` を明示する**。
4. 初回接続で npx のダウンロードがタイムアウトする場合: `$env:MCP_TIMEOUT = "60000"; claude`

## 6. 費用まとめ

| 案 | 画像 | 音 | 月額目安 |
|---|---|---|---|
| 最小コスト（試作） | OpenAI $5 前払い（low/medium） | ElevenLabs Starter $6（BGM が要る場合）／フリー素材（DOVA-SYNDROME・効果音ラボ）なら $0 | **$5〜11** |
| 発表用 | OpenAI 従量（high $0.2/枚） | ElevenLabs Creator $22 | 約 $30 |
| Suno 併用 | 同上 | + Suno Pro $10（手動生成） | 約 $40 |

## 7. 未確認事項（契約・公開前に一次情報で確認）

- OpenAI 1枚単価（第三者換算）／前払い最低額 $5（help.openai.com が自動取得不可。複数二次情報で一致）
- ElevenLabs Music API の生成所要時間（公式に数値なし）
- Suno 料金・クレジット数（suno.com/pricing）

## 参考リンク
- OpenAI 料金: https://developers.openai.com/api/docs/pricing
- OpenAI 画像生成ガイド: https://developers.openai.com/api/docs/guides/image-generation
- Codex プラグイン（画像生成なし）: https://github.com/openai/codex-plugin-cc
- @napolab/gpt-image-mcp: https://www.npmjs.com/package/@napolab/gpt-image-mcp
- ElevenLabs MCP: https://elevenlabs.io/mcp
- Suno 利用規約: https://suno.com/terms-of-service
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Windows `/c` 化け Issue: https://github.com/anthropics/claude-code/issues/20061
