#!/usr/bin/env bash
# Smoke test: creates its own simulator, runs every herdr-sim command against it (always with --device), deletes it on exit.
# Env: HERDR_T1_RUNTIME (default iOS-26-4), HERDR_T1_OUT (artifact dir, default a mktemp dir).
set -u
cd "$(dirname "$0")/.."
RUNTIME="com.apple.CoreSimulator.SimRuntime.${HERDR_T1_RUNTIME:-iOS-26-4}"
OUT="${HERDR_T1_OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
swift build 2>&1 | grep -E "error|Build complete" ; B="$PWD/.build/debug/herdr-sim"
[ -x "$B" ] || { echo "build failed"; exit 1; }
UDID=""
cleanup() { if [ -n "$UDID" ]; then xcrun simctl shutdown "$UDID" >/dev/null 2>&1; xcrun simctl delete "$UDID" >/dev/null 2>&1 && echo "deleted $UDID"; fi; }
trap cleanup EXIT
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails+1)); }
check() { local name=$1; shift; if "$@" >"$OUT/$name.log" 2>&1; then ok "$name"; else bad "$name (see $OUT/$name.log)"; fi; }
differs() { ! cmp -s "$1" "$2"; }
center() { python3 -I -c '
import json,sys
for e in json.load(sys.stdin)["elements"]:
    if e.get("identifier")==sys.argv[1]:
        f=e["frame"]; print(f["x"]+f["width"]/2, f["y"]+f["height"]/2); break
else: sys.exit(1)' "$1"; }

UDID=$(xcrun simctl create herdr-t1 "iPhone 16" "$RUNTIME") || { echo "cannot create simulator on $RUNTIME"; exit 1; }
echo "device herdr-t1 $UDID on $RUNTIME, artifacts in $OUT"
D=(--device "$UDID")

check boot "$B" boot "$UDID"
"$B" list | grep -q "$UDID.*Booted" && ok list || bad list
"$B" list --json | python3 -I -c 'import json,sys; d=json.load(sys.stdin); assert any(x["state"]=="Booted" and x["udid"] for x in d)' && ok list-json || bad list-json
"$B" screenshot "${D[@]}" "$OUT/00.png" | grep -q "393x852 points" && ok screenshot || bad screenshot
"$B" screenshot --json "${D[@]}" "$OUT/00j.png" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)["pointWidth"]==393' && ok screenshot-json || bad screenshot-json

python3 -I scripts/serve_check.py "$B" "$UDID" || fails=$((fails+$?))

check launch "$B" launch "${D[@]}" com.apple.Preferences
sleep 2
"$B" screenshot "${D[@]}" "$OUT/01-settings.png" >/dev/null
differs "$OUT/00.png" "$OUT/01-settings.png" && ok "screenshot-changes-after-launch" || bad "screenshot-changes-after-launch"

"$B" describe "${D[@]}" > "$OUT/describe.json" && python3 -I -c 'import json; json.load(open("'"$OUT/describe.json"'"))' && ok describe || bad describe
XY=$(center com.apple.settings.general < "$OUT/describe.json") || { bad "find General row"; XY="196 421"; }
"$B" describe "${D[@]}" --point ${XY} | grep -q "settings.general" && ok describe-point || bad describe-point
check tap "$B" tap "${D[@]}" $XY
sleep 2.5; "$B" screenshot "${D[@]}" "$OUT/02-general.png" >/dev/null
differs "$OUT/01-settings.png" "$OUT/02-general.png" && ok "tap-opens-general" || bad "tap-opens-general"

check swipe "$B" swipe "${D[@]}" 2 400 300 400 --duration 0.3
sleep 2; "$B" screenshot "${D[@]}" "$OUT/03-back.png" >/dev/null
differs "$OUT/02-general.png" "$OUT/03-back.png" && ok "swipe-goes-back" || bad "swipe-goes-back"

"$B" describe "${D[@]}" > "$OUT/describe2.json"
XY=$(center com.apple.settings.search < "$OUT/describe2.json") || { bad "find search"; XY="196 785"; }
"$B" tap "${D[@]}" $XY >/dev/null; sleep 1.5
check type "$B" type "${D[@]}" 'Hello, World! 123'
sleep 1; "$B" screenshot "${D[@]}" "$OUT/04-typed.png" >/dev/null
differs "$OUT/03-back.png" "$OUT/04-typed.png" && ok "type-changes-screen" || bad "type-changes-screen"
"$B" describe "${D[@]}" | grep -q "Hello, World! 123" && ok "typed-text-in-describe" || bad "typed-text-in-describe"
"$B" type "${D[@]}" 'caf'$'\xc3\xa9' 2>"$OUT/unsupported.err" && bad "type-unsupported-exit" || { grep -q "unsupported" "$OUT/unsupported.err" && ok "type-unsupported-error" || bad "type-unsupported-error"; }

check button-home "$B" button "${D[@]}" home
sleep 1; "$B" screenshot "${D[@]}" "$OUT/05-home.png" >/dev/null
differs "$OUT/04-typed.png" "$OUT/05-home.png" && ok "home-changes-screen" || bad "home-changes-screen"
check launch-again "$B" launch "${D[@]}" com.apple.Preferences
sleep 1.5; "$B" screenshot "${D[@]}" "$OUT/06-relaunch.png" >/dev/null
differs "$OUT/05-home.png" "$OUT/06-relaunch.png" && ok "launch-changes-screen" || bad "launch-changes-screen"
check open-url "$B" open-url "${D[@]}" "https://example.com"

"$B" tap --device 00000000-0000-0000-0000-000000000000 1 1 2>/dev/null && bad "bad-device-exit" || ok "bad-device-exit"
"$B" tap "${D[@]}" x y 2>/dev/null && bad "bad-args-exit" || ok "bad-args-exit"
check shutdown "$B" shutdown "$UDID"

echo; [ $fails -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit $fails
