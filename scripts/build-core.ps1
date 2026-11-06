# Windows：编译 Go 内核为 sidecar（imagegend-x86_64-pc-windows-msvc.exe）
# 用法：./scripts/build-core.ps1 [-Arch amd64|arm64]
param([string]$Arch = "amd64")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "app\src-tauri\binaries"
New-Item -ItemType Directory -Force $out | Out-Null
$cpu = if ($Arch -eq "arm64") { "aarch64" } else { "x86_64" }
Push-Location (Join-Path $root "core")
try {
  $env:CGO_ENABLED = "0"; $env:GOOS = "windows"; $env:GOARCH = $Arch
  go build -trimpath -ldflags "-s -w -H windowsgui" -o "$out\imagegend-$cpu-pc-windows-msvc.exe" ./cmd/imagegend
  if ($LASTEXITCODE -ne 0) { throw "go build 失败" }
} finally {
  Pop-Location
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
}
Write-Host "已生成 $out\imagegend-$cpu-pc-windows-msvc.exe"
