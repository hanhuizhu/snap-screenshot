#!/usr/bin/env bash
# 生成并导入稳定的代码签名身份「Snap Dev」——每台机器跑一次。
#
#   bash scripts/make-dev-cert.sh
#
# 为什么需要：ad-hoc 签名的身份等于每次构建二进制的哈希，所以重新打包后
# macOS 会把应用当成一个「新应用」，屏幕录制等 TCC 授权随之失效。换成一个
# 固定的自签身份后，同一台机器上重新打包不再丢授权。
#
# 私钥随仓库分发（assets/cert/snap-dev.p12），因此任何拿到仓库的机器都能签出
# 同一个身份。仓库请保持私有/小范围使用；需要收口时删掉 p12 与本机钥匙串里的
# 证书后重新生成，并让所有成员重新授权一次。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/assets/cert"
P12="$CERT_DIR/snap-dev.p12"
IDENTITY="${SNAP_CERT_NAME:-Snap Dev}"
P12_PASS="${SNAP_CERT_PASS:-snap-dev}"
KEYCHAIN="${SNAP_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

log() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"${IDENTITY}\""; then
  log "身份「${IDENTITY}」已在本机钥匙串，跳过生成"
  security find-identity -p codesigning "$KEYCHAIN" | grep "${IDENTITY}" || true
  exit 0
fi

command -v openssl >/dev/null || { echo "缺少 openssl"; exit 1; }

log "生成自签代码签名证书「${IDENTITY}」"
mkdir -p "$CERT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=${IDENTITY}/O=Snap Dev" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# macOS 的 security import 对 OpenSSL 3 默认的 AES-256 PKCS#12 支持不稳，
# 用 -legacy（RC2/3DES）更保险；不支持时再退回默认算法。
if ! openssl pkcs12 -export -legacy -out "$P12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
      -passout "pass:$P12_PASS" -name "${IDENTITY}" 2>/dev/null; then
  openssl pkcs12 -export -out "$P12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -passout "pass:$P12_PASS" -name "${IDENTITY}" 2>/dev/null
fi
chmod 600 "$P12"
echo "  · $P12"

log "导入钥匙串（并允许 codesign 使用私钥）"
security import "$P12" -k "$KEYCHAIN" -P "$P12_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
echo "  · 已导入；-T 已把私钥访问权授予 codesign，签名时不会再弹钥匙串确认"

# 信任设置默认不做：它会弹一次系统授权框（无人值守时会一直卡住），而签名稳定性
# 并不依赖它——自签身份的 designated requirement 锚定在证书哈希上
# （certificate root = H"…"），重新打包后身份不变，TCC 授权因此不会失效。
# 只有想让 `security find-identity -v` 也列出该身份时才需要。
if [ "${SNAP_CERT_TRUST:-0}" = "1" ]; then
  log "设置代码签名信任（会弹出系统授权框，请点「始终信任」）"
  if security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" >/dev/null 2>&1; then
    echo "  · 已信任（仅限代码签名）"
  else
    warn "未能写入信任设置；签名仍然可用"
  fi
else
  echo "  · 跳过信任设置（不影响签名稳定性；如需 find-identity -v 列出该身份：SNAP_CERT_TRUST=1 重跑）"
fi

log "结果"
security find-identity -p codesigning "$KEYCHAIN" | grep "${IDENTITY}" || true
echo
echo "之后 npm run bundle 会自动选用该身份；需要覆盖时用 SNAP_SIGN_IDENTITY=\"其他身份\"。"
