#!/bin/sh
# Installs one mod from this repository into a Herdr home. Never deletes anything.
set -eu

usage() { echo "usage: ./install.sh <mod> [--home DIR]   (mods: $(ls -d */ 2>/dev/null | tr -d / | tr '\n' ' '))" >&2; exit 2; }
fail() { echo "install.sh: $*" >&2; exit 1; }

repo=$(cd "$(dirname "$0")" && pwd)
name=""
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
while [ $# -gt 0 ]; do
  case "$1" in
    --home) [ $# -ge 2 ] || usage; home=$2; shift 2 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$name" ] || usage; name=$1; shift ;;
  esac
done
[ -n "$name" ] || usage
src="$repo/$name"
[ -d "$src/mod" ] || fail "no mod named '$name' in $repo"

if [ -d "$src/helper" ]; then
  [ "$(uname -s)" = Darwin ] || fail "$name needs macOS."
  xcrun --find swift >/dev/null 2>&1 || fail "Swift not found. Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
  xcrun simctl help >/dev/null 2>&1 || fail "xcrun simctl not found. Install Xcode (not only the Command Line Tools) and open it once."
  echo "Building the $name helper (the first build downloads its packages)..."
  xcrun swift build -c release --package-path "$src/helper" || fail "the helper build failed (see above)."
fi

mkdir -p "$home/mods/$name"
cp -R "$src/mod/." "$home/mods/$name/"
echo "Installed the mod: $home/mods/$name"

if [ -d "$src/helper" ]; then
  out="$src/helper/.build/release"
  mkdir -p "$home/bin"
  # The helper loads these stub frameworks from beside itself.
  for f in "$out"/*.framework; do
    [ -e "$f" ] || continue
    cp -R "$f" "$home/bin/"
  done
  cp "$out/herdr-sim" "$home/bin/herdr-sim"
  echo "Installed the helper: $home/bin/herdr-sim"
fi

if [ -d "$src/layouts" ]; then
  mkdir -p "$home/layouts"
  for f in "$src/layouts"/*.json; do
    [ -e "$f" ] || continue
    dest="$home/layouts/$(basename "$f")"
    if [ -e "$dest" ]; then
      echo "Skipped the layout $dest: it already exists (yours is kept)."
    else
      cp "$f" "$dest"
      echo "Installed the layout: $dest"
    fi
  done
fi

echo "Done. See $name/README.md for how to use it."
