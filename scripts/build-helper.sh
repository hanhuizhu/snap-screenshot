#!/usr/bin/env bash
# Builds the native winsnap helper for both CPU architectures and lipos a
# universal binary. Falls back to a single-arch build when a slice is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/winlist.swift"
OUT="$ROOT/build"
mkdir -p "$OUT"

command -v swiftc >/dev/null || { echo "swiftc not found — skipping native helper"; exit 0; }

build_slice() {
  local arch="$1"
  local target="$2"
  local out="$OUT/winsnap-$arch"
  echo "  · compiling winsnap for $arch"
  # 先删旧产物：否则 swiftc 编译失败时，上一轮留下的文件会让下面的存在性检查误判成功
  rm -f "$out"
  swiftc -O -target "$target" -o "$out" "$SRC" 2>&1 | grep -v "warning:" || true
  if [ ! -f "$out" ]; then
    echo "  ! $arch slice failed"
    return 1
  fi
  return 0
}

x64ok=0; arm64ok=0
build_slice x64 "x86_64-apple-macosx11.0" && x64ok=1
build_slice arm64 "arm64-apple-macosx11.0" && arm64ok=1

if [ "$x64ok" = 1 ] && [ "$arm64ok" = 1 ]; then
  lipo -create -output "$OUT/winsnap" "$OUT/winsnap-x64" "$OUT/winsnap-arm64"
  echo "  · universal winsnap: $(lipo -archs "$OUT/winsnap")"
elif [ "$x64ok" = 1 ]; then
  cp "$OUT/winsnap-x64" "$OUT/winsnap"
elif [ "$arm64ok" = 1 ]; then
  cp "$OUT/winsnap-arm64" "$OUT/winsnap"
else
  echo "  ! no helper built; smart-detect will fall back to window level"
  exit 1
fi

chmod +x "$OUT/winsnap" "$OUT"/winsnap-* 2>/dev/null || true
echo "  · helper ready: $OUT/winsnap"
