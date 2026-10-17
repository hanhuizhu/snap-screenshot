#!/usr/bin/env bash
# Packages Snap.app for Intel (x64) and Apple Silicon (arm64) and merges them
# into one universal app, then produces .zip + .dmg artifacts in dist/.
#
#   bash scripts/build-app.sh [--skip-universal]
#
# Signing is ad-hoc (no Apple Developer certificate on this machine), which is
# enough to run locally; downloaded copies need the quarantine flag removed —
# documented in README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('$ROOT/package.json').version")"
BUNDLE_ID="com.shuye.snap"
APP_NAME="Snap"
DISPLAY_NAME="Snap 截图"
# 签名身分：显式环境变量 > 仓库自带的「Snap Dev」证书（若已导入本机）> ad-hoc。
# 固定身份让 macOS 把每次打包视为同一应用，屏幕录制等授权不会因换包失效。
#
# 这里刻意不加 find-identity 的 -v：自签身份没有受信任的信任链，-v 不会列出它，
# 但签名照样能用——它的 designated requirement 锚定在证书哈希上
# （certificate root = H"…"），所以重打包后身份不变，这才是 TCC 授权不失效的原因。
SIGN_ID="${SNAP_SIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ] && security find-identity -p codesigning 2>/dev/null | grep -q '"Snap Dev"'; then
  SIGN_ID="Snap Dev"
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="-"
  printf '\033[1;33m! ad-hoc 签名：每次打包都会变成「新应用」，屏幕录制等授权会失效。\033[0m\n'
  printf '\033[1;33m  先跑一次 bash scripts/make-dev-cert.sh 换成固定的「Snap Dev」身份。\033[0m\n'
fi
SKIP_UNIVERSAL=0
[ "${1:-}" = "--skip-universal" ] && SKIP_UNIVERSAL=1

BUILD="$ROOT/build"
DIST="$ROOT/dist"
STAGE_ROOT="$BUILD/app-stage"
DISTS="$BUILD/electron-dists"
mkdir -p "$DIST" "$STAGE_ROOT"
rm -rf "$STAGE_ROOT"/*

log() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- prerequisites

log "native helper (x64 + arm64 → universal)"
bash scripts/build-helper.sh

log "app icon"
if [ ! -f "$BUILD/AppIcon.icns" ] || [ "$BUILD/AppIcon.png" -ot scripts/make-icon.js ]; then
  ./node_modules/.bin/electron scripts/make-icon.js >/dev/null 2>&1 || echo "  ! icon render failed"
  if [ -d "$BUILD/AppIcon.iconset" ]; then
    iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns" && echo "  · $BUILD/AppIcon.icns"
  fi
fi
[ -f "$BUILD/AppIcon.icns" ] || { echo "  ! no icns, continuing without a custom icon"; }

dist_for_arch() {
  case "$1" in
    x64)   echo "$ROOT/node_modules/electron/dist" ;;
    arm64) echo "$DISTS/electron-v$ELECTRON_VER-darwin-arm64" ;;
  esac
}
ELECTRON_VER="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"

# ---------------------------------------------------------------- plist helpers
# plutil, not PlistBuddy: PlistBuddy splits -c commands on spaces, which silently
# breaks values like "Snap 截图".

plist_set() { # file key value [type]  — type last: plist_set f Key value bool
  local f="$1"
  local k="$2"
  local v="$3"
  local t="${4:-string}"
  plutil -remove "$k" "$f" >/dev/null 2>&1 || true
  if [ "$t" = "bool" ]; then
    plutil -insert "$k" -bool "$v" "$f" >/dev/null || echo "  ! plist $k failed"
  else
    plutil -insert "$k" -string "$v" "$f" >/dev/null || echo "  ! plist $k failed"
  fi
}

patch_main_plist() {
  local plist="$1"
  plist_set "$plist" CFBundleName "$APP_NAME"
  plist_set "$plist" CFBundleDisplayName "$DISPLAY_NAME"
  plist_set "$plist" CFBundleExecutable "$APP_NAME"
  plist_set "$plist" CFBundleIdentifier "$BUNDLE_ID"
  plist_set "$plist" CFBundleShortVersionString "$VERSION"
  plist_set "$plist" CFBundleVersion "$VERSION"
  plist_set "$plist" CFBundleIconFile "AppIcon"
  plist_set "$plist" LSUIElement true bool
  plist_set "$plist" NSHumanReadableCopyright "Snap — WeChat-style screenshot tool"
  plist_set "$plist" LSApplicationCategoryType "public.app-category.utilities"
}

rename_helpers() {
  local app="$1"
  local fw="$app/Contents/Frameworks"
  local names=("Helper" "Helper (GPU)" "Helper (Plugin)" "Helper (Renderer)")
  local ids=("helper" "helper.gpu" "helper.plugin" "helper.renderer")
  for i in "${!names[@]}"; do
    local old="$fw/Electron ${names[$i]}.app"
    [ -d "$old" ] || continue
    local new="$fw/$APP_NAME ${names[$i]}.app"
    mv "$old" "$new"
    local exe="$new/Contents/MacOS/Electron ${names[$i]}"
    [ -f "$exe" ] && mv "$exe" "$new/Contents/MacOS/$APP_NAME ${names[$i]}"
    local plist="$new/Contents/Info.plist"
    plist_set "$plist" CFBundleExecutable "$APP_NAME ${names[$i]}"
    plist_set "$plist" CFBundleName "$APP_NAME ${names[$i]}"
    plist_set "$plist" CFBundleDisplayName "$DISPLAY_NAME ${names[$i]}"
    plist_set "$plist" CFBundleIdentifier "$BUNDLE_ID.${ids[$i]}"
    plist_set "$plist" CFBundleShortVersionString "$VERSION"
    plist_set "$plist" CFBundleVersion "$VERSION"
  done
}

# ---------------------------------------------------------------- stage one arch

# A universal merge compares every non-Mach-O file for equality, and per-arch
# code signatures always differ — so merge inputs must be stripped of signatures
# and signed only after merging.
strip_signatures() {
  local app="$1"
  find "$app" -name "_CodeSignature" -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$app" -name "CodeResources" -type f -delete 2>/dev/null || true
}

sign_app() {
  local app="$1"
  local payload="$app/Contents/Resources/app"
  if [ -f "$payload/build/winsnap" ]; then
    codesign --force --sign "$SIGN_ID" "$payload/build/winsnap" 2>/dev/null || true
  fi
  codesign --force --deep --sign "$SIGN_ID" "$app" 2>&1 | grep -v "replacing existing signature" || true
  if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    echo "  · signature OK"
  else
    echo "  ! signature verification reported problems"
  fi
}

stage_app() {
  local arch="$1" out="$2"
  local dist; dist="$(dist_for_arch "$arch")"
  [ -d "$dist/Electron.app" ] || { echo "!! missing Electron dist for $arch ($dist)"; return 1; }

  log "staging $APP_NAME.app ($arch)"
  rm -rf "$out"
  mkdir -p "$(dirname "$out")"
  cp -R "$dist/Electron.app" "$out"

  mv "$out/Contents/MacOS/Electron" "$out/Contents/MacOS/$APP_NAME"
  rename_helpers "$out"

  # --- app payload ---------------------------------------------------------
  rm -rf "$out/Contents/Resources/default_app.asar"
  local payload="$out/Contents/Resources/app"
  mkdir -p "$payload"
  rsync -a --exclude '.DS_Store' "$ROOT/src/" "$payload/src/"
  mkdir -p "$payload/build"
  # the devDependency on electron must not leak into the bundle
  node -e "
    const p=require('$ROOT/package.json');
    p.scripts={start:'electron .'};
    delete p.devDependencies;
    require('fs').writeFileSync('$payload/package.json', JSON.stringify(p,null,2));
  "
  cp "$BUILD/winsnap-$arch" "$payload/build/winsnap"
  chmod +x "$payload/build/winsnap"

  if [ -f "$BUILD/AppIcon.icns" ]; then
    cp "$BUILD/AppIcon.icns" "$out/Contents/Resources/AppIcon.icns"
  fi

  patch_main_plist "$out/Contents/Info.plist"
  strip_signatures "$out"
  echo "  · $out  ($(du -sh "$out" | cut -f1))"
}

# ---------------------------------------------------------------- build

APP_X64="$STAGE_ROOT/$APP_NAME-x64.app"
APP_ARM64="$STAGE_ROOT/$APP_NAME-arm64.app"
stage_app x64 "$APP_X64"
stage_app arm64 "$APP_ARM64"

UNIVERSAL="$STAGE_ROOT/$APP_NAME.app"
rm -rf "$UNIVERSAL"
if [ "$SKIP_UNIVERSAL" = 0 ]; then
  log "merging into a universal app"
  if node scripts/make-universal.js "$APP_X64" "$APP_ARM64" "$UNIVERSAL" "$SIGN_ID"; then
    echo "  · ${UNIVERSAL}  ($(du -sh "$UNIVERSAL" | cut -f1))"
    # sign the merged bundle in place too: merge inputs must be unsigned, but
    # leaving the staged result unsigned is a trap for anyone installing it
    log "signing the merged bundle"
    sign_app "$UNIVERSAL"
  else
    echo "  ! universal merge failed — shipping thin builds only"
    SKIP_UNIVERSAL=1
  fi
fi

# ---------------------------------------------------------------- artifacts

package_one() { # app_path label
  local app="$1"
  local label="$2"
  local tmp
  tmp="$(mktemp -d)"
  cp -R "$app" "$tmp/$APP_NAME.app"

  log "signing + packaging $label"
  if codesign --verify --deep --strict "$tmp/$APP_NAME.app" >/dev/null 2>&1; then
    echo "  · signature carried over"
  else
    sign_app "$tmp/$APP_NAME.app"
  fi
  ln -s /Applications "$tmp/Applications"

  local zip="$DIST/$APP_NAME-$VERSION-$label.zip"
  local dmg="$DIST/$APP_NAME-$VERSION-$label.dmg"
  rm -f "$zip" "$dmg"

  ditto -c -k --sequesterRsrc --keepParent "$tmp/$APP_NAME.app" "$zip"
  hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$tmp" -ov -format UDZO "$dmg" >/dev/null
  rm -rf "$tmp"
  echo "  · $(basename "$zip")  ($(du -h "$zip" | cut -f1))"
  echo "  · $(basename "$dmg")  ($(du -h "$dmg" | cut -f1))"
}

log "packaging artifacts"
if [ "$SKIP_UNIVERSAL" = 0 ]; then
  package_one "$UNIVERSAL" "mac-universal"
fi
if [ "${THIN_ONLY_ARTIFACTS:-0}" = 1 ]; then
  package_one "$APP_X64" "mac-x64"
  package_one "$APP_ARM64" "mac-arm64"
fi

log "checksums"
( cd "$DIST" && shasum -a 256 *.zip *.dmg > SHA256SUMS.txt && cat SHA256SUMS.txt )

log "done → $DIST"
