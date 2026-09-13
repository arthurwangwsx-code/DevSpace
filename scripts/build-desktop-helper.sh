#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "DevSpace desktop helper is supported only on macOS." >&2
  exit 1
fi

output_path="${1:-$PWD/.build/devspace-desktop-helper}"
mkdir -p "$(dirname "$output_path")"
xcrun swiftc \
  -O \
  -framework AppKit \
  -framework ApplicationServices \
  "$PWD/native/desktop-helper/main.swift" \
  -o "$output_path"
chmod 0755 "$output_path"
codesign --force --sign - --identifier com.devspace.desktop-helper "$output_path"
echo "$output_path"
