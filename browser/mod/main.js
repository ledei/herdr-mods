// A browser pane. The herdr-browser helper (bin/herdr-browser, source in
// tools/herdr-browser) runs headless Chrome and owns every CDP detail; this
// panel only draws the JPEG frames it writes and sends input back over a local
// WebSocket as small JSON messages (the protocol is in the helper's source).

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, appHome, checking, notify, nextCommand, theme, spaces, panes, shared, openOverlay } from "herdr";
import { WebSocket } from "websocket";
import net from "net";
import { Buffer } from "buffer";
import { readFile, exists, writeFile } from "fs/promises";

const BAR = 36;
const STRIP = 30; // the tab strip under the toolbar
const CHROME = BAR + STRIP;
const DIALOG = "herdr-browser.dialog"; // set by the import dialog while it is open (see browser-import)
const IMPORTED = "herdr-browser.imported"; // shared: the import dialog's stamp after a copy; the panel reloads
// Herdr binds tab/shift-tab to focus cycling and cmd-t/cmd-w to its own tabs. Deeper key contexts win, so
// these reach the page (or the panel) first. ctrl-tab and ctrl-shift-tab stay herdr's (keys.json binds both).
const BINDINGS = [
  { keystroke: "tab", action: "herdr_browser::tab", context: "HerdrBrowserPage" },
  { keystroke: "shift-tab", action: "herdr_browser::tab_prev", context: "HerdrBrowserPage" },
  { keystroke: "escape", action: "herdr_browser::escape", context: "HerdrBrowserPage" },
  { keystroke: "cmd-t", action: "herdr_browser::new_tab", context: "HerdrBrowser" },
  { keystroke: "cmd-w", action: "herdr_browser::close_tab", context: "HerdrBrowser" },
];
const KEYS_ID = JSON.stringify(BINDINGS); // part of the signature: a hot reload that changes BINDINGS binds anew
// Herdr can apply a keys.json change up to ~10 s late (its poll fallback when a file event is missed), and
// that apply clears our bindings again: keep rebinding this long after the file changes.
const KEYS_SETTLE = 12000;
const MAX_TABS = 9; // the helper's limit per group
const GLIDE = 0.5; // share of the remaining distance the page eases per 16 ms tick (higher = snappier, lower = smoother)
const LOAD_MS = 30; // how long a new frame loads in a hidden slot before it is shown (lower = less lag, but risks a blank flash)
// Frame pixel density. Mods get no device-pixel-ratio, so it is the sharpest connected display's: 2x frames on
// a 1x screen cost four times the pixels (measured ~30 ms more per scroll step) for no visible gain.
// shortcut: per-window scale once gpui-kit exposes one; a Retina laptop beside a 1x monitor gets 2x on both.
async function displayScale() {
  try {
    const r = await exec("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5000 });
    let best = 1;
    for (const g of JSON.parse(r.stdout).SPDisplaysDataType ?? []) {
      for (const d of g.spdisplays_ndrvs ?? []) {
        const px = /^(\d+)/.exec(d._spdisplays_pixels ?? "")?.[1], pt = /^(\d+)/.exec(d._spdisplays_resolution ?? "")?.[1];
        if (px && pt) best = Math.max(best, Math.round(Number(px) / Number(pt)));
      }
    }
    return Math.min(2, best);
  } catch {
    return 2;
  }
}
const NAMED = new Set(["enter", "backspace", "tab", "escape", "delete", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"]);
const EDITING = new Set(["a", "c", "v", "x", "z", "y"]);
const RESERVED = new Set([9333, 19333]); // the user's adb forward and the old mod's Chrome: never ours

const utf8 = (bytes) => decodeURIComponent(Array.from(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(""));
const MODE_KEY = "mode"; // "native" (a real WebKit window over the page area) or "stream" (Chrome pictures)
const savedMode = () => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } };
const saveMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch {} };

const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
// The host of an http(s) URL, lowercased; "" for anything else (about:blank, data:).
const host = (url) => (/^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url ?? "")?.[1] ?? "").toLowerCase();
const mods = (m) => ({ shift: Boolean(m?.shift), control: Boolean(m?.control), alt: Boolean(m?.alt), platform: Boolean(m?.platform) });

export default class Browser extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search or enter address" });
    this.input.on("submit", (_e, cx) => this.navigate(this.input.value(), cx));
    this.input.on("focus", () => { this.editing = true; });
    // Leaving the URL bar shows the page's address again, as browsers do.
    this.input.on("blur", () => { this.editing = false; if (this.state.url) this.input.set_value(this.state.url); });
    this.state = { connected: null, url: "", loading: false, canBack: false, canForward: false, selecting: false };
    this.status = "Starting browser…";
    this.mode = null; // "native" | "stream", picked in run()
    this.ntabs = [];
    this.nq = Promise.resolve();
    this.gen = 0;
    this.imported = shared(IMPORTED) ?? null; // a stamp from before this copy started is not a new import
    this.bindKeys(undefined, cx);
    if (checking()) return;
    cx.timer.every(3000, (cx) => this.watchKeys(cx));
    cx.timer.every(250, (cx) => this.nativeTick(cx));
    displayScale().then((s) => { if (s !== this.scale) { this.scale = s; this.sendViewport(); } });
    this.bin = `${appHome()}/bin/herdr-browser`;
    this.portFile = `${appHome()}/data/herdr-browser/port`;
    cx.spawn(async (cx) => {
      for (;;) { if ((await nextCommand()) === "focus") this.handle.focus(); cx.notify(); }
    });
    cx.spawn(async (cx) => this.run(cx));
  }

  // Herdr reinstalls its keys, clearing ours, whenever keys.json's mtime changes (a save without edits too) or
  // the file is missing (then on every poll). So track the same signal: the mtime, read with stat.
  watchKeys(cx) {
    if (this.statting) return;
    this.statting = true;
    cx.spawn(async (cx) => {
      let mtime = null;
      try {
        const r = await exec("/usr/bin/stat", ["-f", "%Fm", `${appHome()}/keys.json`], { timeout: 5000 });
        if (r.code === 0) mtime = r.stdout.trim() || null;
      } catch {}
      this.statting = false;
      if (!this.closed) this.bindKeys(mtime, cx);
    });
  }

  // Bindings are the app's, shared by every copy. `mtime` is keys.json's ("<s>.<ns>"), null when it is
  // missing, undefined from init (not read yet). Bind when these BINDINGS aren't in yet, on a new mtime (an
  // older one too: a restored file), on every tick until KEYS_SETTLE past the mtime (herdr may apply it late),
  // and on every tick while the file is missing. The signature is only recorded once bound, so a skipped tick
  // tries again. bind_keys appends: a rebind herdr didn't clear leaves a harmless duplicate until its next reload.
  bindKeys(mtime, cx) {
    const k = (globalThis.__herdrBrowserKeyState ??= {}); // not __herdrBrowserKeys: older copies kept a string there
    const now = Date.now(), fresh = `${KEYS_ID}\n`;
    let sig;
    if (mtime === undefined) {
      if (k.sig?.startsWith(fresh)) return; // a copy with these BINDINGS bound them; the stat ticks keep them in
      sig = fresh;
    } else {
      sig = `${fresh}${mtime ?? "missing"}`;
      const was = k.sig;
      const due = mtime === null || (was !== fresh && was !== sig) || (k.bound ?? 0) < Number(mtime) * 1000 + KEYS_SETTLE;
      if (!due) { k.sig = sig; return; } // bound, and nothing herdr did since
    }
    if (now - (k.bound ?? 0) < 2000 && k.sig === sig) return; // another copy of the panel just did it
    try { cx.bind_keys(BINDINGS); k.bound = now; k.sig = sig; } catch (e) { console.log(`herdr-browser keys: ${e?.message ?? e}`); }
  }


  // One connection at a time; any read or write failure ends it and the next try starts a second later.
  async run(cx) {
    this.mode = await this.pickMode();
    cx.notify();
    while (!this.closed) {
      try {
        if (this.mode === "native") await this.nativeSession(cx);
        else {
          const ws = await this.open(cx);
          if (ws && !this.closed && this.mode !== "native") await this.session(ws, cx);
        }
      } catch (e) {
        this.setStatus(`Browser error: ${e?.message ?? e}`, cx);
      }
      if (this.closed) return;
      await wait(cx, 1000);
    }
  }

  async open(cx) {
    if (!(await exists(this.bin))) return this.setStatus("Browser helper not installed", cx), null;
    let ws = await this.connect();
    if (ws) return ws;
    // Launch at most once per 5 s, so slow starts don't race several helpers onto one Chrome profile.
    if (Date.now() - (this.launched ?? 0) < 5000) return null;
    this.launched = Date.now();
    this.setStatus(this.frame ? "Reconnecting…" : "Starting browser…", cx);
    await exec("sh", ["-c", 'nohup "$0" >/dev/null 2>&1 &', this.bin]);
    for (let i = 0; i < 50 && !this.closed; i++) {
      await wait(cx, 100);
      if ((ws = await this.connect())) return ws;
    }
    this.setStatus("Browser helper did not start; retrying…", cx);
    return null;
  }

  // The port file is "<port>\n<token>\n" (0600); the helper refuses a handshake without the token.
  async connect() {
    let lines;
    try { lines = String(await readFile(this.portFile, "utf8")).trim().split("\n"); } catch { return null; }
    const port = parseInt(lines[0], 10);
    const token = (lines[1] ?? "").trim();
    if (!(port > 0) || RESERVED.has(port)) return null;
    const url = token ? `ws://127.0.0.1:${port}/?token=${token}` : `ws://127.0.0.1:${port}`;
    try { return await WebSocket.connect(url); } catch { return null; }
  }

  // Resolves when the socket dies: a failed read, a failed write (drop) or close().
  async session(ws, cx) {
    const gen = ++this.gen;
    this.ws = ws;
    this.chain = Promise.resolve();
    this.greeted = false;
    this.shownSent = null; // a new helper shows "user" until told otherwise
    this.state = { ...this.state, connected: null };
    const ended = new Promise((resolve) => { this.end = resolve; });
    if (this.size) this.sendViewport(); // else the first size change says hello
    cx.notify();
    (async () => {
      let bad = 0;
      for (;;) {
        let raw;
        try { raw = await ws.read(); } catch { break; }
        if (gen !== this.gen) return;
        if (typeof raw !== "string" && !(raw instanceof Uint8Array)) break; // closed: don't spin on null
        let m;
        try { m = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString()); bad = 0; }
        catch { if (++bad >= 3) break; continue; }
        // A throw here is usually this build's cx gone after a hot reload: let the socket go.
        try { this.onMessage(m, cx); } catch { break; }
      }
      this.drop(ws);
    })();
    await ended;
    this.status = "Reconnecting…";
    cx.notify();
  }

  drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.gen++;
    try { ws.close().catch(() => {}); } catch {}
    this.end?.();
  }

  // Writes go out in order; a rejected write means the socket is dead.
  send(msg) {
    if (this.mode === "native") return this.nativeSend(msg);
    const ws = this.ws;
    if (!ws) return;
    const text = JSON.stringify(msg);
    this.chain = this.chain.then(() => ws.write(text)).catch(() => this.drop(ws));
  }

  // MARK: native mode. The herdr-web helper (bin/herdr-web, tools/herdr-web) shows a real WebKit view in its own
  // window, kept over the page area. Scrolling, clicks and keys go straight to it, like any macOS app. This
  // mod keeps the toolbar and tabs, tells the helper where the page area is (`rect`) and keeps it shown (`lease`).
  async pickMode() {
    this.webBin = `${appHome()}/bin/herdr-web`;
    this.nativeAvailable = await exists(this.webBin);
    try { this.hpid = parseInt((await exec("/bin/sh", ["-c", "echo $PPID"])).stdout, 10) || 0; } catch { this.hpid = 0; }
    return this.nativeAvailable && savedMode() !== "stream" ? "native" : "stream";
  }

  setMode(mode, cx) {
    if (mode === this.mode || (mode === "native" && !this.nativeAvailable)) return;
    saveMode(mode);
    if (this.mode === "native") { this.nraw({ op: "hide" }); this.shown = false; this.lastRect = ""; }
    this.mode = mode;
    this.state = { ...this.state, connected: null, tabs: [], groups: undefined, url: "", canBack: false, canForward: false, loading: false };
    this.nend?.();
    if (this.ws) this.drop(this.ws);
    cx.notify();
  }

  nativeDir() { return `${appHome()}/data/herdr-web`; }

  async nativeOpen() {
    let text;
    try { text = String(await readFile(`${this.nativeDir()}/port-${this.hpid}`, "utf8")); } catch { return null; }
    const [port, token] = text.trim().split("\n");
    if (!port || !token) return null;
    try {
      const s = await net.connect("127.0.0.1", Number(port));
      await s.write(JSON.stringify({ op: "hello", token }) + "\n");
      return s;
    } catch { return null; }
  }

  async nativeSession(cx) {
    let s = await this.nativeOpen();
    if (!s) {
      const dir = this.nativeDir(), pf = `${dir}/port-${this.hpid}`;
      // $PPID is Herdr: the helper follows that pid's window and exits with it.
      await exec("/bin/sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1" && rm -f "$2" && (nohup "$3" --herdr-pid $PPID --port-file "$2" >"$1/helper-$PPID.log" 2>&1 &)', "sh", dir, pf, this.webBin]);
      for (let i = 0; i < 50 && !s && !this.closed; i++) { await wait(cx, 100); s = await this.nativeOpen(); }
      if (!s) { this.setStatus("The native view didn't start", cx); await wait(cx, 1000); return; }
    }
    this.nsock = s;
    this.themeSock = s;
    this.sentBg = null;
    this.nq = Promise.resolve();
    this.ntabs = [];
    this.nactive = null;
    this.shown = false;
    this.lastRect = "";
    this.state = { ...this.state, connected: true };
    const ended = new Promise((resolve) => { this.nend = resolve; });
    cx.notify();
    cx.timer.after(500, () => { if (this.nsock === s && !this.ntabs.length) this.nativeNewTab(); });
    (async () => {
      let buf = [];
      for (;;) {
        let b;
        try { b = await s.read(); } catch { break; }
        if (b === null || b === undefined) break;
        for (const byte of b) {
          if (byte !== 10) { buf.push(byte); continue; }
          let m = null;
          try { m = JSON.parse(utf8(buf)); } catch {}
          buf = [];
          if (m) { try { this.nativeEvent(m, cx); } catch {} }
        }
      }
      if (this.nsock === s) this.nsock = null;
      this.nend?.();
    })();
    await ended;
    if (this.nsock === s) this.nsock = null;
    try { await s.close?.(); } catch {}
    this.shown = false;
    cx.notify();
  }

  nraw(m) {
    const s = this.nsock;
    if (!s) return;
    this.nq = this.nq.then(() => s.write(JSON.stringify(m) + "\n")).catch(() => {});
  }

  nativeEvent(m, cx) {
    if (m.ev === "key") return this.nativeKey(m, cx);
    if (m.ev === "picked") {
      this.state.selecting = false;
      if (!m.cancel) notify({ title: "Element copied", body: `${m.summary ?? "Element"} — XML copied to clipboard; paste it into the chat`, level: "success" });
      cx.notify();
      return;
    }
    if (m.ev !== "tab" || typeof m.id !== "string") return;
    const t = this.ntabs.find((x) => x.id === m.id);
    const next = { id: m.id, url: m.url ?? "", title: m.title ?? "", loading: Boolean(m.loading), canBack: Boolean(m.canBack), canForward: Boolean(m.canForward) };
    if (t) Object.assign(t, next); else this.ntabs.push(next);
    if (m.active || !this.nactive) this.nactive = m.id;
    this.nativeState();
    cx.notify();
  }

  // Shortcuts pressed while the page has the keyboard (the helper took them; Herdr was not the key window).
  nativeKey(m, cx) {
    if (m.name === "newtab") this.newTab(cx);
    else if (m.name === "closetab") this.closeTab();
    else if (m.name === "focusurl") { this.editing = true; this.input.focus(); this.input.select_all?.(); }
    else if (m.name === "selecttab") {
      const t = this.ntabs[Number(m.n) - 1];
      if (t) this.send({ t: "tab", op: "select", id: t.id });
    }
    cx.notify();
  }

  nativeState() {
    const a = this.ntabs.find((x) => x.id === this.nactive);
    const tabs = this.ntabs.map((x) => ({ id: x.id, url: x.url, title: x.title, active: x.id === this.nactive }));
    this.state = { ...this.state, connected: true, url: a?.url ?? "", loading: Boolean(a?.loading), canBack: Boolean(a?.canBack), canForward: Boolean(a?.canForward), tabs, group: "user", groups: [{ id: "user", owner: "user", tabs }] };
    const shownUrl = a?.url && a.url !== "about:blank" ? a.url : "";
    if (!this.editing && this.input.value() !== shownUrl) this.input.set_value(shownUrl);
  }

  nativeNewTab() {
    const id = `t${(this.tabSeq = Math.max(this.tabSeq ?? 0, ...this.ntabs.map((x) => Number(x.id.slice(1)) || 0)) + 1)}`;
    this.ntabs.push({ id, url: "", title: "", loading: false, canBack: false, canForward: false });
    this.nactive = id;
    this.nraw({ op: "tab", id, url: "about:blank" });
    this.nativeState();
  }

  nativeClose(id) {
    const i = this.ntabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.ntabs.splice(i, 1);
    this.nraw({ op: "close", id });
    if (this.nactive === id) {
      const n = this.ntabs[Math.min(i, this.ntabs.length - 1)];
      if (n) { this.nactive = n.id; this.nraw({ op: "select", id: n.id }); } else { this.nactive = null; this.nativeNewTab(); return; }
    }
    this.nativeState();
  }

  // Messages written for the Chrome helper, as the native one understands them; the rest (mouse, keys,
  // viewport, select) the real view handles itself.
  nativeSend(m) {
    const id = this.nactive;
    if (m.t === "navigate") this.nraw({ op: "go", id, url: m.url });
    else if (m.t === "select") this.nraw({ op: "pick", id, on: Boolean(m.on) });
    else if (m.t === "reload" && m.hard) this.nraw({ op: "reloadHard", id });
    else if (m.t === "back" || m.t === "forward" || m.t === "reload") this.nraw({ op: m.t, id });
    else if (m.t === "tab") {
      if (m.op === "new") this.nativeNewTab();
      else if (m.op === "close") this.nativeClose(m.id ?? id);
      else if (m.op === "select" && this.ntabs.some((x) => x.id === m.id)) { this.nactive = m.id; this.nraw({ op: "select", id: m.id }); this.nativeState(); }
    }
  }

  // Where the page area is, in window units. Mouse events carry the panel's bounds; between them the panel is
  // assumed flush with the window's right and bottom edges (as the layout docks it), so a resize follows.
  trackBounds(e) {
    const b = e.bounds;
    if (!b || !(b.width > 0)) return;
    let vp;
    try { vp = globalThis.window.viewport_size(); } catch { return; }
    this.gapR = vp.width - (b.x + b.width);
    this.gapB = vp.height - (b.y + b.height);
    if (this.mode === "native") this.nativeSync();
  }

  pageRect() {
    if (this.gapR == null || !this.size) return null;
    let vp;
    try { vp = globalThis.window.viewport_size(); } catch { return null; }
    const w = this.size.width, h = this.size.height - CHROME;
    if (w < 8 || h < 8) return null;
    return { x: Math.round(vp.width - this.gapR - w), y: Math.round(vp.height - this.gapB - this.size.height + CHROME), w: Math.round(w), h: Math.round(h), vw: Math.round(vp.width), vh: Math.round(vp.height) };
  }

  nativeSync() {
    if (!this.nsock || this.dialogOpen()) return;
    const r = this.pageRect();
    if (!r) return;
    const key = JSON.stringify(r);
    if (key !== this.lastRect) { this.lastRect = key; this.nraw({ op: "rect", ...r }); } else this.nraw({ op: "lease" });
    this.shown = true;
  }

  // Each tick: renew the lease if this copy drew since the last one (a hidden panel doesn't draw), else hide.
  // The page window sits above Herdr, so a Herdr dialog over the page area would be hidden behind it.
  dialogOpen() {
    const v = shared(DIALOG);
    return typeof v === "string" && v !== "closed" && Date.now() - Number(v) < 30 * 60 * 1000;
  }

  nativeTick(cx) {
    if (this.mode !== "native" || !this.nsock) { this.rendered = false; return; }
    if (this.dialogOpen()) {
      if (this.shown) { this.nraw({ op: "hide" }); this.shown = false; this.lastRect = ""; }
      this.rendered = false;
      return;
    }
    const bg = theme().background; // an empty tab and the window show this until a page paints
    if (bg && bg !== this.sentBg && this.nsock === this.themeSock) { this.sentBg = bg; this.nraw({ op: "theme", bg }); }
    if (this.rendered) this.nativeSync();
    else if (this.shown) { this.nraw({ op: "hide" }); this.shown = false; this.lastRect = ""; }
    this.rendered = false;
    if (this.shown) cx.notify(); // draws again only if shown: that is what the next lease checks
  }

  onMessage(m, cx) {
    if (m.t === "frame") {
      if (m.path === this.frame) return;
      this.pending = m.path; this.pendingSy = typeof m.sy === "number" ? m.sy : -1;
      return this.swapFrame(cx);
    } else if (m.t === "state") {
      if (typeof m.url === "string" && m.url !== this.state.url && !this.editing) this.input.set_value(m.url);
      this.state = { ...this.state, ...m };
    } else if (m.t === "selected") {
      this.state.selecting = false;
      notify({ title: "Element copied", body: `${m.summary ?? "Element"} — XML copied to clipboard; paste it into the chat`, level: "success" });
    } else if (m.t === "error") {
      return this.showError(String(m.message ?? "Browser error"), cx);
    } else return;
    cx.notify();
  }

  showError(text, cx) {
    this.error = text;
    this.errorTimer?.cancel();
    this.errorTimer = cx.timer.after(5000, (cx) => { this.error = null; cx.notify(); });
    cx.notify();
  }

  // Image slots that never change source while visible (a source change shows nothing until the new file
  // has loaded, so swapping the visible one blanked the page on every scroll step). A new frame loads into
  // a hidden slot and is shown LOAD_MS later. Four slots: the anchor frame (bi), the newest frame (ti) and two
  // that load. Each frame carries its page scroll position (sy); the panel draws frames at (sy - P) and eases
  // P toward the newest frame's sy at 60 fps, so a wheel notch glides instead of jumping.
  swapFrame(cx) {
    if (!this.pending) return;
    const p = this.pending, sy = this.pendingSy;
    if (!this.frame) { // first frame: show it at once
      this.slots = [{ p, sy }, null, null, null]; this.bi = 0; this.ti = 0; this.P = sy; this.busy = new Set(); this.frame = p; this.pending = null;
      cx.notify();
      return;
    }
    const hidden = [0, 1, 2, 3].find((i) => i !== this.bi && i !== this.ti && !this.busy.has(i));
    if (hidden === undefined) return; // all spare slots are loading: the latest frame waits for one to be shown
    this.slots[hidden] = { p, sy };
    this.pending = null;
    this.busy.add(hidden);
    cx.notify(); // draws the hidden slot, which starts its load
    cx.timer.after(LOAD_MS, (cx) => {
      this.busy.delete(hidden);
      this.adopt(hidden, cx);
      this.frame = p;
      this.lastSwap = Date.now();
      cx.notify();
      this.swapFrame(cx);
    });
  }

  // Make slot i the newest frame. Keep an anchor frame on the other side of P so the strip the glide uncovers
  // is filled; when no anchor fits (jump, new page, unknown scroll position) show it as it is.
  adopt(i, cx) {
    const n = this.slots[i], H = Math.max(1, (this.size?.height ?? CHROME) - CHROME);
    const fits = (s) => s && s.sy >= 0 && n.sy >= 0 && Math.abs(n.sy - s.sy) <= H
      && this.P >= Math.min(s.sy, n.sy) - 0.5 && this.P <= Math.max(s.sy, n.sy) + 0.5;
    const old = this.ti;
    if (fits(this.slots[this.bi])) { /* keep the anchor */ }
    else if (old !== i && fits(this.slots[old])) this.bi = old;
    else { this.bi = i; this.P = n.sy >= 0 ? n.sy : 0; }
    this.ti = i;
    if (this.bi !== i) this.glide(cx);
  }

  glide(cx) {
    if (this.gliding) return;
    this.gliding = true;
    const step = (cx) => {
      const t = this.slots?.[this.ti];
      if (!t) { this.gliding = false; return; }
      const d = t.sy - this.P;
      if (Math.abs(d) < 0.5) { this.P = t.sy; this.bi = this.ti; this.gliding = false; cx.notify(); return; }
      this.P += d * GLIDE;
      cx.notify();
      cx.timer.after(16, step);
    };
    cx.timer.after(0, step);
  }

  setStatus(text, cx) {
    if (this.status === text) return;
    this.status = text;
    cx.notify();
  }

  sendViewport() {
    if (!this.ws || !this.size) return;
    this.send({ t: this.greeted ? "viewport" : "hello", w: Math.round(this.size.width), h: Math.max(1, Math.round(this.size.height - CHROME)), scale: this.scale ?? 1 });
    this.greeted = true;
  }

  resized(size, cx) {
    this.size = size;
    this.sizeTimer?.cancel();
    this.sizeTimer = cx.timer.after(150, () => this.sendViewport());
    if (this.mode === "native") this.nativeSync();
    cx.notify();
  }

  // The helper turns typed text into a URL or a search; one set of rules, there.
  navigate(text, cx) {
    const url = text.trim();
    if (!url) return;
    this.send({ t: "navigate", url });
    this.handle.focus();
    cx.notify();
  }

  setSelect(on, cx) {
    this.state.selecting = on;
    this.send({ t: "select", on });
    cx.notify();
  }

  mouse(type, button, e) {
    const p = e.local_position;
    if (!p) return;
    if (type === "up" && this.held !== button) return; // the press began elsewhere, or a release already went out
    this.moveMsg = null; // the press carries its own position
    this.held = type === "down" ? button : null;
    this.last = p;
    this.send({ t: "mouse", type, x: p.x, y: p.y, button, clicks: e.click_count ?? 1, dx: 0, dy: 0, mods: mods(e.modifiers) });
  }

  // A release off the page (toolbar, outside the panel) never reaches the page: let go at the last position
  // seen, or every later hover drags.
  release(e) {
    if (!this.held || !this.last) return;
    this.moveMsg = null;
    this.send({ t: "mouse", type: "up", x: this.last.x, y: this.last.y, button: this.held, clicks: 1, dx: 0, dy: 0, mods: mods(e?.modifiers) });
    this.held = null;
  }

  // At most one move per 16 ms, always the latest. `button` only while one is held, so hovering never drags.
  move(e, cx) {
    const p = e.local_position;
    if (!p) return;
    this.last = p;
    this.moveMsg = { t: "mouse", type: "move", x: p.x, y: p.y, ...(this.held ? { button: this.held } : {}), clicks: 0, dx: 0, dy: 0, mods: mods(e.modifiers) };
    if (this.moveTimer) return;
    const due = 16 - (Date.now() - (this.lastMove ?? 0));
    if (due <= 0) return this.flushMove();
    this.moveTimer = cx.timer.after(due, () => { this.moveTimer = null; this.flushMove(); });
  }

  flushMove() {
    if (!this.moveMsg) return;
    this.lastMove = Date.now();
    this.send(this.moveMsg);
    this.moveMsg = null;
  }

  wheel(e) {
    const p = e.local_position;
    if (!p) return;
    this.send({ t: "mouse", type: "wheel", x: p.x, y: p.y, clicks: 0, dx: -e.delta.x, dy: -e.delta.y, mods: mods(e.modifiers) });
  }

  key(e, cx) {
    // Keys bubble up from the URL bar too: those are the Input's.
    if (!this.handle.is_focused()) return;
    const m = e.modifiers ?? {}, k = e.keystroke, key = e.key?.toLowerCase();
    if (k === "cmd-l") this.input.focus();
    else if (k === "cmd-shift-r") this.send({ t: "reload", hard: true });
    else if (k === "cmd-r") this.send({ t: "reload" });
    else if (k === "cmd-shift-s") this.setSelect(!this.state.selecting, cx);
    else if (key === "escape" && this.state.selecting) this.setSelect(false, cx);
    else if (m.platform || m.control) {
      if (!EDITING.has(key)) return; // every other chord stays herdr's (cmd-[ and cmd-] included)
      this.send({ t: "key", key, mods: mods(m) });
    } else if (NAMED.has(e.key)) this.send({ t: "key", key: e.key, ...(e.key_char ? { char: e.key_char } : {}), mods: mods(m) });
    else if (e.key_char) this.send({ t: "text", text: e.key_char });
    else return;
    cx.stop_propagation();
  }

  // Bound keys (BINDINGS). The page ones only reach the page's own context, so the URL bar's Tab still moves focus.
  pageKey(key, shift, cx) {
    if (key === "escape" && this.state.selecting) return this.setSelect(false, cx);
    this.send({ t: "key", key, mods: mods({ shift }) });
  }

  // At the limit the helper refuses the tab, so don't clear and focus the URL bar: what's typed there would
  // replace the active tab's page.
  newTab(cx) {
    if (!(this.mode === "native" ? this.nsock : this.ws)) return;
    if ((this.state.tabs?.length ?? 0) >= MAX_TABS) return this.showError(`At most ${MAX_TABS} tabs`, cx);
    this.send({ t: "tab", op: "new" });
    this.editing = true;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  closeTab(id) {
    if (this.mode === "native" ? this.nsock : this.ws) this.send({ t: "tab", op: "close", ...(id != null ? { id } : {}) });
  }

  // The group to show: an agent's whose terminal is in the herdr tab on screen (the most recently active
  // first, as the helper orders them), else the panel's own. Null while the helper has no groups (an older one).
  wantedGroup() {
    const groups = this.state.groups;
    if (!Array.isArray(groups)) return null;
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    if (!tab) return "user";
    const here = new Set(panes().filter((p) => p.tab === tab.id && p.terminal).map((p) => p.terminal));
    return groups.find((g) => g.owner !== "user" && g.terminal && here.has(g.terminal))?.id ?? "user";
  }

  // Runs from render: herdr re-renders on every space, tab and pane change, and only a change is sent.
  syncShown() {
    const want = this.wantedGroup();
    if (!want || !this.ws || !this.greeted || want === this.shownSent) return;
    this.shownSent = want;
    this.send({ t: "show", group: want });
  }

  // The import dialog stamps shared state after a copy: reload so the page sees the new sign-ins.
  syncImported() {
    const stamp = shared(IMPORTED) ?? null;
    if (stamp === this.imported) return;
    this.imported = stamp;
    if (this.ws) this.send({ t: "reload" });
  }

  openImport() {
    const hosts = new Set();
    for (const g of this.state.groups ?? [{ tabs: this.state.tabs ?? [] }]) {
      for (const tab of g.tabs ?? []) {
        const h = host(tab.url);
        if (h) hosts.add(h);
      }
    }
    openOverlay({ mod: "browser-import", kind: "dialog", width: 420, height: 520, props: { open: [...hosts], native: this.mode === "native" } });
  }

  async close() {
    this.closed = true;
    if (this.nsock) { this.nraw({ op: "hide" }); this.nend?.(); }
    const ws = this.ws;
    this.ws = null;
    this.gen++;
    this.end?.();
    if (!ws) return;
    try { await ws.write(JSON.stringify({ t: "visible", on: false })); } catch {}
    try { ws.close().catch(() => {}); } catch {}
  }

  message() {
    if (this.error) return this.error;
    if (this.mode === "native") return !this.nsock ? this.status ?? "Starting browser…" : this.gapR == null ? "Move the pointer over the page" : null;
    if (!this.ws) return this.status ?? "Reconnecting…";
    if (this.state.connected === false) return "Reconnecting…";
    if (this.state.connected == null) return "Starting browser…";
    return this.frame ? null : "Loading…";
  }

  render() { this.rendered = true; return this.renderReal(); }
  renderReal() {
    const t = theme(), s = this.state;
    this.syncShown();
    this.syncImported();
    const btn = (id, icon, enabled, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(svg(`mods/browser/${icon}.svg`).size(14));
    const pill = (id, icon, label, on, enabled, action) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(action))
      .child(svg(`mods/browser/${icon}.svg`).size(14)).child(label);
    const native = this.mode === "native";
    const live = native ? Boolean(this.nsock) : Boolean(this.ws);
    const bar = h_flex().h(BAR).flex_none().px(6).gap(2).items_center().border_b_1().border_color(t.border)
      .child(btn("back", "back", live && s.canBack, () => this.send({ t: "back" })))
      .child(btn("fwd", "forward", live && s.canForward, () => this.send({ t: "forward" })))
      .child(btn("reload", "reload", live, () => this.send({ t: "reload" })))
      .child(div().id("url").flex_1().min_w(0).h(26).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .child(pill("select", "select", "Select", s.selecting, live, (_e, cx) => this.setSelect(!s.selecting, cx)))
      .child(pill("signins", "key", "Sign-ins", false, true, () => this.openImport()))
      .when(this.mode !== null && (native || this.nativeAvailable), (el) => el.child(pill("mode", "agent", native ? "Stream" : "Native", false, true, (_e, cx) => this.setMode(native ? "stream" : "native", cx))))
      .child(div().w(12).flex_none().flex().items_center().justify_center()
        .when(live && Boolean(s.loading), (el) => el.child(div().size(6).rounded(3).bg(t.accent).loop("opacity", { from: 0.25, to: 1, period: 900 }))));
    const w = this.size?.width ?? 0, h = Math.max(1, (this.size?.height ?? CHROME) - CHROME);
    // Four fixed slots: shown ones keep their file, hidden ones load the next frames (see swapFrame).
    const layer = (i) => {
      const sl = this.slots?.[i];
      if (!sl) return div().absolute().top(0).left(0).size(0);
      const shown = i === this.bi || i === this.ti;
      const y = shown && sl.sy >= 0 ? Math.round(sl.sy - this.P) : 0;
      return image(sl.p).absolute().top(y).left(0).w(w).h(h).opacity(shown ? 1 : 0);
    };
    const msg = this.message();
    const page = div().id("page").relative().flex_1().min_h(0).overflow_hidden().bg(t.background)
      .key_context("HerdrBrowserPage").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_action("herdr_browser::tab", (_e, cx) => this.pageKey("tab", false, cx))
      .on_action("herdr_browser::tab_prev", (_e, cx) => this.pageKey("tab", true, cx))
      .on_action("herdr_browser::escape", (_e, cx) => this.pageKey("escape", false, cx))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.handle.focus(); this.mouse("down", "left", e); })
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); this.handle.focus(); this.mouse("down", "right", e); })
      .on_mouse_up("left", (e) => this.mouse("up", "left", e))
      .on_mouse_up("right", (e) => this.mouse("up", "right", e))
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_hover((hovered) => { if (!hovered) this.release(); })
      .on_scroll_wheel((e) => this.wheel(e))
      .when(Boolean(this.frame && this.size), (el) => el.child(layer(0)).child(layer(1)).child(layer(2)).child(layer(3)))
      .when(Boolean(msg), (el) => el.child(div().absolute().inset_0().flex().items_center().justify_center()
        .child(div().px(12).py(6).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(msg))));
    return v_flex().id("browser-root").size_full().key_context("HerdrBrowser")
      .on_action("herdr_browser::new_tab", (_e, cx) => this.newTab(cx))
      .on_action("herdr_browser::close_tab", () => this.closeTab())
      .on_size_change((size, cx) => this.resized(size, cx))
      .on_mouse_move((e) => this.trackBounds(e))
      .on_mouse_up("left", (e) => this.release(e))
      .on_mouse_up("right", (e) => this.release(e))
      .bg(t.background).text_color(t.foreground).child(bar).child(this.strip(t, live)).child(page);
  }

  // The shown group's tabs, like herdr's own tab bar but smaller; an agent's group starts with its label.
  strip(t, live) {
    const s = this.state;
    const group = (s.groups ?? []).find((g) => g.id === s.group);
    const agent = group && group.owner !== "user" ? [group.name || "agent", group.terminal].filter(Boolean).join(" · ") : null;
    const tabs = live ? s.tabs ?? [] : [];
    const item = (tab) => {
      const show = tab.active || this.hoverTab === tab.id;
      return h_flex().id(`btab-${tab.id}`).h(26).max_w(160).min_w(0).pl(10).pr(show ? 4 : 10).gap(4).flex_shrink_1().items_center()
        .rounded(6).text_size(12).cursor_pointer().border_1()
        .border_color(tab.active ? t.border : t.background).bg(tab.active ? t.raised : t.background)
        .text_color(tab.active ? t.foreground : t.muted)
        .when(!tab.active, (el) => el.hover((st) => st.bg(t.hover)))
        .on_hover((on, cx) => { const next = on ? tab.id : this.hoverTab === tab.id ? null : this.hoverTab; if (next !== this.hoverTab) { this.hoverTab = next; cx.notify(); } })
        .on_click(() => { if (!tab.active) this.send({ t: "tab", op: "select", id: tab.id }); })
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.closeTab(tab.id); })
        .child(div().flex_1().min_w(0).truncate().child(tab.title || host(tab.url) || tab.url || "New tab"))
        .when(show, (el) => el.child(div().id(`btab-x-${tab.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab.id); })
          .child(svg("mods/browser/close.svg").size(12))));
    };
    return h_flex().id("strip").h(STRIP).flex_none().px(6).gap(3).items_center().min_w(0).overflow_hidden().border_b_1().border_color(t.border)
      .when(Boolean(agent), (el) => el.child(h_flex().id("strip-agent").h(22).px(7).gap(5).flex_none().items_center().rounded(6).text_size(11.5)
        .bg(t.selected).text_color(t.foreground).child(svg("mods/browser/agent.svg").size(12)).child(agent.length > 32 ? `${agent.slice(0, 31)}…` : agent)))
      .children(tabs.map(item))
      .child(div().id("btab-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .when(live && tabs.length < MAX_TABS, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.newTab(cx)))
        .when(!live || tabs.length >= MAX_TABS, (el) => el.opacity(0.4))
        .child(svg("mods/browser/plus.svg").size(14)));
  }
}
