#!/bin/sh
# Builds and installs the browser mod's helpers into a Herdr home: herdr-web (the native WebKit view, needs
# swiftc) and herdr-browser (headless Chrome for Stream mode and agent tools, needs cargo and Chrome).
# Called by ../install.sh as: install-helpers.sh <home>. Each binary is renamed into place, so a running one
# keeps working.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=$1
mkdir -p "$home/bin"

xcrun --find swiftc >/dev/null 2>&1 || { echo "install-helpers: swiftc not found. Install Xcode or the Command Line Tools (xcode-select --install)." >&2; exit 1; }
echo "Building herdr-web (the native view)..."
log=$(mktemp)
if ! swiftc -O -o "$home/bin/.herdr-web.new" "$here/helpers/web/main.swift" -framework AppKit -framework WebKit -framework Network >"$log" 2>&1; then
  cat "$log" >&2
  rm -f "$log"
  echo "install-helpers: the herdr-web build failed (the compiler output is above)." >&2
  exit 1
fi
rm -f "$log"
mv -f "$home/bin/.herdr-web.new" "$home/bin/herdr-web"
echo "Installed the native view helper: $home/bin/herdr-web"

if command -v cargo >/dev/null 2>&1; then
  echo "Building herdr-browser (Stream mode and agent tools)..."
  cargo build --release --manifest-path "$here/helpers/chrome/Cargo.toml" || { echo "install-helpers: the herdr-browser build failed (Stream mode and agent tools are skipped; native mode still works)." >&2; exit 0; }
  cp "$here/helpers/chrome/target/release/herdr-browser" "$home/bin/.herdr-browser.new"
  mv -f "$home/bin/.herdr-browser.new" "$home/bin/herdr-browser"
  echo "Installed the Chrome helper: $home/bin/herdr-browser"
else
  echo "Skipped herdr-browser: cargo (Rust) is not installed. The native browser works without it. Stream mode, the agent tools and Sign-ins need it: install Rust from https://rustup.rs, then run ./install.sh browser again."
fi
