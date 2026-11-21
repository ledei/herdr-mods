#!/bin/sh
# Installs Atelier's non-mod parts into a Herdr home: the atelier-web helper (a native WebKit view, needs swiftc) in
# <home>/bin, and in <home>/atelier the server (atelierd, started by the mod), the canvas UI, the MCP tool list and the
# board runtime. Called by ../install.sh as: install-helpers.sh <home>. Each part is replaced by rename, so a running
# helper or server keeps the files it has open.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=$1
lib=$home/atelier
mkdir -p "$home/bin" "$lib/bin" "$lib/vendor/runtime"

command -v node >/dev/null 2>&1 || { echo "install-helpers: node not found. Atelier's server needs Node 22 or later." >&2; exit 1; }
xcrun --find swiftc >/dev/null 2>&1 || { echo "install-helpers: swiftc not found. Install Xcode or the Command Line Tools (xcode-select --install)." >&2; exit 1; }
echo "Building atelier-web (the native canvas view)..."
log=$(mktemp)
if ! xcrun swiftc -swift-version 5 -O "$here/helpers/web/main.swift" -o "$home/bin/.atelier-web.new" >"$log" 2>&1; then
  cat "$log" >&2; rm -f "$log"
  echo "install-helpers: the atelier-web build failed (the compiler output is above)." >&2
  exit 1
fi
rm -f "$log"
mv -f "$home/bin/.atelier-web.new" "$home/bin/atelier-web"
echo "Installed the canvas view helper: $home/bin/atelier-web"

put() { rm -rf "$2.new" && cp -R "$1" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"; }
put "$here/server" "$lib/server"
put "$here/shell" "$lib/shell"
put "$here/bin/tools" "$lib/bin/tools"
cp "$here/bin/atelier-mcp.mjs" "$lib/bin/atelier-mcp.mjs"
echo "Installed the server and canvas UI: $lib"

# The board runtime is Claude Design's dc-runtime.js. It is not ours to ship: bring your own copy.
runtime=${ATELIER_RUNTIME:-$here/vendor/runtime/support.js}
if [ -f "$runtime" ]; then
  cp "$runtime" "$lib/vendor/runtime/support.js"
  echo "Installed the board runtime: $lib/vendor/runtime/support.js"
elif [ -f "$lib/vendor/runtime/support.js" ]; then
  echo "Kept the board runtime you installed before: $lib/vendor/runtime/support.js"
else
  echo "No board runtime yet: boards will not render until you add one. Run again with ATELIER_RUNTIME=/path/to/dc-runtime.js ./install.sh atelier (see atelier/README.md)."
fi
