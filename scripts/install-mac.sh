#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Website Element Scraper.app"
REPO="francoma-cmd/website-element-scraper"

usage() {
  cat <<'EOF'
Install Website Element Scraper on macOS from a GitHub Release DMG.

Usage:
  install-mac.sh --tag v1.0.1-beta.3 [--user]

Options:
  --tag <tag>   Git tag to install from (required). Example: v1.0.1-beta.3
  --user        Install into ~/Applications instead of /Applications (no sudo).
  --help        Show help.

Notes:
  - This app is not notarized. Installing via curl typically avoids Finder quarantine.
  - Script still clears com.apple.quarantine on the installed app as a safety net.
EOF
}

TAG=""
INSTALL_USER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"; shift 2
      ;;
    --user)
      INSTALL_USER=1; shift 1
      ;;
    --help|-h)
      usage; exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "--tag is required" >&2
  usage
  exit 2
fi

if [[ "$INSTALL_USER" -eq 1 ]]; then
  DEST_DIR="$HOME/Applications"
else
  DEST_DIR="/Applications"
fi

DMG_NAME="Website.Element.Scraper-${TAG#v}-arm64.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/${TAG}/${DMG_NAME}"

TMP_DIR="$(mktemp -d "/tmp/wes-install.XXXXXX")"
cleanup() {
  if [[ -n "${MOUNT_DIR:-}" && -d "${MOUNT_DIR:-}" ]]; then
    hdiutil detach "${MOUNT_DIR}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Downloading: ${DMG_URL}"
curl -fL --retry 3 --retry-delay 1 -o "${TMP_DIR}/${DMG_NAME}" "${DMG_URL}"

MOUNT_DIR="${TMP_DIR}/mnt"
mkdir -p "${MOUNT_DIR}"
hdiutil attach -nobrowse -mountpoint "${MOUNT_DIR}" "${TMP_DIR}/${DMG_NAME}" >/dev/null

SRC_APP="${MOUNT_DIR}/${APP_NAME}"
if [[ ! -d "${SRC_APP}" ]]; then
  echo "Expected app not found in DMG: ${SRC_APP}" >&2
  ls -la "${MOUNT_DIR}" >&2 || true
  exit 1
fi

mkdir -p "${DEST_DIR}"
DEST_APP="${DEST_DIR}/${APP_NAME}"

echo "Installing to: ${DEST_APP}"

if [[ "$DEST_DIR" == "/Applications" ]]; then
  if [[ -w "/Applications" ]]; then
    ditto "${SRC_APP}" "${DEST_APP}"
  else
    echo "Requesting admin privileges to write to /Applications..."
    sudo -v
    sudo ditto "${SRC_APP}" "${DEST_APP}"
    sudo chown -R "$(id -u):$(id -g)" "${DEST_APP}" >/dev/null 2>&1 || true
  fi
else
  ditto "${SRC_APP}" "${DEST_APP}"
fi

# Safety net: clear quarantine on the installed app bundle.
xattr -dr com.apple.quarantine "${DEST_APP}" >/dev/null 2>&1 || true

echo "Done."
echo "Launch with: open -a \"${DEST_APP}\""

