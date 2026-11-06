#!/usr/bin/env bash
# 编译 Go 内核并按 Tauri sidecar 命名放入 app/src-tauri/binaries
# 用法:
#   scripts/build-core.sh                         # 当前系统 + amd64
#   scripts/build-core.sh [linux|windows|macos] [amd64|arm64]
#   scripts/build-core.sh macos --universal       # 同时编译 arm64 + amd64，并在 macOS 上用 lipo 合成 universal-apple-darwin
#   scripts/build-core.sh all                     # 一次编译全部常见目标（交叉编译验证）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app/src-tauri/binaries"
mkdir -p "$OUT"

build() { # $1=os $2=arch
  local OS="$1" ARCH="$2" GOOS T CPU EXT LDF
  case "$OS" in
    darwin|macos|mac) GOOS=darwin; T=apple-darwin;;
    windows|win) GOOS=windows; T=pc-windows-msvc;;
    linux) GOOS=linux; T=unknown-linux-gnu;;
    *) echo "不支持的系统：$OS" >&2; exit 1;;
  esac
  case "$ARCH" in
    amd64|x86_64|x64) ARCH=amd64; CPU=x86_64;;
    arm64|aarch64) ARCH=arm64; CPU=aarch64;;
    *) echo "不支持的架构：$ARCH" >&2; exit 1;;
  esac
  EXT=""; [ "$GOOS" = windows ] && EXT=".exe"
  LDF="-s -w"; [ "$GOOS" = windows ] && LDF="$LDF -H windowsgui"
  local DST="$OUT/imagegend-$CPU-$T$EXT"
  (cd "$ROOT/core" && CGO_ENABLED=0 GOOS=$GOOS GOARCH=$ARCH go build -trimpath -ldflags "$LDF" -o "$DST" ./cmd/imagegend)
  echo "已生成 app/src-tauri/binaries/$(basename "$DST")"
}

universal() {
  build macos arm64
  build macos amd64
  local U="$OUT/imagegend-universal-apple-darwin"
  if command -v lipo >/dev/null 2>&1; then
    lipo -create -output "$U" "$OUT/imagegend-aarch64-apple-darwin" "$OUT/imagegend-x86_64-apple-darwin"
    echo "已生成 app/src-tauri/binaries/$(basename "$U")（lipo 合成通用二进制）"
  else
    echo "提示：当前系统没有 lipo（仅 macOS 自带），已分别生成 aarch64 / x86_64 两个 sidecar；如需 universal 请在 macOS 上运行。"
  fi
}

host_os() { case "$(uname -s)" in Darwin) echo macos;; MINGW*|MSYS*|CYGWIN*) echo windows;; *) echo linux;; esac; }
host_arch() { case "$(uname -m)" in arm64|aarch64) echo arm64;; *) echo amd64;; esac; }

case "${1:-}" in
  all)
    for t in "linux amd64" "linux arm64" "windows amd64" "windows arm64" "macos amd64" "macos arm64"; do build $t; done
    ;;
  --universal|universal) universal ;;
  *)
    OS="${1:-$(host_os)}"
    if [ "${2:-}" = "--universal" ] || [ "${2:-}" = "universal" ]; then
      case "$OS" in darwin|macos|mac) universal ;; *) echo "--universal 仅适用于 macOS 目标" >&2; exit 1;; esac
    else
      ARCH="${2:-$( [ "$OS" = "$(host_os)" ] && host_arch || echo amd64)}"
      build "$OS" "$ARCH"
    fi
    ;;
esac
