#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "DevSpace desktop host is supported only on macOS." >&2
  exit 1
fi

source_bundle="${1:-$PWD/.build/DevSpaceDesktopHost.app}"
target_bundle="${2:-$HOME/Applications/DevSpaceDesktopHost.app}"
target_parent="$(dirname "$target_bundle")"
staging_bundle="$target_parent/.DevSpaceDesktopHost.app.installing.$$"
backup_root="$target_parent/.DevSpaceDesktopHost.backups"

if [ ! -d "$source_bundle" ]; then
  echo "Desktop host bundle does not exist: $source_bundle" >&2
  exit 1
fi
codesign --verify --deep --strict "$source_bundle"
mkdir -p "$target_parent"
if [ -e "$staging_bundle" ]; then
  echo "Desktop host staging path already exists: $staging_bundle" >&2
  exit 1
fi
ditto "$source_bundle" "$staging_bundle"
codesign --verify --deep --strict "$staging_bundle"
if [ -e "$target_bundle" ]; then
  mkdir -p "$backup_root"
  backup_bundle="$backup_root/DevSpaceDesktopHost-$(date -u +%Y%m%dT%H%M%SZ).app"
  if [ -e "$backup_bundle" ]; then
    echo "Desktop host backup path already exists: $backup_bundle" >&2
    exit 1
  fi
  mv "$target_bundle" "$backup_bundle"
  echo "Previous desktop host moved to $backup_bundle" >&2
fi
mv "$staging_bundle" "$target_bundle"
echo "$target_bundle/Contents/MacOS/devspace-desktop-helper"
