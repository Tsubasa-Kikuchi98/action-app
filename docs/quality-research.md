# Phase 3 調査: 予告編の「面白さ・迫力」を上げる打ち手

調査日: 2026-08-29。Web 調査（出典付き）＋ 本PC（ffmpeg 9.0.1）で demo3 素材を使った実機検証。BGM・効果音はスコープ外。
試作: `out/demo3/trailer_v2_preview.mp4`（打ち手 1〜4 を demo3 の既存クリップに適用、24.2 秒、追加費用 $0）。比較画像: [docs/img/](img/)。

## 結論: 効果が大きい順の打ち手トップ 10

| # | 打ち手 | 期待効果 | 費用 | 根拠 |
|---|---|---|---|---|
| 1 | **カットランプ（終盤加速）**: 5 カット → 10〜14 カット。S3〜S5 を 0.8〜1.8 秒に割り、xfade をやめてハードカット主体に | 最大。「予告らしさ」の正体はカット長の推移。AI 映像の破綻が見える時間も短くなる | $0 | Mad Max 予告の実測: 前半 3.48 秒/ショット → 後半 0.82 秒/ショット（vashivisuals.com/mad-max-fury-road-trailer/） |
| 2 | **レターボックス 2.39:1 ＋ 軽いグレード ＋ ブルーム ＋ グレイン** | 大。1 フィルタ列で「プロっぽく」。端の破綻も隠れる | $0（+3 秒/本） | filmdaft.com「黒帯だけでプロの制作物に感じられる」。本PCで検証済み |
| 3 | **テロップ／タイトルを drawtext → `ass`（libass）** | 大。字間（Spacing）・フェード・スケールイン・ぼかし・罫線が 1 ファイルで書ける。手動空白挿入が不要に | $0 | 本PCで動作確認 |
| 4 | **タイトル直前に「無音の黒」0.4〜0.6 秒をハードカットで**（stopdown） | 中〜大。タイトルの着地が強くなる | $0 | rareformaudio.com / epikton.net |
| 5 | **TTS: `speed` 1.15 → 1.0、`instructions` を openai.fm 公式形式（`ラベル:`＋空行）でシーン別に** | 中〜大 | $0 | openai.fm 公式プリセット 29 件は全てラベル形式（github.com/openai/openai-fm）。`speed` は gpt-4o-mini-tts で効くか公式見解が矛盾 |
| 6 | **Veo プロンプトを motion-first に**: 起点画像に写っているものを再記述しない。被写体／カメラ／環境の 3 レイヤーを各 1 つ、動きは 1〜2 種 | 中〜大。「動かない・ぬるっと動く」の主因は外見描写 | $0 | veo3gen.app / veo3ai.io |
| 7 | **Veo は 8 秒生成 → 使うのは 4〜6 秒**（後半の破綻を捨てる） | 中 | +$0.20/シーン | dev.to「5 秒生成して 2.5 秒に切る」 |
| 8 | **ナレーション音声のトレーラー処理**（EQ → コンプ → 短エコー → リミッタ） | 中。「胸で響く」は TTS 単体では出ない | $0 | 本PCで検証（レベル中立） |
| 9 | **Veo Fast ＋ `referenceImages`（最大 3 枚）で人物一貫性** | 中〜大（人物主役の回）。**Lite は referenceImages 非対応** | 2 倍 | ai.google.dev/gemini-api/docs/veo |
| 10 | **台本に `scene_type` / `cut_count` を追加**して緩急を強制 | 中。LLM は放っておくと均等に書く | $0 | 予告は Cold Open → Act1 → Act2 → Act3 → Button（jonnyelwyn.co.uk） |

番外: Lite の 1080p は $0.08/秒で Fast 720p（$0.10）より安い。一貫性が要るなら Fast 一択。

## 1. 予告編の編集文法（要点）
- 構造は Cold Open → Act1 → Act2 → Act3 → Button（最後の一発）
- カット長: 前半 3.5 秒/カット → 終盤 0.8 秒/カット（約 4 倍加速）。モンタージュは 1〜2 秒
- 最初の 5〜10 秒で強いビジュアルを 1 つ立てる
- stopdown: タイトル前に「静寂＋黒」へのハードカット。「静寂は不在ではなくコントラスト」
- フェードは「カットでは唐突すぎる場所」だけ。フラッシュフレームは弱い素材を隠す手法 → AI 素材の破綻隠しに転用可
- タイポグラフィ: 字間をたっぷり、日本語は太めゴシック＋フェードイン
- レターボックス 2.39:1 = 1920×804、上下 138px の黒帯
- ナレ＝語り（説明最小）、テロップ＝ターニングポイントの標識

## 2. Veo 3.1 プロンプト設計（公式）
- 公式フォーミュラ: **[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]**
- 公式語彙: dolly / tracking / crane / aerial / slow pan / POV / eye-level / top-down、wide / close-up / extreme close-up / low angle、shallow depth of field / rack focus 等
- **否定は肯定形で書く**（公式: `no buildings` ではなく `a desolate landscape with no buildings or roads`）。現状の `no dialogue, no speech` は公式推奨と逆
- 音声: セリフは引用符で指定される → **引用符を使わない＋`Ambient noise:` を明示**して音の枠を埋める
- **タイムスタンプ・プロンプティング**: `[00:00-00:02] … [00:02-00:04] …` で 1 クリップ内に複数ショットを指示可（公式例あり）→ カットランプを Veo 側で作ることも可能
- モデル別: referenceImages / first-last frame / extension / 4K は **Lite 非対応**。`negativePrompt` は 3.1 のドキュメントに記載なし（Lite で 400 になった実測と整合）。Lite のプロンプト上限 1,024 トークン
- 価格（秒・音声込み）: Standard $0.40、Fast $0.10（1080p $0.12）、Lite $0.05（1080p $0.08）
- image-to-video で動きを出す: 画像の再記述をしない／カメラ移動を明示／力の動詞（push, pull, strike, slam, sway）／3 レイヤー／動きは 1〜2 種

## 3. 起点画像（gpt-image-2）
- 動きの余白（headroom / lead room）、極端なクローズアップと手の複雑な動作は避ける（破綻しやすい）
- 小物・ロゴ・文字は毎フレーム再推定されて崩れる → 後工程で載せる
- 語彙: teal and orange grade / low-key / chiaroscuro / rim light / practical lights / volumetric haze / anamorphic flare / silhouette against monitor glow / low angle hero shot / dutch angle
- `no text, no logos` の否定形は逆効果の可能性（gpt-image-2 では未検証）→ `clean unmarked surfaces` 等の肯定形と A/B

## 4. ナレーション
### OpenAI gpt-4o-mini-tts
- `instructions` で制御可: Accent / Emotional range / Intonation / Impressions / Speed / Tone / Whispering。日本語は「対応するが英語最適化」
- `speed` は有効か公式見解が矛盾（2025-05 に「非対応」→ 後に「効く」報告）。**1.0 に戻し、速度は `Pacing:` で制御**
- openai.fm プリセットで予告編に近いのは Dramatic / True Crime Buff / Noir Detective で**いずれも voice `ash`**。cedar は "warm and grounded"（重厚より温かみ寄り）→ **cedar / ash / onyx / ballad を実聴比較**
- 構造: `Voice Affect:` `Tone:` `Pacing:` `Emotion:` `Pronunciation:` `Pauses:` `Emphasis:` を空行区切り。Pauses / Emphasis では対象語句を引用
### ElevenLabs eleven_v3
- GA、日本語対応、`language_code: "ja"` 有効。audio tags（`[whispers]` `[sighs]` `[excited]` 等）は日本語本文に英語タグ混在で動作
- **落とし穴: 250 字未満は不安定と公式明記** → 5 シーンを 1 リクエストで生成し無音で分割する設計が必須
- `stability` は Creative / Natural / Robust の 3 択。タグを活かすなら Robust は避ける
- 価格 $0.10/1K 字（1 本 $0.008）。判断軸は品質と実装コストのみ。Free 枠の API 利用可否・日本語向き voice_id は未確認（Voice Design で生成が早い可能性）

## 5. ffmpeg ポスプロ — 新たに判明した落とし穴（実機検証済み）
| # | 事実 |
|---|---|
| A | **`blend` は RGB（`format=gbrp`）で行う。** YUV のまま screen 合成すると画面全体がマゼンタになる。後で `format=yuv420p` に戻す |
| B | **動画入力に `zoompan` を使うときは `fps=30` を前に置く。** zoompan は fps 変換しないため 24fps の Veo 出力が 4.0 秒→3.2 秒に縮む |
| C | **`crop` の w/h は `t` を使えない**（x/y は可）。手ブレは crop の x/y、push-in は zoompan で |
| D | **`asubboost` は約 10 LU 下がる。** 低域は `bass=g=3:f=110:w=0.5` で |
| E | **重い `curves` は AI 映像を潰す。** 既に teal-orange 済みなので軽いリフト＋S 字に留める |
| F | **`ass` フィルタが使える**（libass / fontconfig 同梱）。`-/filter_complex` 内で `ass=f=out/<job>/telop.ass`。フォント `Yu Gothic` + Bold で YuGothB.ttc が解決。心配なら `fontsdir=C\:/Windows/Fonts` |
| G | `minterpolate` は 2 秒素材に 4.1 秒かかり AI 映像で破綻しやすい → スローは `setpts` で |

処理時間（24 秒の予告編、全部入り）: 本編 13.7 秒 ＋ タイトル 1 秒 ＋ 結合 4 秒 ≒ 19 秒（現行 13 秒）。

## 6. LLM で予告編コピーを書かせるコツ
- ナレ＝語り、テロップ＝断言（対比／問いかけ／極短の体言止め）
- 「その日……すべてが、変わった。」のように全角三点リーダーで間を作る。読点を多用せず文を切る
- 読みが二通りある漢字と社内固有名詞は開く（TTS 誤読対策として唯一確実）
- 「何も完全には解決しない」。見せ場 → 言葉 → 見せ場の交互

## 本アプリへの適用案（実装時の参照用）

### A. script.mjs
スキーマ追加: `scene_type`（cold_open / setup / turn / montage / resolve / title）、`cut_count`（1,1,2,3,3 基準）、`motion_beat`（力の動詞 1 つ）、`camera_beat`（Veo 公式語彙 1 つ）、`ambient`。`video_prompt` はこれらに分解。
プロンプト追記: 尺は降順ランプ（6/5/4/4/4）、cut_count 基準、冒頭 3 秒で強いビジュアル、三点リーダーで間、漢字を開く、演出指示を本文に書かない、テロップは 12 字以内で断言。

### B. video.mjs — motion-first テンプレート
```
<camera_beat>. <motion_beat>. Secondary motion: <env_beat>.
The scene keeps the exact lighting, color and framing of the source image.
Ambient noise: <ambient>.
The scene is wordless and no one speaks; only ambient sound is heard.
```
外見（anamorphic, teal-orange…）は書かない。scene_type 別カメラ既定値（cold_open: slow dolly in, wide / setup: handheld push-in, medium / turn: low-angle tracking, shallow DoF / montage: fast crane rising, wide / resolve: slow pull-back crane, wide）。
運用: 8 秒生成→4〜6 秒使用（5 シーン $2.00）。人物一貫性が要る回は Fast ＋ referenceImages（$4.00）。

### C. narration.mjs
- `TTS_SPEED` 既定 1.0
- 共通ブロック（全シーン同一）: `Voice Affect: Deep, resonant, and gravelly; a seasoned movie-trailer narrator with a heavy chest voice…` / `Tone: Dark, ominous, and monumental…` / `Pronunciation: Low in the register…` / `Punctuation: Ellipses (……) indicate deliberate silence; hold them fully. A period is a hard, complete stop.`
- scene_type 別ブロック: cold_open = Very slow, restrained / setup = slow with forward lean, dawning unease / turn = tightening, contained alarm, minimal pauses / montage = slow and immovable, steel-hard resolve / resolve = extremely slow, monumental, long silence before the title
- ElevenLabs v3 版: 5 シーンを 1 リクエスト、`[whispers]` `[sighs]` `[excited]` 等の公式タグ、stability Natural、`silencedetect` で分割
- 後処理: `highpass=f=70, equalizer=f=115:t=q:w=1.0:g=4, equalizer=f=330:t=q:w=1.2:g=-3, equalizer=f=3800:t=q:w=1.6:g=3, acompressor=threshold=0.08:ratio=4:attack=8:release=180:makeup=2, aecho=0.9:0.85:38:0.12, alimiter=limit=0.94`

### D. render.mjs — フィルタ断片（検証済み）
グレード＋ブルーム＋グレイン＋レターボックス:
```
[0:v]scale=1920:1080:flags=lanczos,fps=30,
 curves=r='0/0.00 0.5/0.52 1/1.00':g='0/0.005 0.5/0.50 1/0.995':b='0/0.030 0.5/0.48 1/0.95',
 eq=contrast=1.06:saturation=1.10,vignette=PI/5[base];
[base]format=gbrp,split=2[b1][b2];
[b2]curves=all='0/0 0.72/0 1/1',gblur=sigma=26[bl];
[b1][bl]blend=all_mode=screen:all_opacity=0.30,format=yuv420p[bloomed];
[bloomed]noise=alls=5:allf=t+u,ass=f=out/<job>/telop.ass,
 drawbox=x=0:y=0:w=iw:h=138:color=black@1:t=fill,
 drawbox=x=0:y=ih-138:w=iw:h=138:color=black@1:t=fill,
 settb=AVTB,fps=30,setsar=1,format=yuv420p[v]
```
ASS テロップ: Style `Telop,Yu Gothic,62,…,Spacing=12,…,Alignment=2,MarginV=168`、`{\fad(500,350)\blur1.2\fscx104\fscy104\t(0,700,\fscx100\fscy100)}テキスト`。
タイトル: Main 128px Spacing 28 ＋ 罫線 `{\p1}m -220 0 l 220 0 l 220 2 l -220 2{\p0}` ＋ Sub 36px Spacing 22 "COMING SOON"。
カットランプ: 各クリップを `split` → `trim` → `setpts=PTS-STARTPTS` → `concat`。**ナレーションは映像カットと切り離し `adelay` でシーン開始時刻に置いて `amix`**（音を先に敷き、絵を後で合わせる）。
stopdown: `color=c=black` 0.5 秒 ＋ `anullsrc` を title 前に concat。
手ブレ: `crop=1880:1058:x='20+7*sin(2*PI*t*3.3)+3*sin(2*PI*t*7.1)':y='11+5*sin(2*PI*t*2.7)',scale=1920:1080`（turn / montage のみ）。
push-in: `fps=30,scale=iw*2:ih*2,zoompan=z='min(1+0.002*on,1.18)':…:d=1:s=1920x1080:fps=30`。
フラッシュ: 白 2 フレーム（0.067 秒）を加速点に 1 回。スロー: `setpts=(PTS-STARTPTS)*2.0`。

## 未確認事項（実装時に 1 分で確定できるものが多い）
1. `speed` が gpt-4o-mini-tts で有効か → speed だけ変えて 2 本生成し尺比較
2. 日本語の「……」「、」による間の制御効果 → 3 本聴き比べ
3. cedar / ash / onyx / ballad の日本語音質差 → 同一 instructions で 4 本
4. Lite と Fast の画質差（referenceImages 可否以外）
5. ElevenLabs Free 枠の API 利用可否、日本語向き voice_id
6. 公式一覧にない audio tags（`[narration]` 等）の効果
7. gpt-image-2 での否定形の逆効果
8. **Gemini API に `Gemini Omni Flash` という動画モデルが登場し公式で「推奨デフォルト」**（ai.google.dev/gemini-api/docs/video）。Veo 3.1 との比較は未調査 → 要検討

## 主な出典
- vashivisuals.com/mad-max-fury-road-trailer/ 、jonnyelwyn.co.uk/film-and-video-editing/how-to-edit-a-movie-trailer/ 、derek-lieu.com（トランジション・編集トリック）、rareformaudio.com/blog/trailer-music-drop-vs-stopdown 、epikton.net/a-quick-guide-to-pacing-in-trailers/ 、filmdaft.com（レターボックス）、madegooddesigns.com/movie-title-design/
- cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1 、ai.google.dev/gemini-api/docs/veo 、ai.google.dev/gemini-api/docs/pricing 、ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview
- developers.openai.com/api/docs/guides/text-to-speech 、github.com/openai/openai-fm 、community.openai.com（speed の議論）
- elevenlabs.io/docs/best-practices/prompting/eleven-v3 、elevenlabs.io/docs/models 、zenn.dev/xei/articles/elevenlabs-v3-dialogue-api
- veo3gen.app / veo3ai.io / segmind.com（image-to-video のコツ）、genra.ai / hailuoai.video（不気味の谷）
