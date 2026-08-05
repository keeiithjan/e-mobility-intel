param(
  [Parameter(Mandatory = $true)]
  [string]$OneDriveRoot
)

$sourceRoot = Split-Path -Parent $PSScriptRoot
$resolvedOneDrive = Resolve-Path -LiteralPath $OneDriveRoot -ErrorAction Stop
$target = Join-Path $resolvedOneDrive '電動微移動情報庫'

if (Test-Path -LiteralPath $target) {
  throw "目標已存在：$target。請先確認內容，再選擇其他資料夾名稱。"
}

New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination (Join-Path $target 'e-mobility-intel-mvp') -Recurse -ErrorAction Stop
Write-Host "已複製到：$target\e-mobility-intel-mvp"
Write-Host '請等待 OneDrive 同步完成，再於其他兩台電腦登入同一帳號。'
