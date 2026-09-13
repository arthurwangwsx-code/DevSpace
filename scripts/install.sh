#!/bin/sh
set -eu

REPOSITORY="${DEVSPACE_REPOSITORY:-arthurwangwsx-code/DevSpace}"
INSTALL_DIR="${DEVSPACE_INSTALL_DIR:-$HOME/Applications}"
LATEST_URL="https://github.com/$REPOSITORY/releases/latest"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "DevSpace App installer currently supports macOS only." >&2; exit 2 ;;
esac

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 2 ;;
esac

TAG="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$LATEST_URL")"
TAG="${TAG##*/}"
VERSION="${TAG#v}"
ASSET="DevSpace-macOS-${ARCH}-${TAG}.zip"
BASE="https://github.com/$REPOSITORY/releases/download/$TAG"
TMP="$(mktemp -d -t devspace-install)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

echo "Installing DevSpace $VERSION ($ARCH)..."
curl -fL --retry 3 -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fL --retry 3 -o "$TMP/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"
EXPECTED="$(awk -v name="$ASSET" '$2 == name { print $1 }' "$TMP/SHA256SUMS.txt")"
[ -n "$EXPECTED" ] || { echo "Checksum entry missing for $ASSET" >&2; exit 1; }
ACTUAL="$(/usr/bin/shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "Checksum verification failed." >&2; exit 1; }

mkdir -p "$TMP/extracted" "$INSTALL_DIR"
/usr/bin/ditto -x -k "$TMP/$ASSET" "$TMP/extracted"
SOURCE="$TMP/extracted/DevSpace.app"
[ -x "$SOURCE/Contents/Resources/runtime/node" ] || { echo "Downloaded DevSpace.app is incomplete." >&2; exit 1; }

set -- install --source "$SOURCE" --target "$INSTALL_DIR/DevSpace.app"
if [ "${DEVSPACE_NO_OPEN:-0}" != "1" ]; then
  set -- "$@" --launch
fi
"$SOURCE/Contents/Resources/runtime/node" \
  "$SOURCE/Contents/Resources/devspace/dist/cli.js" "$@"

echo "DevSpace installed at $INSTALL_DIR/DevSpace.app"
