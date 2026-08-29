# アクション映画予告生成アプリ 企画メモ（技術実現性 + 活用シーン）

作成: 2026-08-29。技術面は公式ドキュメント確認＋本PCでの実機検証（ffmpeg パイプラインで 32 秒の完成 mp4 まで出力済み）に基づく。

## 1. 結論

**実現可能。** 「テキスト（＋任意で写真）→ 台本 → 静止画8枚 → ナレーション → BGM → ffmpeg 合成 → 30〜60秒 mp4」の構成で、1本あたり **約$0.6・3〜4分**（並列化＋Tier2で約2分）。OpenAI $5 前払いで発表品質のフル生成が 7〜9 本、開発用の低画質なら 20 本以上作れる。

当初想定からの変更点:
| 項目 | 変更 | 理由 |
|---|---|---|
| 動画生成AI（Sora） | **不採用** | 2026-09-24 に API 停止。かつ「人物の顔を含む入力画像を拒否」する仕様で企画と非互換 |
| BGM | ElevenLabs **Starter $6/月**（1か月だけ）＋ フリーBGMをローカル保険 | Music API は**有料契約者限定**（Free 不可）。Suno は 2026-09-03 から無料枠が生涯7回DLのみに |
| ナレーション | OpenAI `gpt-4o-mini-tts`（`instructions` で予告編演技を指示可） | 60秒 約$0.015。保険に VOICEVOX（無料・要クレジット表記） |

## 2. アーキテクチャ（Phase 3-A/B/C 実装後・2026-08-30 更新）

```
入力: エピソード文（＋任意: 主役の写真 ※Phase 4）
  │
  ▼ ① 台本生成   script.mjs  gpt-5.6-luna + Structured Outputs                ~10秒 / $0.003
  │    { title, tagline, presents, release_line, cast_lines, interstitials[2],
  │      scenes[5]{ scene_type, narration, telop, telop_timing, dialogue+speaker, screen_text[],
  │                 image_prompt, motion_beat, camera_beat, ambient, cut_count, duration_sec } }
  │    旧 script.json は ①' enrich.mjs で非破壊的に同形へ拡張（$0.02）
  │    各シーンは characters[]（hero/senpai/boss）と location（enum: office/meeting/server/corridor/home）を持つ
  ▼ ⓪ 基準画像     refs.mjs  gpt-image-2 / medium → assets/refs/                 ~40秒 / $0.042/枚
  │    char_<key>.png … 同一人物の 3 ビュー（正面／斜め 45 度／全身）を 1 枚に。灰背景・均一照明・文字なし
  │    loc_<key>.png  … 人物なしのロケーション基準プレート（照明・色・小道具の基準）
  │    **ジョブ横断で使い回す**（git 管理外）。既存はスキップするので 2 本目以降は $0
  ▼ ② 起点静止画 ×5  images.mjs  gpt-image-2 / 1536x1024                       ~40秒 / $0.02〜0.21
  │    **images/edits** で image[] に「そのシーンの characters のキャラシート（最大 3 枚）＋
  │    location のプレート（1 枚）」を添付 → 5 枚を並列生成しても顔・服・部屋が揃う
  │    参照が 1 枚も無いシーンは images/generations にフォールバック
  ├─▶ ③ 動画 ×5   video.mjs  Veo 3.1 Lite image-to-video 720p（motion-first、セリフは引用符） 1〜6分 / $0.05/秒
  │     並列 3 → ポーリング → 即DL。失敗はそのシーンだけ still（Ken Burns）
  ├─▶ ③' 音声     narration.mjs  gpt-4o-mini-tts: ナレ 5 本(cedar, scene_type 別 instructions) + セリフ 3 本(別声)
  └─▶ ④ BGM      bgm.mjs  assets/bgm/ → ElevenLabs Music → ffmpeg 合成音（現状）
  ▼ ⑤ 合成       render.mjs  ffmpeg（-/filter_complex）                         ~30秒 / $0
  │    タイムライン: scene_type 別カット長上限で split/trim → 14 カット + カード 6 枚
  │      （PRESENTS / 中間カード×2 / 黒 0.5s 全レーン無音 / タイトル+タグライン+キャスト）
  │      疑似寄り・スロー・白フラッシュ・手ブレ・ハードカット主体
  │    ルック: 軽い curves + eq + vignette → bloom(gbrp blend) → grain → レターボックス 138px
  │    文字: 全テキストを 1 枚の ASS（telop.ass）で。字間・fad・blur・スケールイン
  │    音 4 レーン: 環境音（Veo 音声、クリップ毎 −20dBFS 正規化 ×0.9、ナレ中 −6dB）
  │               ナレ（EQ→コンプ→短エコー→リミッタ）／セリフ（小部屋の残響）／BGM ×0.22
  │               → amix(normalize=0) → loudnorm I=-14 → alimiter → 48kHz
  → trailer.mp4 1920x1080 / 30fps（demo3: 35.7 秒、−13.7 LUFS）

run.mjs: ① → ①'(不足時) → ⓪(不足分のみ) → ② → ③ → ③' → ④ → ⑤。--stills で ③ をスキップ
```
設計原則: 工程ごとに独立スクリプト、中間生成物は `out/<job>/` に残す。台本 JSON が唯一の真実で、演出判断はすべてそこに書かれ render は解釈するだけ。

### コード構成（クリーンアーキテクチャ・2026-08-30 リファクタ）

上の ①〜⑤ は同じまま、実装だけを**依存が内向きだけになる 4 層**に組み替えた（挙動・CLI・出力は変更なし）。

```
src/domain/    外部依存ゼロ。台本の型・normalize・enrichedView（旧台本互換）・lint、固定キャスト／ロケ、
               各工程のプロンプト（文字列データ）、タイムライン設計（カット割り・カード配置・
               xfade オフセット・ASS・filter_complex の文字列生成）、単価表
src/usecases/  工程のオーケストレーション。ポート（引数の deps）にだけ依存
src/adapters/  ポートの実装: openai(text/image/tts) / gemini(veo) / ffmpeg(exec,filters,ass) /
               storage(jobStore, files, refsStore, env)
src/cli/       引数解析と createDeps()（composition root）
scripts/*.mjs  src/cli/*.mjs を呼ぶだけの互換エントリ（コマンドの使い方は従来どおり）
test/          domain の純関数のユニットテスト（node --test / API を呼ばない）
```

狙いは「**演出の判断を全部 domain の純関数に閉じ込め、$0 でテストできるようにする**」こと。
カット割り・xfade オフセット・ASS・filter_complex は ffmpeg を起動せずに文字列として検証でき、
Veo や画像を再生成せずに演出のイテレーションが回せる。
リファクタの妥当性は、demo1 / demo3 / lambda の `fc.txt`・`telop.ass`・`cuts/fc_c*.txt` が
リファクタ前と**バイト単位で一致**することで確認した。

### 1本あたりの見積（Phase 2）
| 項目 | 費用 | 時間 |
|---|---|---|
| 台本・静止画(low)・TTS | 約 $0.1 | 約 1 分 |
| 動画 20 秒（Lite 720p） | 約 $1.0（Fast なら $2.0） | 1〜3 分（最悪 6 分） |
| 合成 | $0 | 約 30 秒 |
| **合計** | **約 $1.1〜1.3** | **約 3〜7 分** |

ライブデモは事前生成が前提。当日は「台本＋静止画までライブ、動画は事前生成分を再生」等の運用にする。

### Phase 2 実測（2026-08-29、demo3）
- 出力 24.6 秒（5 シーン動画化、フォールバック 0）、**実時間 118 秒**（台本 13s → 画像‖ナレ‖BGM 22s → Veo 70s → 合成 13s）、**費用 $1.29**（Veo 24 秒 $1.20 ＋ OpenAI $0.09）
- Veo Lite: 4 秒クリップ可、並列 3 で 429 なし、1 本あたり約 35 秒。`negativePrompt` は Lite 非対応（否定語はプロンプト本文に付与）。起点画像は 16:9 にクロップしてから渡す（3:2 のままだと黒帯ごと動画化される）

### ライブデモの運用方針（案）
- 実時間 2 分は「無言で待つ」には長いが、**工程ごとに途中成果を見せれば持たせられる**: 台本 JSON（13 秒で出る）を読み上げ → 静止画 5 枚が並ぶ（+22 秒）→ 動画が 1 本ずつ埋まる（+70 秒）→ 完成。
- **本編は事前生成 2〜3 本**（用途別: 忘年会オープニング／送別会／リリース告知）。ライブ生成は会場からもらったネタで **1 本だけ**。
- 保険: Veo がタイムアウト・拒否した場合は自動で静止画 Ken Burns に落ちるので、デモが止まることはない。ネットワーク断に備えて `--stills` 実行と事前生成分の再生をフォールバックに。
- 予算: 当日 5 本生成しても $7 程度。`VEO_BUDGET_SEC`（既定 48 秒/ジョブ）で暴走を防止。

### 効果音の方針
Phase 2 は Veo 同梱音声（映像に同期した環境音・動作音）のみ。プロンプトに "no dialogue, no speech" を固定して勝手なセリフを抑止する。編集点の音（カット切替の whoosh、白フラッシュの impact、タイトルの braam）は Veo では付かないため、必要なら Phase 3 で ElevenLabs SFX を数個生成して `assets/sfx/` に常備する。

## 3. コストと時間（1本）

| 項目 | 開発ループ(low) | 発表用(medium) |
|---|---|---|
| 台本 | $0.003 | $0.003 |
| 画像8枚 (+参照写真の入力分) | $0.04 (+$0.05) | $0.33 (+$0.05〜0.1) |
| TTS 60秒 | $0.015 | $0.015 |
| BGM 45秒 | $0.135 | $0.135 |
| 合計 | **約$0.25** | **約$0.6〜0.7** |

所要時間: Tier1（$5チャージ、画像 5枚/分の制限）で約3〜4分、Tier2（$50 チャージ、20枚/分）で約1.5〜2分。**ライブデモ体感を良くする最良の投資は $50 チャージ**。

## 4. 実装リスク トップ5 と回避策

1. **🔴 実在人物の写真が画像モデレーションで弾かれる**（最大の不確実性・第三者報告あり）
   → 初日の最初の1時間で同僚写真1枚を `images/edits` に通して Go/No-Go。**写真なし（シルエット・後ろ姿・アバター主役）モードを既定**にし、写真は通れば使うオプション扱い。
2. **🔴 Tier1 レート制限（5枚/分）でライブが間延び**
   → $50 で Tier2。シーン数 8→6。開発は low 画質。ライブ生成は1本だけ、残りは事前生成。台本（10秒で出る）を先に読み上げて場を持たせる。
3. **🟡 8シーンで顔の一貫性が崩れる**（公式が Limitations で明記、seed なし）
   → 同一人物の複数アングル写真を全シーンに固定で渡す。`previous_response_id` はシーン間で使わない。正面顔は2〜3カットに絞り、シルエット・手元・寄りを混ぜる（予告編の文法として自然）。
4. **🟡 Windows の日本語 drawtext で時間を溶かす**（実機で全て再現・解決済み）
   - `fontfile='C\:/Windows/Fonts/YuGothB.ttc'`（スラッシュ区切り＋`\:`）。**`font=` は使わない（セグフォルト）**
   - `.ttc` は face 0 のみ → 游ゴシック Bold（YuGothB.ttc）を既定に。BIZ UDP / MS P ゴシックは face 1 で不可
   - `textfile='tN.txt':expansion=none`（`%` と半角 `:` 対策）
   - `-filter_complex_script` は ffmpeg 9 で削除 → `-/filter_complex fc.txt`
   - `zoompan` の前に `scale=iw*4:ih*4`（ジッター解消）、`fps=30` `s=1920x1080` を明示
   - `amix` は `normalize=0`、`loudnorm` の後に `aresample=48000`
5. **🟡 音源の調達手段（法務ではなくプラン制限の話）**
   - 社内発表のみのため商用ライセンス・帰属表記・肖像権は**考慮不要**（2026-08-29 決定）。
   - 残る制約はプラン上のもの: ElevenLabs **Music API は有料契約者限定**（Free では呼べない。TTS/SFX は Free でも可）。Suno は **2026-09-03 から無料枠が生涯7回DL**。
   - 選択肢: (a) ElevenLabs Starter $6 を1か月だけ契約して API 統合を見せる、(b) Suno Web UI で数曲だけ手動生成（7回以内）して素材として同梱、(c) フリーBGM（DOVA-SYNDROME・効果音ラボ）をローカル同梱。**(c) を保険に必ず用意し、(a) か (b) は演出とデモ時間の都合で選ぶ。**
   - 顔写真の主役化が弾かれるのはモデレーション（技術）側の問題なので、リスク1の Go/No-Go 検証は引き続き必要。

## 5. 「役立つ」方向への活用シーン

### メイン・ユースケース（発表で使う順: 掴み → 共感 → 実用）
| 順 | シーン | 入力 | 価値 |
|---|---|---|---|
| 掴み | **忘年会・キックオフのオープニング予告** | 部署の今年の出来事＋メンバーの写真 | 乾杯前に会場が沸く定番演出。写真なしでも成立 |
| 共感 | **送別会・内定式・表彰式の人物予告** | 本人のエピソード数行 | 贈る言葉より記憶に残る。表彰式が「映画祭」になる |
| 実用 | **リリース告知ティザー** | 新機能の一言コピー | 告知メール vs 予告編動画の Before/After で「明日から使える」と伝わる |
| 実用 | **新プロジェクト・キックオフ予告** | プロジェクト名と目的 | 士気向上。ロゴだけでも作れる |
| 実用 | **研修・朝会のイントロ動画** | 研修名・今週の目標 | 形骸化した場に「見る動機」を作る |

### その他の活用先（抜粋）
- 社内: 運動会の部門対抗煽り、サークル勧誘、展示会ブースのループ動画、成果発表会オープニング、営業提案の導入
- 個人: 結婚式余興、誕生日、卒団ムービー、家族旅行ダイジェスト、受験決起
- 地域: 文化祭・体育祭告知、商店街セール、町内会の祭り・防災訓練の意識喚起

### ネタ枠 → 実用枠への見せ方
1. **二枚看板**: 遊び名（例「予告編メーカー」）で笑いを取り、後半で業務名（例「告知動画自動生成」）に切り替える
2. **ポジショニング＝「動画版プレスリリース」**: 告知メール／Slack 投稿と所要時間・注目度で比較表を1枚
3. **トーン切替テンプレート**: アクション予告／感動ドキュメンタリー／ニュース速報／企業CM を選べる → 「ネタ動画」でなく「トーン可変の動画生成基盤」に見える
4. **用途別テンプレートパック**: 社内告知／イベント集客／研修導入／地域告知の穴埋めフォーム
5. **ビフォーアフター指標**: 最後に「開封率→視聴完了率」など測れる指標（仮でも）を提示し、評価軸を「面白い」から「導入価値」へ

## 6. 次のステップ
1. OpenAI に $5（推奨 $50）チャージ、ElevenLabs Starter 契約、シェル再起動で ffmpeg 確認
2. **Go/No-Go 検証**: 同僚写真1枚で `images/edits` が通るか
3. 台本 JSON スキーマ確定 → 1シーンの縦切り（画像1枚＋TTS＋テロップ＋BGM）を最速で通す
4. 事前生成 2〜3本＋ライブ用フォールバック（ローカル素材・`--offline`）を用意

※ 法務面（商用ライセンス・帰属表記・肖像権）は社内発表のみのため考慮しない方針。

## 主な出典
- OpenAI: https://developers.openai.com/api/docs/pricing / .../guides/image-generation / .../api-reference/images/createEdit / .../guides/text-to-speech / .../guides/rate-limits / .../deprecations
- Anthropic（サブスクに API は含まれない）: https://support.claude.com/en/articles/9876003
- ElevenLabs: https://elevenlabs.io/pricing / https://elevenlabs.io/docs/overview/capabilities/music / https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform
- Suno 変更点: https://help.suno.com/en/articles/13614785
- VOICEVOX: https://voicevox.hiroshiba.jp/qa/ 、DOVA-SYNDROME: http://dova-s.jp/help/articles/terms/ 、効果音ラボ: https://soundeffect-lab.info/about/
- ffmpeg: https://ffmpeg.org/ffmpeg-filters.html 、Remotion ライセンス（4人以上の企業は有償）: https://www.remotion.dev/docs/terms
