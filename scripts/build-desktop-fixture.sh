#!/bin/sh
set -eu

bundle_path="${1:-$PWD/.build/DevSpaceDesktopFixture.app}"
contents="$bundle_path/Contents"
executable="$contents/MacOS/DevSpaceDesktopFixture"
mkdir -p "$contents/MacOS"
xcrun swiftc -O -framework AppKit "$PWD/native/desktop-helper/fixture-app.swift" -o "$executable"
plist="$contents/Info.plist"
/usr/bin/plutil -create xml1 "$plist"
/usr/bin/plutil -insert CFBundleIdentifier -string com.devspace.desktop-fixture "$plist"
/usr/bin/plutil -insert CFBundleName -string DevSpaceDesktopFixture "$plist"
/usr/bin/plutil -insert CFBundleExecutable -string DevSpaceDesktopFixture "$plist"
/usr/bin/plutil -insert CFBundlePackageType -string APPL "$plist"
codesign --force --sign - --identifier com.devspace.desktop-fixture "$bundle_path"
echo "$bundle_path"
