// Atelier v2: the herdr panel that hosts the Atelier shell page in a native WebKit view (atelier-web).
// herdr draws only the strip on top (canvas, agent, composer, Send, full screen, pop out); every canvas control lives
// in the page. The panel copy owns the sessions: it starts atelierd (shared, keeps running) and atelier-web (exits
// with herdr), opens the canvas, and each tick tells atelier-web where the page is (rect), keeps it shown (lease) or
// hides it. Three views (native.js modeStep): in the panel, popped out into atelier-web's own window, or full screen.
// Shared keys: atelier.popped (true while the page is in its own window; the pill shows a dot), atelier.full (the
// layout nodes full screen hid), atelier.dialog and herdr-browser.dialog (a dialog's open time in ms, or "closed": the
// page hides while one is open).
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, appHome, checking, theme, settings, shared, setShared, layout, run, closeOverlay, props, pickFolder, nextCommand } from "herdr";
import net from "net";
import { readFile } from "fs/promises";
import { log } from "./log.js";
import { readSettings, updateSettings } from "./settings.js";
import { palette, icon, iconButton } from "./theme.js";
import * as agent from "./agent.js";
import * as N from "./native.js";

const STRIP = 36;
const TAB = "t1";
const INIT_REF = "shell-init"; // the jsAsync that hands the token to the shell
const MODE_REF = "shell-mode"; // the jsAsync that tells the shell its view
const AGENT_REF = "shell-agent"; // the jsAsync that tells the shell the picked agent (T12)
const SENT_REF = "shell-sent"; // the jsAsync that tells the shell its tray went out
const DIALOGS = ["herdr-browser.dialog", "atelier.dialog"];
const MAX_RECENT = 8;

const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const utf8 = (bytes) => decodeURIComponent(Array.from(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(""));
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
// A canvas folder holds canvas.json; a Claude Design export keeps it in project/, so show the folder above that.
const canvasName = (p) => (base(p) === "project" ? base(p.replace(/\/project\/?$/, "")) : base(p));
const stop = (_e, cx) => cx.stop_propagation();

async function readText(path) {
  try { return String(await readFile(path, "utf8")); } catch { return null; }
}

/** One request to atelierd over a raw socket; {status, json} or null when it can't connect. */
async function http(d, method, path, body) {
  let s;
  try { s = await net.connect("127.0.0.1", d.port); } catch { return null; }
  try {
    await s.write(N.httpRequest({ port: d.port, method, path, token: d.token, body }));
    const bytes = [];
    for (let b; (b = await s.read()) !== null && b !== undefined;) for (const x of b) bytes.push(x);
    return N.parseHttp(utf8(bytes));
  } catch (e) { log(`atelierd request failed: ${e?.message ?? e}`); return null; } finally { try { s.close(); } catch {} }
}

export default class Atelier extends View {
  init(_props, cx) {
    // The old float window (before T3c) may come back from a saved state: it must not start a second session.
    if (props()?.overlay) { this.stale = true; if (!checking()) closeOverlay(props().overlay); return; }
    this.composer = InputState.new({ placeholder: "Message the agent…" });
    this.composer.on("submit", (_e, cx) => this.send(cx));
    this.folder = InputState.new({ placeholder: "/path/to/canvas folder" });
    this.folder.on("submit", (_e, cx) => this.openFolder(this.folder.value(), cx));
    this.handle = cx.focus_handle();
    this.menu = null; // "canvas" | "agent": drawn over the page area, so the page hides while one is open
    this.settings = { recent: [] };
    this.canvas = null; // {path, id, ui, token}: the canvas the page shows, and the atelierd it was opened with
    this.loads = 0; // shell pages loaded and handed their token
    this.note = null; // a short line in the strip after a Send
    this.status = null; // the page area's message while the page isn't live
    this.sync = N.initialSync();
    this.size = null;
    this.rendered = false;
    this.checks = 0;
    this.hidingLogged = new Set(); // overlay names already logged as hiding the page
    this.mode = N.initialMode(null, null);
    agent.setup(this);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "front") this.send_({ op: "front" }); // the pill, while popped: that window comes forward
        cx.notify();
      }
    });
    if (checking()) return;
    cx.spawn(async (cx) => {
      this.settings = { recent: [], ...(await readSettings().catch(() => ({}))) };
      cx.notify();
      this.run(cx);
    });
    // Shared values persist across restarts (layout clicks too): a full screen holds only while the layout still shows
    // it, a pop-out never (atelier-web exits with herdr), and a dialog left open by a crash must not hide the page.
    this.mode = N.initialMode(shared("atelier.full"), layout());
    if (shared("atelier.full") && !this.mode.full) setShared("atelier.full", null);
    if (shared("atelier.popped")) setShared("atelier.popped", false);
    if (N.dialogOpen(shared("atelier.dialog"))) setShared("atelier.dialog", "closed");
    cx.timer.every(250, (cx) => this.tick(cx));
    this.poll = N.initialPoll();
    cx.timer.every(50, (cx) => this.pollOverlays(cx)); // finer than the poll, so a late tick doesn't skip one
  }

  // ---- atelier-web (the browser mod's native session, with this helper's `op` events) ----

  async run(cx) {
    // $PPID is herdr; its binary answers `status` for the overlay poll (herdr-app may not be on a Dock app's PATH).
    try {
      const [pid, bin = ""] = (await exec("/bin/sh", ["-c", "echo $PPID; ps -o comm= -p $PPID"])).stdout.split("\n").map((l) => l.trim());
      this.hpid = parseInt(pid, 10) || 0;
      this.herdrBin = bin.startsWith("/") ? bin : null;
    } catch { this.hpid = 0; }
    if (!this.herdrBin) log("herdr's binary not found: the page won't hide under herdr's dialogs");
    this.bin = `${appHome()}/bin/atelier-web`;
    this.webDir = `${appHome()}/data/atelier-web`;
    log(`start panel herdr=${this.hpid}`);
    while (!this.closed) {
      try { await this.session(cx); } catch (e) { this.setStatus(`Atelier error: ${e?.message ?? e}`, cx); }
      if (this.closed) return;
      await wait(cx, 1000);
    }
  }

  async helperOpen() {
    const pf = N.parseHelperPort(await readText(`${this.webDir}/port-${this.hpid}`));
    if (!pf) return null;
    try {
      const s = await net.connect("127.0.0.1", pf.port);
      await s.write(JSON.stringify({ op: "hello", token: pf.token }) + "\n");
      return s;
    } catch { return null; }
  }

  async session(cx) {
    let s = await this.helperOpen();
    if (!s) {
      this.setStatus("Starting the page view…", cx);
      const pf = `${this.webDir}/port-${this.hpid}`;
      // $PPID is herdr: the helper follows that pid's largest window and exits with it.
      await exec("/bin/sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1" && rm -f "$2" && (nohup "$3" --herdr-pid $PPID --port-file "$2" >"$1/helper-$PPID.log" 2>&1 &)', "sh", this.webDir, pf, this.bin]);
      for (let i = 0; i < 50 && !s && !this.closed; i++) { await wait(cx, 100); s = await this.helperOpen(); }
      if (!s) { this.setStatus("The page view didn't start", cx); return; }
    }
    this.sock = s;
    this.q = Promise.resolve();
    this.sync = N.initialSync();
    this.sentBg = null;
    this.canvas = null; // a new helper has no tab: load the page again
    this.shellLoad = true; // the helper replays the tab's state on hello: a shell already there gets the token again
    // Its mode event on hello says whether the page is popped: until then, as if it were docked.
    log("page view connected");
    let why = "the helper closed it";
    const ended = new Promise((resolve) => { this.end = (reason) => { if (reason) why = reason; resolve(); }; });
    this.send_({ op: "tab", id: TAB, url: "about:blank" });
    if (this.settings.canvas) this.openCanvas(this.settings.canvas, cx);
    else this.setStatus(null, cx);
    (async () => {
      let buf = [];
      for (;;) {
        let b;
        try { b = await s.read(); } catch (e) { why = `read failed: ${e?.message ?? e}`; break; }
        if (b === null || b === undefined) break;
        for (const byte of b) {
          if (byte !== 10) { buf.push(byte); continue; }
          let m = null;
          try { m = JSON.parse(utf8(buf)); } catch {}
          buf = [];
          if (m) { try { this.event(m, cx); } catch {} }
        }
      }
      this.end?.();
    })();
    await ended;
    if (this.sock === s) this.sock = null;
    try { s.close(); } catch {}
    log(`page view disconnected: ${why}`);
    cx.notify();
  }

  send_(m) {
    const s = this.sock;
    if (!s) return;
    this.q = this.q.then(() => s.write(JSON.stringify(m) + "\n")).catch((e) => this.end?.(`write failed: ${e?.message ?? e}`));
  }

  // Never log a URL, a shell payload or a jsAsync reply's text, only their type.
  event(m, cx) {
    if (m.op === "tab" && m.id === TAB) return this.shellLoaded(m);
    if (m.op === "js" && m.ref === AGENT_REF) { if (m.result !== true) this.sentAgent = undefined; return; } // not there yet: the next tick sends it again
    if (m.op === "js" && m.ref === INIT_REF) return log(`shell init ${m.result === false ? "found no __atelierInit" : m.error !== undefined ? "failed" : "done"}`);
    if (m.op === "mode") { this.keepFrame(m.frame, cx); return this.view({ type: "helper", popped: m.popped === true }, cx); }
    if (m.op === "snapshot") { const done = N.shotDone(TAB, m); if (done) this.send_(done); return log(`live shot ${m.error !== undefined ? "failed" : "done"}`); }
    if (m.op !== "shell" || m.id !== TAB) return;
    const d = m.data;
    if (d?.type === "send" && typeof d.text === "string") this.sendText(d.text, cx);
    else if (d?.type === "attach") { this.agent.attach(d.items); cx.notify(); } // the shell's tray: the next Send takes it along
    else if (d?.type === "esc") this.view({ type: "esc" }, cx); // Esc the shell did not use (no selection to clear)
    else if (d?.type === "full") this.view({ type: "full" }, cx); // the shell's Play full screen: the chat hidden too
    else if (d?.type === "dock") log("shell dock"); // atelier-web docks itself; its mode event follows
    else if (d?.type === "kopia" && typeof d.path === "string" && d.path.startsWith("/")) this.remember(d.path, false).catch((e) => log(`settings write failed: ${e?.message ?? e}`)); // the Versions panel's copy: in Recent
    else if (d?.type === "open" && typeof d.path === "string") this.openFolder(d.path, cx);
    else if (d?.type === "snapshot") { const op = N.shotOp(this.webDir, d); if (op) this.send_(op); else log("shell snapshot request malformed"); }
    else log(`shell event type=${typeof d?.type === "string" ? d.type.replace(/[^\w.-]/g, "").slice(0, 32) : typeof d?.type}`);
  }

  // The token reaches the shell only here, as a jsAsync argument once each load of the shell page ends (a canvas
  // opened, Cmd-R, a reconnect): never in a URL. The shell deletes __atelierInit once it has it.
  shellLoaded(m) {
    const { pending, init } = N.shellLoadStep(this.shellLoad, m, this.canvas);
    this.shellLoad = pending;
    if (!init) return;
    this.agent.attach([]); // a new page's tray is empty: what the old one attached belongs to it (and maybe another canvas)
    this.loads++; // a Send on its way belongs to the page before: its answer leaves this one alone
    this.send_(N.shellInit(TAB, INIT_REF, this.canvas.token));
    this.send_(N.shellMode(TAB, MODE_REF, N.modeOf(this.mode)));
    this.sentAgent = undefined; // a new page: tell it the agent again
    this.tellAgent();
  }

  // The picked agent, to the shell: its tray says "Send to <name>", and its address goes into view-state targetSession,
  // which atelier-hook compares with the HC_TERMINAL_ID herdr gives each terminal. Sent when it changes.
  tellAgent() {
    const t = this.canvas ? this.agent.target() : null;
    const agent = t ? { name: t.name, session: t.address } : null;
    const key = JSON.stringify(agent);
    if (!this.canvas || key === this.sentAgent) return;
    this.sentAgent = key;
    this.send_({ op: "jsAsync", id: TAB, ref: AGENT_REF, code: "for (let i = 0; i < 150 && !window.__atelierAgent; i++) await new Promise((r) => setTimeout(r, 100)); return window.__atelierAgent ? (window.__atelierAgent(agent), true) : false", args: { agent } });
  }

  // ---- views: panel, popped (atelier-web's own window), full (the panel alone in herdr's window) ----

  view(a, cx) {
    const was = N.modeOf(this.mode), wasPopped = this.mode.popped;
    const r = N.modeStep(this.mode, a, layout());
    this.mode = r.state;
    for (const op of r.ops) this.send_(op);
    for (const [name, args] of r.cmds) run(name, args);
    if (JSON.stringify(r.state.full) !== JSON.stringify(shared("atelier.full") ?? null)) setShared("atelier.full", r.state.full);
    if (r.state.popped !== wasPopped) { setShared("atelier.popped", r.state.popped); this.sync = N.initialSync(); } // attached: send the rect again
    const now = N.modeOf(r.state);
    if (now === was) return;
    log(`view ${now}`);
    if (this.canvas) this.send_(N.shellMode(TAB, MODE_REF, now));
    cx.notify();
  }

  // Where the popped window was last: kept in settings (popFrame) for the next pop-out, written 1 s after it settles.
  keepFrame(f, cx) {
    if (!f || ["x", "y", "w", "h"].some((k) => !Number.isFinite(f[k]))) return;
    const frame = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (JSON.stringify(frame) === JSON.stringify(this.settings.popFrame)) return;
    this.settings = { ...this.settings, popFrame: frame };
    this.frameTimer?.cancel?.();
    this.frameTimer = cx.timer.after(1000, () => { updateSettings({ popFrame: frame }).then((s) => { this.settings = s; }).catch((e) => log(`settings write failed: ${e?.message ?? e}`)); });
  }

  // ---- atelierd ----

  /** atelierd's port file, if that atelierd answers its ping; else starts one and waits for it. */
  async atelierd(cx) {
    const home = `${appHome()}/data/atelier`;
    const alive = async () => {
      const d = N.parseAtelierd(await readText(`${home}/run/atelierd.json`));
      const r = d && (await http(d, "GET", "/__atelier/ping"));
      return r?.status === 200 && r.json?.app === "atelierd" ? d : null;
    };
    let d = await alive();
    if (d) return d;
    if (Date.now() - (this.launched ?? 0) > 5000) {
      this.launched = Date.now();
      // Detached and shared: it outlives this herdr. The pid file is for stopping it by hand.
      await exec("/bin/sh", ["-c", 'mkdir -p "$1/run" && cd / && { ATELIER_HOME="$1" nohup node "$2" >>"$1/atelierd.log" 2>&1 & echo $! > "$1/run/atelierd.pid"; }', "sh", home, `${appHome()}/atelier/server/atelierd.mjs`]);
      log("atelierd started");
    }
    for (let i = 0; i < 50 && !this.closed; i++) {
      await wait(cx, 100);
      if ((d = await alive())) return d;
    }
    throw new Error("atelierd didn't start");
  }

  async openCanvas(path, cx) {
    this.setStatus(`Opening ${canvasName(path)}…`, cx);
    try {
      const d = await this.atelierd(cx);
      const r = await http(d, "POST", "/__atelier/open", { path });
      if (r?.status !== 200 || !r.json?.id) throw new Error(r?.json?.error ?? "atelierd didn't answer");
      this.canvas = { path, dir: r.json.path || path, id: r.json.id, ui: d.ui, token: d.token }; // dir: the real path atelierd writes under
      // A new document each time (shellUrl's load): the shell loads with this canvas and gets this token.
      this.send_({ op: "go", id: TAB, url: N.shellUrl(d.ui, r.json.id, path === this.settings.canvas ? this.settings.board : undefined, Date.now()) });
      log(`open canvas id=${r.json.id}`);
      await this.remember(path, true);
      this.setStatus(null, cx);
    } catch (e) {
      this.canvas = null;
      log(`open canvas failed: ${e?.message ?? e}`);
      this.setStatus(`Couldn't open ${canvasName(path)}: ${e?.message ?? e}`, cx);
    }
  }

  /** path first in Recent; open: also the canvas to open next time. Written only when that changes something. */
  async remember(path, open) {
    const canvas = open ? path : this.settings.canvas;
    const recent = [path, ...(this.settings.recent ?? []).filter((p) => p !== path)].slice(0, MAX_RECENT);
    if (this.settings.canvas === canvas && recent.join("\n") === (this.settings.recent ?? []).join("\n")) return;
    this.settings = await updateSettings({ canvas, recent, ...(this.settings.canvas !== canvas ? { board: null } : {}) });
  }

  openFolder(text, cx) {
    const path = String(text ?? "").trim().replace(/\/+$/, "");
    if (!path.startsWith("/")) return this.setStatus("Type an absolute folder path", cx);
    this.menu = null;
    this.folder.set_value("");
    cx.spawn((cx) => this.openCanvas(path, cx));
  }

  async browse(cx) {
    this.menu = null;
    setShared("atelier.dialog", String(Date.now())); // the system picker is under the native view otherwise
    try {
      const picked = await pickFolder({ prompt: "Open canvas" });
      if (picked) this.openFolder(picked, cx);
    } finally { setShared("atelier.dialog", "closed"); }
  }

  // ---- each tick: theme, a restarted atelierd, and where the page is ----

  tick(cx) {
    if (!this.sock) { this.rendered = false; return; }
    const bg = theme().background;
    if (bg && bg !== this.sentBg) { this.sentBg = bg; this.send_({ op: "theme", bg }); }
    if (this.canvas && ++this.checks % 8 === 0) this.checkAtelierd(cx);
    this.tellAgent(); // a pick, or the agents in the space changed
    if (this.mode.full) this.view({ type: "layout" }, cx); // the panel closed or another picked: the chat comes back
    this.place();
    this.rendered = false;
    if (this.lastPlace?.shown) cx.notify(); // a shown panel draws again, which the next tick checks
  }

  // A restarted atelierd has a new token, which the open page no longer has.
  checkAtelierd(cx) {
    if (this.checking_) return;
    this.checking_ = true;
    readText(`${appHome()}/data/atelier/run/atelierd.json`).then((t) => {
      const d = N.parseAtelierd(t);
      if (this.canvas && d && d.token !== this.canvas.token) { log("atelierd restarted: reopening"); cx.spawn((cx) => this.openCanvas(this.canvas.path, cx)); }
    }).finally(() => { this.checking_ = false; });
  }

  // herdr draws its own dialogs, popups and menus under the native view: ask which overlays are open, off the UI
  // thread (exec), and hide or show the page as soon as that changes, not at the next tick.
  pollOverlays(cx) {
    const now = Date.now();
    const fast = Boolean(this.canvas && this.lastPlace?.shown && !this.mode.popped);
    if (!this.sock || !this.herdrBin || !N.pollDue(this.poll, now, fast)) return;
    this.poll = N.pollStart(this.poll, now);
    cx.spawn(async (cx) => {
      let out = null; // an error reply or a failed run reads as no answer
      try { out = (await exec("/usr/bin/env", [`HERDR_APP_HOME=${appHome()}`, this.herdrBin, "status"], { timeout: 2000 })).stdout; } catch {}
      const was = this.poll.open;
      const ignore = [...N.ignoredOverlays(this.settings.ignoreOverlays), ...N.ignoredOverlays(settings()["atelier.ignoreOverlays"])];
      this.poll = N.pollEnd(this.poll, out, ignore);
      for (const n of this.poll.hiding) {
        if (this.hidingLogged.has(n)) continue;
        this.hidingLogged.add(n);
        log(`herdr overlay ${JSON.stringify(n)} hides the page (a window that stays open? add it to ignoreOverlays in data/atelier/settings.json)`);
      }
      if (this.poll.open === was) return;
      log(`herdr overlay ${this.poll.open ? "open" : "closed"}`);
      this.place();
      cx.notify();
    });
  }

  place() {
    if (!this.sock) return;
    const tree = layout();
    const place = N.placement(tree, N.blockOf(tree, "atelier") ?? "atelier");
    this.lastPlace = place;
    let vp = null;
    try { vp = globalThis.window.viewport_size(); } catch {}
    const zoom = Number(settings().zoom) || 1; // layout px and the strip are zoomed; the block size and viewport are not
    const want = N.wanted({
      connected: Boolean(this.canvas), rendered: this.rendered, place, menu: Boolean(this.menu),
      popped: this.mode.popped, dialog: this.poll.open || DIALOGS.some((k) => N.dialogOpen(shared(k))),
      rect: N.pageRect({ place, size: this.size, vp, zoom, strip: STRIP }),
    });
    const { ops, state } = N.step(this.sync, want);
    this.sync = state;
    for (const op of ops) this.send_(op);
  }

  // ---- sending ----

  // The words stay until they went out or wait in the queue: a refused or failed Send keeps them (and so does any
  // typing since).
  send(cx) {
    const text = this.composer.value().trim();
    if (!text && !this.agent.attached().length) return; // the tray alone goes too
    this.sendText(text, cx, () => { if (this.composer.value().trim() === text) this.composer.set_value(""); });
  }

  // The text (sanitized) and the shell's tray (paths and anchors checked, labels sanitized: agent.compose) as one
  // message; the tray empties, and onSent runs, once it went out or waits in the queue, unless a new shell page loaded
  // meanwhile (a canvas switch, a reload): its tray, the composer and its shell are not this Send's.
  sendText(text, cx, onSent) {
    const load = this.loads, canvas = this.canvas?.id;
    const where = this.canvas && { name: canvasName(this.canvas.path), path: this.canvas.dir };
    const tell = (outcome) => this.send_({ op: "jsAsync", id: TAB, ref: SENT_REF, code: "return window.__atelierSent ? (window.__atelierSent(outcome), true) : false", args: { outcome } });
    const no = this.agent.refusal(where);
    if (no) { this.flash(no.short, cx); tell({ error: no.text }); return; }
    const clean = this.agent.message(text, where);
    if (!clean) return;
    // One Send at a time: a second Enter while one is on its way would be taken as queued and empty the composer.
    if (this.sending) { this.flash("Still sending…", cx); tell({ error: "Still sending the last message: try again in a moment" }); return; }
    this.sending = true;
    this.flash("Sending…", cx);
    cx.spawn(async (cx) => {
      let out;
      try {
        out = await this.agent.send(clean, cx);
        this.flash(out === "sent" ? "Sent" : "Queued: the agent is busy", cx);
        // The composer is herdr's, shared by every page: a reload of the same canvas still empties it (onSent keeps newer typing).
        if (load !== this.loads) { if (canvas === this.canvas?.id) onSent?.(); return; }
        if (this.agent.attached().length) this.agent.attach([]);
        onSent?.();
      } catch (e) { out = { error: String(e?.message ?? e) }; this.flash(out.error, cx); }
      finally { this.sending = false; }
      if (load === this.loads) tell(out);
    });
  }

  flash(text, cx) {
    this.note = text;
    this.noteTimer?.cancel?.();
    this.noteTimer = cx.timer.after(3000, (cx) => { this.note = null; cx.notify(); });
    cx.notify();
  }

  setStatus(text, cx) {
    if (this.status === text) return;
    this.status = text;
    cx.notify();
  }

  async close() {
    this.closed = true;
    if (this.stale) return;
    if (this.sock) { this.send_({ op: "hide" }); this.end?.("the panel closed"); }
  }

  // ---- drawing ----

  render(cx) {
    if (this.stale) return div();
    this.rendered = true;
    const c = palette(), t = theme();
    return v_flex().id("atelier-root").size_full().bg(t.background).text_color(c.text)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.keystroke === "escape" && this.mode.full) this.view({ type: "esc" }, cx); }) // herdr has the keys
      .on_size_change((size, cx) => { this.size = size; this.place(); })
      .child(this.strip(c, t, cx))
      .child(this.body(c, t, cx));
  }

  strip(c, t, cx) {
    // Narrow panels: the composer gives up its room first, then the pills truncate; Send and the view buttons always stay.
    const pill = (id, label, open, action) => h_flex().id(id).h(26).max_w(150).min_w(44).px(8).gap(4).items_center().rounded(6)
      .text_size(12).bg(open ? t.selected : t.background).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click(action)
      .child(div().truncate().min_w(0).child(label)).child(icon("chevron-down", 12));
    const toggle = (name) => (_e, cx) => { this.menu = this.menu === name ? null : name; cx.notify(); };
    const target = this.agent.target();
    return h_flex().id("strip").h(STRIP).flex_none().px(6).gap(4).items_center().border_b_1().border_color(t.border)
      .child(pill("canvas-pick", this.canvas ? canvasName(this.canvas.path) : this.settings.canvas ? canvasName(this.settings.canvas) : "Open a canvas", this.menu === "canvas", toggle("canvas")))
      .child(pill("agent-pick", target ? target.name : "No agent", this.menu === "agent", toggle("agent")))
      .child(div().id("composer").flex_1().min_w(40).h(26).on_mouse_down("left", stop)
        .child(Input.new(this.composer).h_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .when(this.agent.attached().length > 0, (el) => el.child(div().id("attached").flex_none().text_size(11).text_color(t.muted)
        .child(`+${this.agent.attached().length} attached`)))
      .child(h_flex().id("send").h(26).px(10).flex_none().items_center().rounded(6).text_size(12).font_medium()
        .bg(c.accent).text_color(c.accentInk).on_mouse_down("left", stop).on_click((_e, cx) => this.send(cx)).child("Send"))
      .when(Boolean(this.note), (el) => el.child(div().max_w(140).min_w(0).truncate().text_size(11).text_color(t.muted).child(this.note)))
      .children(this.viewButtons(cx));
  }

  viewButtons(cx) {
    const go = (a) => (_e, cx) => { this.menu = null; this.handle.focus(); this.view(a, cx); }; // focus: Esc reaches on_key_down
    const mode = N.modeOf(this.mode);
    if (mode === "popped") return [iconButton("bring-back", "dock", "Bring Atelier back", go({ type: "panel" }))];
    return [
      mode === "full" ? iconButton("full", "collapse", "Show the chat (Esc)", go({ type: "panel" })) : iconButton("full", "expand", "Full screen", go({ type: "full" })),
      iconButton("pop-out", "popout", "Pop out into its own window", go({ type: "popOut", frame: this.settings.popFrame })),
    ];
  }

  body(c, t, cx) {
    const area = div().id("page").relative().flex_1().min_h(0).overflow_hidden().bg(t.background);
    if (this.menu === "canvas") return area.child(this.canvasMenu(c, t));
    if (this.menu === "agent") return area.child(this.agentMenu(c, t));
    if (this.mode.popped) {
      return area.child(div().absolute().inset_0().flex().items_center().justify_center().p(16)
        .child(h_flex().px(12).py(6).gap(6).items_center().rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12)
          .child(div().text_color(t.muted).child("Atelier is in its own window ·"))
          .child(div().id("bring-back-note").text_color(c.accent).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.view({ type: "panel" }, cx)).child("Bring back"))));
    }
    const msg = !this.settings.canvas && !this.canvas ? "Open a canvas"
      : this.status;
    return area.when(Boolean(msg), (el) => el.child(div().absolute().inset_0().flex().items_center().justify_center().p(16)
      .child(div().px(12).py(6).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(msg))));
  }

  canvasMenu(c, t) {
    const row = (id, title, sub, action) => v_flex().id(id).px(10).py(6).rounded(6).hover((s) => s.bg(t.hover)).on_click(action)
      .child(div().text_size(12.5).text_color(t.foreground).truncate().child(title))
      .child(div().text_size(11).text_color(t.muted).truncate().child(sub));
    const recent = this.settings.recent ?? [];
    return v_flex().p(8).gap(2)
      .child(div().px(10).py(4).text_size(11).text_color(t.muted).child(recent.length ? "Recent canvases" : "No recent canvases"))
      .children(recent.map((p, i) => row(`recent-${i}`, canvasName(p), p, (_e, cx) => this.openFolder(p, cx))))
      .child(div().px(10).pt(10).pb(4).text_size(11).text_color(t.muted).child("Open folder…"))
      .child(h_flex().px(6).gap(6).items_center()
        .child(div().id("folder").flex_1().min_w(0).h(28).on_mouse_down("left", stop)
          .child(Input.new(this.folder).h_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
        .child(h_flex().id("folder-open").h(28).px(10).items_center().rounded(6).text_size(12).bg(t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openFolder(this.folder.value(), cx)).child("Open"))
        .child(h_flex().id("folder-browse").h(28).px(10).items_center().rounded(6).text_size(12).bg(t.raised).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.spawn((cx) => this.browse(cx)); }).child("Browse…")));
  }

  agentMenu(c, t) {
    const all = this.agent.list(), cur = this.agent.target();
    return v_flex().p(8).gap(2)
      .child(div().px(10).py(4).text_size(11).text_color(t.muted).child(all.length ? "Send to" : "No agent in this space"))
      .children(all.map((a) => h_flex().id(`agent-${a.key}`).px(10).py(6).gap(8).items_center().rounded(6)
        .bg(a.key === cur?.key ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.menu = null; cx.spawn((cx) => this.agent.pick(a.key, cx)); cx.notify(); })
        .child(div().flex_1().text_size(12.5).child(a.name)).child(div().text_size(11).text_color(t.muted).child(a.status))));
  }
}
