#!/bin/sh
# Installs one mod from this repository into a Herdr home. Never deletes your files.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
usage() { echo "usage: ./install.sh <mod> [--home DIR]   (mods: $(cd "$repo" && ls -d */mod 2>/dev/null | sed 's,/mod$,,' | tr '\n' ' '))" >&2; exit 2; }
fail() { echo "install.sh: $*" >&2; exit 1; }

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
case $name in ""|*[!a-z0-9-]*) usage ;; esac
src="$repo/$name"
[ -d "$src/mod" ] || fail "no mod named '$name' in $repo"

if [ -d "$src/helper" ]; then
  [ "$(uname -s)" = Darwin ] || fail "$name needs macOS."
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ] || fail "$name needs macOS 15 or later (this is $(sw_vers -productVersion))."
  xcrun --find swift >/dev/null 2>&1 || fail "Swift not found. Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
  xcrun simctl help >/dev/null 2>&1 || fail "xcrun simctl not found. Install Xcode (not only the Command Line Tools) and open it once."
  echo "Building the $name helper (the first build downloads its packages)..."
  xcrun swift build -c release --package-path "$src/helper" || fail "the helper build failed (see above)."
fi

# A Herdr build that ships this mod itself (the patched ios-sim fork) records it in installed.json:
# replacing it would swap that build's panel for the stock one, so only the helper is installed then.
shipped=no
grep -q "\"$name\": *{" "$home/installed.json" 2>/dev/null && shipped=yes
if [ $shipped = yes ]; then
  echo "Kept the mod: your Herdr ships its own $name mod (see $home/installed.json)."
else
  mkdir -p "$home/mods/$name"
  (cd "$src/mod" && find . -type f) | while read -r f; do
    if [ -e "$home/mods/$name/$f" ] && ! cmp -s "$src/mod/$f" "$home/mods/$name/$f"; then
      echo "Replaced $home/mods/$name/${f#./} (it differed from this version)."
    fi
  done
  cp -R "$src/mod/." "$home/mods/$name/"
  echo "Installed the mod: $home/mods/$name"
fi

# Extra mods that ship with this one (the browser's sign-in dialog and its tab bar): each goes in <home>/mods/<id>.
if [ -d "$src/mods" ] && [ $shipped = no ]; then
  for m in "$src/mods"/*/; do
    id=$(basename "$m")
    mkdir -p "$home/mods/$id"
    cp -R "$m." "$home/mods/$id/"
    echo "Installed the mod: $home/mods/$id"
  done
fi

# Helpers built by the mod's own script (no Swift package): ./install.sh browser
if [ -x "$src/install-helpers.sh" ]; then
  "$src/install-helpers.sh" "$home" || fail "the $name helpers failed to install (see above)."
fi

if [ -d "$src/helper" ]; then
  out="$src/helper/.build/release"
  mkdir -p "$home/bin"
  # The helper loads these stub frameworks from beside itself. A changed one goes in as a new folder,
  # renamed into place like the helper below: a running helper keeps the files it has open.
  for f in "$out"/*.framework; do
    [ -e "$f" ] || continue
    base=$(basename "$f") dest="$home/bin/$(basename "$f")"
    diff -rq "$f" "$dest" >/dev/null 2>&1 && continue
    rm -rf "$home/bin/.$base.new" "$home/bin/.$base.old"
    cp -R "$f" "$home/bin/.$base.new"
    if [ -e "$dest" ]; then mv "$dest" "$home/bin/.$base.old"; fi
    mv "$home/bin/.$base.new" "$dest"
  done
  # A new file, renamed into place: overwriting a running binary in place can get it killed (code signature).
  cp "$out/herdr-sim" "$home/bin/.herdr-sim.new"
  mv -f "$home/bin/.herdr-sim.new" "$home/bin/herdr-sim"
  echo "Installed the helper: $home/bin/herdr-sim"
fi

if [ -d "$src/layouts" ] && [ $shipped = no ]; then
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

echo "Done. Restart Herdr (or reload its mods), then see $name/README.md for how to open and use it."
