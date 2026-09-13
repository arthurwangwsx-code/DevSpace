#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "DevSpace desktop host is supported only on macOS." >&2
  exit 1
fi

bundle_path="${1:-$PWD/.build/DevSpaceDesktopHost.app}"
bundle_id="com.devspace.desktop-host"
executable="$bundle_path/Contents/MacOS/devspace-desktop-helper"
identity="${DEVSPACE_DESKTOP_SIGNING_IDENTITY:--}"

if [ -e "$bundle_path" ]; then
  echo "Desktop host output already exists: $bundle_path" >&2
  echo "Choose an empty output path or remove the generated artifact explicitly." >&2
  exit 1
fi

mkdir -p "$bundle_path/Contents/MacOS"
cp "$PWD/native/desktop-host/Info.plist" "$bundle_path/Contents/Info.plist"
xcrun swiftc \
  -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework ScreenCaptureKit \
  "$PWD/native/desktop-helper/main.swift" \
  -o "$executable"
chmod 0755 "$executable"
if [ "$identity" = "-" ]; then
  codesign --force --sign "$identity" --identifier "$bundle_id" --timestamp=none "$bundle_path"
else
  codesign --force --sign "$identity" --identifier "$bundle_id" --options runtime --timestamp "$bundle_path"
fi
codesign --verify --deep --strict "$bundle_path"
plutil -lint "$bundle_path/Contents/Info.plist" >/dev/null
echo "$executable"
