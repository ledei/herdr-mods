"""Drives `herdr-sim serve` over its stdin/stdout protocol (no Mach service: attach must fail cleanly).
Usage: python3 -I serve_check.py <herdr-sim binary> <udid>. Prints PASS/FAIL lines; exit status = failures."""
import json, struct, subprocess, sys, time

binary, udid = sys.argv[1], sys.argv[2]
p = subprocess.Popen([binary, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
fails = 0


def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


def send(obj):
    body = b"J" + json.dumps(obj).encode()
    p.stdin.write(struct.pack("<I", len(body)) + body)
    p.stdin.flush()


def recv():
    n = struct.unpack("<I", p.stdout.read(4))[0]
    f = p.stdout.read(n)
    return f[:1], json.loads(f[1:])


def call(i, obj):
    send({"id": i, **obj})
    while True:
        tag, r = recv()
        if tag == b"J" and r.get("id") == i:
            return r


r = call(1, {"op": "listDevices"})
check("serve-listDevices", r["ok"] and any(d["udid"] == udid and d["state"] == "Booted" for d in r["result"]))
r = call(2, {"op": "tap", "udid": udid, "x": 1, "y": 1})
check("serve-tap", r["ok"])
r = call(3, {"op": "touch", "udid": udid, "phase": "down", "x": 5, "y": 5})
r2 = call(4, {"op": "touch", "udid": udid, "phase": "up", "x": 5, "y": 5})
check("serve-touch", r["ok"] and r2["ok"])
r = call(5, {"op": "attach", "udid": udid, "stream": 1})
check("serve-attach-without-service-errors", not r["ok"] and "service" in r["error"])
r = call(6, {"op": "nope", "udid": udid})
check("serve-unknown-op-errors", not r["ok"] and "unknown op" in r["error"])
r = call(7, {"op": "tap", "udid": udid})
check("serve-missing-arg-errors", not r["ok"] and "'x'" in r["error"])
r = call(8, {"op": "rotate", "udid": udid, "orientation": "landscapeLeft"})
r2 = call(9, {"op": "rotate", "udid": udid, "orientation": "portrait"})
# The display only turns when the front app supports landscape (Settings does not), so accept any rotation.
rots = {"upright", "clockwise", "upsideDown", "counterclockwise"}
check("serve-rotate", r["ok"] and r["result"]["rotation"] in rots and r2["ok"] and r2["result"]["rotation"] == "upright")
r = call(10, {"op": "rotate", "udid": udid, "orientation": "sideways"})
check("serve-rotate-bad-orientation-errors", not r["ok"] and "sideways" in r["error"])
import os, tempfile
img = os.path.join(tempfile.mkdtemp(), "pick.png")
r = call(11, {"op": "elementAt", "udid": udid, "x": 150, "y": 420, "imagePath": img})
import shutil; shutil.copy(img, sys.argv[3]) if len(sys.argv) > 3 else None
check("serve-elementAt", r["ok"] and r["result"]["type"] != "Application" and r["result"]["frame"]["width"] < 393 and os.path.getsize(img) > 0)
print("  ", r.get("result") or r.get("error"))
p.stdin.close()
t = time.time()
while p.poll() is None and time.time() - t < 5:
    time.sleep(0.05)
check("serve-exits-on-stdin-close", p.poll() == 0)
if p.poll() is None:
    p.kill()
sys.exit(fails)
