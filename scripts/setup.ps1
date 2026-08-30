# ソースから開発・実行するための初期セットアップ（Windows / PowerShell）。
#
#   PowerShell で:  .\scripts\setup.ps1
#
# やること:
#   1. Node 22 以上があるか確認する
#   2. ffmpeg が無ければ winget で入れる（Gyan.FFmpeg）
#   3. npm install
#   4. .env が無ければ .env.example からコピーする
#   5. 次にやること（API キー・基準画像）を表示する
#
# exe 版（配布用）を使う場合はこのスクリプトは不要です。README の「A. exe で使う」を参照。

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "    !!  $text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. Node
Write-Step 1 "Node を確認します"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn2 "Node が見つかりません。https://nodejs.org/ から 22 以上を入れてから再実行してください。"
  exit 1
}
$nodeVer = (& node -v)
Write-Ok "node $nodeVer  ($($node.Source))"
if ([int](($nodeVer -replace '^v','') -split '\.')[0] -lt 22) {
  Write-Warn2 "Node 22 以上を推奨します（現在 $nodeVer）。"
}
Write-Ok "npm $(& npm -v)"

# ---------------------------------------------------------------- 2. ffmpeg
Write-Step 2 "ffmpeg を確認します"
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$winget = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
$wingetFfmpeg = $null
if (Test-Path $winget) {
  $wingetFfmpeg = Get-ChildItem $winget -Filter "Gyan.FFmpeg*" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem $_.FullName -Filter "ffmpeg-*" -Directory } |
    ForEach-Object { Join-Path $_.FullName "bin\ffmpeg.exe" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($ffmpeg) {
  Write-Ok "$($ffmpeg.Source)"
} elseif ($wingetFfmpeg) {
  Write-Ok "$wingetFfmpeg （PATH には無いが winget の既定パスにあるので自動で見つかります）"
} else {
  Write-Host "    ffmpeg が無いので winget で導入します（Gyan.FFmpeg）…"
  try {
    winget install --id Gyan.FFmpeg --source winget --accept-package-agreements --accept-source-agreements
    Write-Ok "導入しました。PATH を反映するため PowerShell を開き直してください。"
  } catch {
    Write-Warn2 "winget での導入に失敗しました。手動で ffmpeg 9 を入れて PATH を通すか、環境変数 FFMPEG_DIR に bin フォルダを指定してください。"
  }
}

# ---------------------------------------------------------------- 3. npm install
Write-Step 3 "npm install"
npm install
Write-Ok "依存を導入しました（electron / electron-builder は devDependency）"

# ---------------------------------------------------------------- 4. .env
Write-Step 4 ".env を用意します"
if (Test-Path ".env") {
  Write-Ok ".env は既にあります（上書きしません）"
} else {
  Copy-Item ".env.example" ".env"
  Write-Ok ".env を .env.example から作りました"
}

# ---------------------------------------------------------------- 5. 次にやること
Write-Step 5 "次にやること"
Write-Host @"
    1. .env に API キーを書く
         OPENAI_API_KEY   … 台本・画像・ナレーション（必須）
         GEMINI_API_KEY   … 動画生成 Veo（必須。無料枠なし。--stills なら無くても動く）
         ELEVENLABS_API_KEY … BGM・効果音（任意。未設定なら ffmpeg の合成音）

    2. 基準画像を作る（この PC に assets/refs/ が無い場合。約 `$0.25）
         node scripts/refs.mjs --chars --locs office,meeting,corridor

    3. 動作確認（API を呼ばない・`$0）
         npm test
         `$env:TRAILER_MOCK=1; npm run app

    4. 本番の 1 本
         npm run app                                       … デスクトップアプリ
         npm run trailer -- "<エピソード文>" demo1          … CLI

    5. 配布用 exe を作る（ffmpeg を同梱するので約 227MB）
         npm run prepare:ffmpeg
         npm run dist        →  dist\action-app-<version>-portable.exe
"@
