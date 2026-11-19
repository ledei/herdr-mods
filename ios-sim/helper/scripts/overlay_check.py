"""Drives `herdr-sim overlay` against a stand-in host window (overlay_host.swift) and a booted simulator.
Usage: python3 -I overlay_check.py <herdr-sim> <overlay_host binary> <udid> [evidence dir]
Serves a test page, opens it in the simulator's Safari, and reads the touches it reports back.
Input reaches the panel only through the HERDR_SIM_TEST_INPUT hook (no real mouse or keyboard).
Prints PASS/FAIL lines; exit status = failures."""
import http.server, json, os, socket, subprocess, sys, tempfile, threading, time
from urllib.parse import parse_qs, urlparse

binary, hostbin, udid = sys.argv[1:4]
out = sys.argv[4] if len(sys.argv) > 4 else tempfile.mkdtemp()
os.makedirs(out, exist_ok=True)
fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""), flush=True)
    fails += 0 if ok else 1


def until(pred, timeout, step=0.02):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


# MARK: test page: reports touches and typed text back to us

PAGE = b"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;overflow:hidden;touch-action:none;font:20px -apple-system}
#b{position:fixed;left:40px;top:120px;width:220px;height:70px;font-size:22px}
#i{position:fixed;left:40px;top:220px;width:300px;height:44px;font-size:20px}</style>
<button id=b>Pick me</button><input id=i autocapitalize=off autocorrect=off spellcheck=false>
<script>
let n=0;function hit(q){fetch('/hit?n='+(n++)+'&'+q,{cache:'no-store'})}
for(const t of['touchstart','touchmove','touchend'])addEventListener(t,e=>{const p=e.changedTouches[0];hit('t='+t+'&x='+p.clientX+'&y='+p.clientY)},{passive:true})
document.getElementById('i').addEventListener('input',e=>hit('t=input&v='+encodeURIComponent(e.target.value)))
addEventListener('touchstart',e=>{if(e.target.id!=='i')document.activeElement.blur()})
</script>"""
hits = []


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE
        if self.path.startswith("/hit"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            hits.append(q)
            body = b""
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def touches(kind):
    return [h for h in sorted(hits, key=lambda h: int(h["n"])) if h.get("t") == kind]


# MARK: processes

host = subprocess.Popen([hostbin], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)


def hcmd(s):
    host.stdin.write(s + "\n")
    host.stdin.flush()
    return json.loads(host.stdout.readline())


hpid = json.loads(host.stdout.readline())["pid"]
hcmd("frame 100 120 700 800")

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
subprocess.run(["xcrun", "simctl", "openurl", udid, f"http://127.0.0.1:{srv.server_address[1]}/"], check=True)

tmp = tempfile.mkdtemp()
fifo, portfile = os.path.join(tmp, "input"), os.path.join(tmp, "port")
os.mkfifo(fifo)
helper = subprocess.Popen([binary, "overlay", "--herdr-pid", str(hpid), "--port-file", portfile],
                          env={**os.environ, "HERDR_SIM_TEST_INPUT": fifo}, stderr=open(os.path.join(out, "helper.log"), "w"))
# A second helper nobody connects to: it must leave after 10 s.
idle_file = os.path.join(tmp, "idle-port")
idle = subprocess.Popen([binary, "overlay", "--herdr-pid", str(hpid), "--port-file", idle_file], stderr=subprocess.DEVNULL)
idle_t0, idle_exit = time.time(), []
threading.Thread(target=lambda: (idle.wait(), idle_exit.append(time.time())), daemon=True).start()
print(f"pids: host {hpid} helper {helper.pid} idle-helper {idle.pid}", flush=True)

until(lambda: os.path.exists(portfile), 5)
port_s, token = open(portfile).read().split()
port = int(port_s)
check("port-file-0600", (os.stat(portfile).st_mode & 0o777) == 0o600)
feed = open(fifo, "w")  # the helper has the read end open by now


def inject(*lines, gap=0.0):
    """`gap` spaces the events like a real pointer: iOS samples touches once a frame, so a burst lands as one."""
    for l in lines:
        feed.write(l + "\n")
        feed.flush()
        time.sleep(gap)


class Conn:
    def __init__(self, hello=True):
        self.s = socket.create_connection(("127.0.0.1", port))
        self.events, self.closed = [], False
        threading.Thread(target=self.read, daemon=True).start()
        if hello:
            self.send({"op": "hello", "token": token})

    def read(self):
        buf = b""
        while True:
            d = self.s.recv(65536)
            if not d:
                self.closed = True
                return
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                self.events.append((time.time(), json.loads(line)))

    def send(self, obj):
        self.s.sendall((json.dumps(obj) + "\n").encode())

    def wait(self, ev, timeout=5, after=0.0, pred=lambda e: True):
        r = until(lambda: next((e for t, e in self.events if t >= after and e.get("ev") == ev and pred(e)), None), timeout)
        return r


# MARK: hello

bad = Conn(hello=False)
bad.send({"op": "listDevices"})
check("rejects-missing-hello", until(lambda: bad.closed, 2) and not bad.events)
bad = Conn(hello=False)
bad.send({"op": "hello", "token": "nope"})
check("rejects-wrong-token", until(lambda: bad.closed, 2) and not bad.events)

c = Conn()
c.send({"op": "listDevices"})
e = c.wait("devices", 10)
check("listDevices", e and any(d["udid"] == udid and d["state"] == "Booted" for d in e["devices"]))

t = time.time()
c.send({"op": "attach", "udid": udid})
att = c.wait("attached", 15)
rot = c.wait("rotation", 2, after=t)
check("attach", att and att["udid"] == udid and att["width"] > 0 and att["scale"] > 0 and rot and rot["value"] == "upright", f"{att} {rot}")
dev_w, dev_h = att["width"], att["height"]

# MARK: placement

seq = 0


def next_seq():
    global seq
    seq = max(seq + 1, int(time.time() * 1000 * 100))
    return seq


W, TOP = 300, 100
leasing = threading.Event()


def lease_loop():
    while True:
        if leasing.is_set():
            c.send({"op": "lease", "tag": "a"})
        time.sleep(0.25)


threading.Thread(target=lease_loop, daemon=True).start()


def edges(tag="a", w=W, s=None):
    c.send({"op": "edges", "tag": tag, "seq": s or next_seq(), "left": [1, -w], "top": [0, TOP], "right": [1, 0], "bottom": [1, 0], "radius": 16})


def where():
    return hcmd(f"where {helper.pid}")


def panel():
    w = where()
    return (w["windows"][0] if w["windows"] else None), w


def expected(w, width=W):
    hx, hy, hw, hh = w["host"]
    return [hx + hw - width, hy + TOP, width, hh - TOP]


def near(a, b, tol=0.5):
    return a is not None and all(abs(x - y) <= tol for x, y in zip(a, b))


edges()
leasing.set()
p, w = until(lambda: (lambda pw: pw if pw[0] else None)(panel()), 2) or (None, where())
check("edges-place-panel", p and near(p["bounds"], expected(w)), f"panel {p and p['bounds']} want {expected(w)}")
check("panel-directly-above-host", p and w["above"] == p["id"], f"above {w['above']} panel {p and p['id']}")
hcmd("frame 160 150 650 760")
time.sleep(0.3)
p, w = panel()
check("panel-follows-host-move-resize", p and near(p["bounds"], expected(w)), f"panel {p and p['bounds']} want {expected(w)}")
stale = seq - 1
c.send({"op": "edges", "tag": "a", "seq": stale, "left": [1, -200], "top": [0, TOP], "right": [1, 0], "bottom": [1, 0], "radius": 16})
time.sleep(0.3)
p, w = panel()
check("stale-seq-dropped", p and near(p["bounds"], expected(w)), f"panel {p and p['bounds']}")
PW, PH = p["bounds"][2], p["bounds"][3]


def to_panel(x, y, turned=False):
    """Device on-screen points to panel points (top-left), as the panel fits the screen."""
    sw, sh = (dev_h, dev_w) if turned else (dev_w, dev_h)
    k = min(PW / sw, PH / sh)
    return (PW - sw * k) / 2 + x * k, (PH - sh * k) / 2 + y * k, k


# MARK: input

time.sleep(1.5)  # the page has loaded by now
hits.clear()
px, py, k = to_panel(196, 500)
inject(f"down {px:.2f} {py:.2f}", f"up {px:.2f} {py:.2f}")
until(lambda: touches("touchend"), 4)
s, e = touches("touchstart"), touches("touchend")
check("tap-reaches-device", s and e and abs(float(s[0]["x"]) - 196) <= 2, f"start {s[:1]} end {e[:1]}")
offset = 500 - float(s[0]["y"]) if s else 0  # device y minus page y (status and toolbar)
time.sleep(0.6)  # not a double tap
hits.clear()
px, py, _ = to_panel(100, 600)
inject(f"down {px:.2f} {py:.2f}", f"up {px:.2f} {py:.2f}")
until(lambda: touches("touchend"), 4)
s = touches("touchstart")
check("tap-coordinates", s and abs(float(s[0]["x"]) - 100) <= 2 and abs(float(s[0]["y"]) + offset - 600) <= 2, f"{s[:1]} offset {offset}")

time.sleep(0.6)  # not a double tap
hits.clear()
a, b = to_panel(100, 500), to_panel(250, 520)
inject(f"down {a[0]:.2f} {a[1]:.2f}", *[f"drag {a[0] + (b[0] - a[0]) * i / 6:.2f} {a[1] + (b[1] - a[1]) * i / 6:.2f}" for i in range(1, 7)], f"up {b[0]:.2f} {b[1]:.2f}", gap=0.03)
until(lambda: touches("touchend"), 4)
m, e = touches("touchmove"), touches("touchend")
check("drag-moves-finger", m and e and abs(float(e[0]["x"]) - 250) <= 2 and abs(float(e[0]["y"]) + offset - 520) <= 2, f"{len(m)} moves, end {e[:1]}")

hits.clear()
px, py, k = to_panel(196, 500)
inject(f"scroll {px:.2f} {py:.2f} 0 0 began", *[f"scroll {px:.2f} {py:.2f} 0 -30 changed" for _ in range(5)], f"scroll {px:.2f} {py:.2f} 0 0 ended", gap=0.03)
until(lambda: touches("touchend"), 4)
s, e = touches("touchstart"), touches("touchend")
moved = (float(e[0]["y"]) - float(s[0]["y"])) if s and e else None
check("trackpad-scroll-is-one-finger", s and e and len(s) == 1 and moved is not None and abs(moved - (-150 / k)) <= 3,
      f"moved {moved} want {-150 / k:.1f}")

hits.clear()
ix, iy, _ = to_panel(190, 242 + offset)
inject(f"down {ix:.2f} {iy:.2f}", f"up {ix:.2f} {iy:.2f}")
time.sleep(1.5)
c.send({"op": "text", "text": "ok42"})
got = until(lambda: [h for h in touches("input") if h.get("v") == "ok42"], 5)
c.send({"op": "key", "code": 42, "down": True})  # backspace
c.send({"op": "key", "code": 42, "down": False})
got2 = until(lambda: [h for h in touches("input") if h.get("v") == "ok4"], 5)
check("text-and-key", got and got2, f"inputs {[h.get('v') for h in touches('input')]}")
time.sleep(0.6)
bx, by, _ = to_panel(196, 100 + offset)  # page body above the input: the page blurs it, the keyboard goes
inject(f"down {bx:.2f} {by:.2f}", f"up {bx:.2f} {by:.2f}")
time.sleep(1)

# MARK: annotate

# Web content is not in the accessibility tree: aim at Safari's address field, found the way describe sees it.
def find(e, ident):
    if e.get("identifier") == ident:
        return e
    return next((r for c in e.get("children") or [] for r in [find(c, ident)] if r), None)


tree = json.loads(subprocess.run([binary, "describe", "--device", udid], capture_output=True, text=True).stdout)
field = next((r for e in tree["elements"] for r in [find(e, "TabBarItemTitle")] if r), None)
f = field["frame"] if field else {"x": 150, "y": 800, "width": 1, "height": 1}
c.send({"op": "annotate", "on": True})
hits.clear()
bx, by, _ = to_panel(f["x"] + f["width"] / 2, f["y"] + f["height"] / 2)
t = time.time()
inject(f"move {bx:.2f} {by:.2f}")
time.sleep(1.5)  # hover asks once the pointer rests
inject(f"down {bx:.2f} {by:.2f}", f"up {bx:.2f} {by:.2f}")
pk = c.wait("pick", 10, after=t)
img = pk and pk.get("imagePath")
check("annotate-pick", pk and len(pk["frame"]) == 4 and img and os.path.getsize(img) > 0 and open(img, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
      and oct(os.stat(os.path.dirname(img)).st_mode & 0o777) == "0o700" and not touches("touchstart")
      and near(pk["frame"], [f["x"], f["y"], f["width"], f["height"]], 1), f"{pk} want {f}")
pid_panel = panel()[0]["id"]
subprocess.run(["screencapture", "-x", "-o", "-l", str(pid_panel), os.path.join(out, "annotate.png")])
c.send({"op": "annotate", "on": False})

# MARK: rotate

t = time.time()
c.send({"op": "rotate", "dir": "right"})
r = c.wait("rotation", 12, after=t)
check("rotate-right", r and r["value"] == "clockwise", f"{r}")
time.sleep(1)
shot, dev = os.path.join(out, "panel-landscape.png"), os.path.join(out, "device-landscape.png")
subprocess.run(["screencapture", "-x", "-o", "-l", str(pid_panel), shot])
subprocess.run([binary, "screenshot", "--device", udid, dev], stdout=subprocess.DEVNULL)
if os.path.exists(shot) and os.path.getsize(shot) > 0:
    scale = float(subprocess.run(["sips", "-g", "pixelWidth", shot], capture_output=True, text=True).stdout.split()[-1]) / PW
    x0, y0, k = to_panel(0, 0, turned=True)
    # The device screenshot is the raw portrait surface with the content turned inside; turned clockwise once it is upright.
    d = hcmd(f"diff {shot} {dev} 1 {x0 * scale:.0f} {y0 * scale:.0f} {dev_h * k * scale:.0f} {dev_w * k * scale:.0f}")
    check("rotated-content-upright", "same" in d and d["same"] < 0.5 * d["turned"], f"{d}")
else:
    check("rotated-content-upright", False, "screencapture gave no image (Screen Recording permission?)")
t = time.time()
c.send({"op": "rotate", "dir": "left"})
r = c.wait("rotation", 12, after=t)
check("rotate-left-back-upright", r and r["value"] == "upright", f"{r}")

# MARK: visibility

leasing.clear()
t = time.time()
gone = until(lambda: panel()[0] is None, 2, 0.01)
dt = time.time() - t
check("lease-expiry-hides", gone and 0.3 <= dt <= 1.0, f"hidden after {dt * 1000:.0f} ms (last lease <= 250 ms before)")
edges()
leasing.set()
check("edges-show-again", until(lambda: panel()[0] is not None, 1))
c.send({"op": "hide", "tag": "a"})
t = time.time()
gone = until(lambda: panel()[0] is None, 1, 0.005)
check("hide-is-immediate", gone and time.time() - t < 0.15, f"{(time.time() - t) * 1000:.0f} ms")
edges()
until(lambda: panel()[0] is not None, 1)
hcmd("hide")
check("host-hidden-hides-panel", until(lambda: panel()[0] is None, 1))
hcmd("show")
p, w = until(lambda: (lambda pw: pw if pw[0] else None)(panel()), 1) or (None, where())
check("host-shown-again", p and near(p["bounds"], expected(w)) and w["above"] == p["id"])
leasing.clear()
c.send({"op": "hide", "tag": "a"})

# MARK: lifetime

pings = [t for t, e in c.events if e.get("ev") == "ping"]
gaps = [b - a for a, b in zip(pings, pings[1:])]
check("ping-every-5s", len(pings) >= 2 and all(4.5 <= g <= 5.5 for g in gaps), f"{len(pings)} pings, gaps {[round(g, 2) for g in gaps]}")

q_file = os.path.join(tmp, "q-port")
q = subprocess.Popen([binary, "overlay", "--herdr-pid", str(hpid), "--port-file", q_file], stderr=subprocess.DEVNULL)
until(lambda: os.path.exists(q_file), 5)
qs = socket.create_connection(("127.0.0.1", int(open(q_file).read().split()[0])))
qs.sendall((json.dumps({"op": "hello", "token": open(q_file).read().split()[1]}) + "\n" + json.dumps({"op": "quit"}) + "\n").encode())
try:
    q.wait(3)
except subprocess.TimeoutExpired:
    q.kill()
check("quit-exits", q.returncode == 0)

until(lambda: idle_exit, max(0, 14 - (time.time() - idle_t0)), 0.1)
idle_dt = (idle_exit[0] if idle_exit else time.time()) - idle_t0
check("exits-after-10s-without-client", idle.returncode == 0 and 10 <= idle_dt <= 13, f"{idle_dt:.1f} s")

host.stdin.write("quit\n")
host.stdin.flush()
t = time.time()
host.wait(3)
try:
    helper.wait(3)
except subprocess.TimeoutExpired:
    helper.kill()
check("exits-when-herdr-dies", helper.returncode == 0, f"after {time.time() - t:.2f} s")

srv.shutdown()
print("helper errors:", [e["message"] for t, e in c.events if e.get("ev") == "error"])
print(f"evidence in {out}")
sys.exit(fails)
