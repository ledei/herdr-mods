// iOS Simulator for stock Herdr: a drawn iPhone with a toolbar (device, Home, Rotate, Annotate,
// Close) in a right-docked layout block. The live screen is not drawn here: the `herdr-sim overlay`
// helper shows it in its own window, kept exactly over the empty screen area this mod leaves, and
// takes touches there itself. This mod tells the helper where that area is (`edges`), keeps its
// window up while the area is really on screen (`lease`), and passes keys, buttons and picks.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, checking, props, layout, run, focused, panes, appHome, exec, readTextFile, notify, nextCommand } from "herdr";
import net from "net";

const ICON = (name) => `mods/ios-sim/${name}.svg`;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const TOOLBAR = 46, STATUS = 30, PAD = 12, RULER = 10000;
const ROTATIONS = ["upright", "clockwise", "upsideDown", "counterclockwise"];
const LEASE_MS = 250;
// The drawn iPhone, as designed for a 312 pt wide screen; everything scales with it.
const PHONE = {
  screen: 312, bezel: 12, lip: 8, under: 6, body: "#0b0b0d", line: "#3a3d42", lineHover: "#4b4e54",
  outerRadius: 54, screenRadius: 42, island: { w: 96, h: 28, top: 11 }, button: 3,
  buttons: [
    { name: "action", label: "Action button", top: 118, h: 30, inert: true },
    { name: "volumeUp", label: "Volume up", top: 172, h: 56 },
    { name: "volumeDown", label: "Volume down", top: 240, h: 56 },
    { name: "side", label: "Side button (lock, hold for Siri)", top: 196, h: 86, right: true },
  ],
};
const DEFAULT_POINTS = { width: 393, height: 852 };

const booted = (d) => d?.state === "Booted";
const order = (a, b) => booted(b) - booted(a) || a.name.localeCompare(b.name) || a.runtime.localeCompare(b.runtime);
const stop = (_e, cx) => cx.stop_propagation();
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// Terminal control characters (ESC above all) would let app text end the bracketed paste.
const clean = (s) => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
const find = (node, test) => !node || typeof node !== "object" ? null : test(node) ? node : (node.children ?? []).reduce((hit, c) => hit ?? find(c, test), null);
// simctl's runtime id (prefix dropped), `iOS-26-4`, as `iOS 26.4`, like the fork's runtime_name.
const runtimeName = (id) => { const i = id.indexOf("-"); return i < 0 ? id : `${id.slice(0, i)} ${id.slice(i + 1).replace(/-/g, ".")}`; };
const utf8 = (bytes) => decodeURIComponent(Array.from(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(""));
const saved = () => { try { return localStorage.getItem("device"); } catch { return null; } };
const save = (udid) => { try { localStorage.setItem("device", udid); } catch {} };

// Mac key names to HID keyboard usages (US layout), as the fork's ios_sim.rs maps them.
const NAMED = { enter: 40, escape: 41, backspace: 42, tab: 43, space: 44, home: 74, pageup: 75, delete: 76, end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82 };
const PUNCT = [["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49], [";", ":", 51], ["'", "\"", 52], ["`", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56]];
function hidKey(key) {
  if (NAMED[key]) return [NAMED[key], false];
  if (key === " ") return [44, false];
  if ([...key].length !== 1) return null;
  if (/[a-z]/.test(key)) return [4 + key.charCodeAt(0) - 97, false];
  if (/[A-Z]/.test(key)) return [4 + key.charCodeAt(0) - 65, true];
  if (/[1-9]/.test(key)) return [30 + key.charCodeAt(0) - 49, false];
  if (key === "0") return [39, false];
  const bang = "!@#$%^&*()".indexOf(key);
  if (bang >= 0) return [30 + bang, true];
  const p = PUNCT.find(([plain, shifted]) => key === plain || key === shifted);
  return p ? [p[2], key !== p[0]] : null;
}

/** A rect in a portrait box turned clockwise `turns` times. */
function turn(r, box, turns) {
  switch (turns) {
    case 1: return { x: box.h - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 2: return { x: box.w - r.x - r.w, y: box.h - r.y - r.h, w: r.w, h: r.h };
    case 3: return { x: r.y, y: box.w - r.x - r.w, w: r.h, h: r.w };
    default: return r;
  }
}

/** The phone at scale k (points per design point) for a portrait screen, turned `turns` times. */
function phoneGeometry(k, portrait, turns) {
  const p = PHONE;
  const sw = p.screen * k, sh = sw * portrait.height / portrait.width, b = p.bezel * k, lip = p.lip * k;
  const box = { w: sw + 2 * b + 2 * lip, h: sh + 2 * b };
  const t = (r) => turn(r, box, turns);
  const island = { x: lip + b + (sw - p.island.w * k) / 2, y: b + p.island.top * k, w: p.island.w * k, h: p.island.h * k };
  const buttons = p.buttons.map((btn) => ({ ...btn, rect: t({
    x: btn.right ? box.w - lip - p.under * k : 0, y: btn.top * k, w: lip + p.under * k, h: btn.h * k,
  }) }));
  const size = turns % 2 ? { w: box.h, h: box.w } : box;
  return { k, size, body: t({ x: lip, y: 0, w: sw + 2 * b, h: sh + 2 * b }), screen: t({ x: lip + b, y: b, w: sw, h: sh }), island: t(island), buttons };
}

export default class IosSim extends View {
  init(_props, cx) {
    this.tag = "c" + Math.floor(Math.random() * 1e9).toString(36);
    this.devices = null; // null: not listed yet
    this.udid = props()?.udid ?? saved(); // a layout block can pin a device with props {udid}
    this.attached = null; // {udid, width, height}: the helper streams this device
    this.rotation = "upright";
    this.ended = false; // the stream ended; Try now attaches again
    this.problem = null; // the helper can't start or answer
    this.actionError = null;
    this.busy = null; // "Booting" | "Shutting down"
    this.picking = false;
    this.confirming = false;
    this.annotating = false;
    this.picks = []; // [{el, note: InputState}]
    this.typing = false;
    this.z = null; // points per mod unit (Herdr's zoom), measured by the ruler
    this.root = null; // the block's size, points
    this.stage = null; // the phone area's size, points
    this.seq = Date.now() * 100;
    this.lastEdges = "";
    this.shownBefore = false;
    this.rendered = false;
    this.sock = null;
    this.wq = Promise.resolve();
    this.handle = cx.focus_handle();
    if (checking()) { this.devices = []; return; }
    cx.spawn(async (cx) => this.connectLoop(cx));
    cx.timer.every(LEASE_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c, cx); cx.notify(); } });
  }

  // MARK: the helper

  dir() { return `${appHome()}/data/ios-sim`; }

  /** Our block in the shown layout; null when this copy is somewhere else (a pane). */
  block() { return find(layout(), (n) => n.content?.mod === "ios-sim"); }
  wanted() { return !this.block()?.hidden; }

  async connectLoop(cx) {
    for (;;) {
      if (this.wanted()) {
        try { await this.session(cx); } catch (e) { this.problem = String(e?.message ?? e); }
        this.sock = null;
        this.attached = null;
        cx.notify();
      }
      await cx.sleep(1000);
    }
  }

  /** Connects to the running helper (or starts one), then reads its events until it goes. */
  async session(cx) {
    let s = await this.open(cx);
    if (!s) {
      const bin = `${appHome()}/bin/herdr-sim`;
      // $PPID is Herdr: the helper follows that pid's window and exits with it.
      const r = await exec("/bin/sh", ["-c", 'test -x "$3" || exit 3; mkdir -p "$1" && chmod 700 "$1" && rm -f "$2" && (nohup "$3" overlay --herdr-pid $PPID --port-file "$2" >"$1/helper.log" 2>&1 &)', "sh", this.dir(), `${this.dir()}/port`, bin]);
      if (r.code === 3) throw new Error(`The helper is missing: ${bin}. Run ./install.sh ios-sim.`);
      for (let i = 0; i < 50 && !s; i++) { await cx.sleep(100); s = await this.open(cx); }
      if (!s) throw new Error(`The helper didn't start. See ${this.dir()}/helper.log.`);
    }
    this.sock = s;
    this.problem = null;
    this.lastEdges = "";
    this.shownBefore = false;
    this.send({ op: "listDevices" });
    if (this.annotating) this.send({ op: "annotate", on: true });
    cx.notify();
    let buf = [];
    for (;;) {
      const b = await s.read();
      if (b === null) return;
      for (const byte of b) {
        if (byte !== 10) { buf.push(byte); continue; }
        let msg = null;
        try { msg = JSON.parse(utf8(buf)); } catch {}
        buf = [];
        if (msg) this.event(msg, cx);
      }
    }
  }

  /** A socket that said hello to the helper in the port file, or null. */
  async open(cx) {
    const text = await readTextFile(`${this.dir()}/port`).catch(() => null);
    const [port, token] = (text ?? "").split("\n");
    if (!port || !token) return null;
    try {
      const s = await net.connect("127.0.0.1", Number(port));
      await s.write(JSON.stringify({ op: "hello", token }) + "\n");
      return s;
    } catch { return null; }
  }

  // Writes stay in order: an older edges line must never land after a newer one.
  send(msg) {
    const s = this.sock;
    if (!s) return;
    this.wq = this.wq.then(() => s.write(JSON.stringify(msg) + "\n")).catch(() => {});
  }

  event(m, cx) {
    switch (m.ev) {
      case "devices": {
        this.devices = (m.devices ?? []).map((d) => ({ ...d, runtime: runtimeName(String(d.runtime ?? "")) })).sort(order);
        // Only a lone booted device is chosen for you: other booted ones may be someone else's work.
        const on = this.devices.filter(booted);
        if (!this.device()) this.udid = on.length === 1 ? on[0].udid : null;
        this.attach();
        break;
      }
      case "attached":
        this.attached = { udid: m.udid, width: m.width, height: m.height };
        this.ended = false;
        this.rotation = "upright";
        break;
      case "rotation": this.rotation = m.value; break;
      case "streamEnded": this.attached = null; this.ended = true; break;
      case "pick": this.actionError = null; this.addPick(m); break; // an earlier pick over nothing left an error
      case "error": this.actionError = m.message; break;
      default: return; // ping: it only keeps the connection open
    }
    cx.notify();
  }

  attach() {
    const d = this.device();
    if (!d || !booted(d) || this.busy || this.attached?.udid === d.udid) return;
    this.ended = false;
    this.send({ op: "attach", udid: d.udid });
  }

  device() { return this.devices?.find((d) => d.udid === this.udid) ?? null; }
  live() { return Boolean(this.attached && this.attached.udid === this.udid && !this.busy); }

  // MARK: the overlay window: where, and whether

  /** Each tick: renew the lease if this copy drew since the last one (a hidden block doesn't draw). */
  tick(cx) {
    if (this.visible() && this.rendered) this.send({ op: "lease", tag: this.tag });
    this.rendered = false;
    this.sync();
    if (this.visible()) cx.notify(); // draws again only if shown: that is what the next lease checks
  }

  /** Whether the helper's window should be over our screen area now. */
  visible() {
    return Boolean(this.sock && this.live() && !this.picking && this.wanted() && this.screenRect());
  }

  /** The screen area in window points, from the block's and the phone area's measured sizes. */
  screenRect() {
    if (!this.root || !this.stage || !this.z || !this.bar) return null;
    let vp;
    try { vp = globalThis.window.viewport_size(); } catch { return null; }
    const geo = this.fitted(), s = geo.screen;
    // The block is flush with the window's right and bottom edges (the layout puts it last in the root row).
    const x = vp.width - this.root.width + geo.ox + s.x, y = vp.height - this.root.height + this.bar + geo.oy + s.y;
    return { x, y, w: s.w, h: s.h, vw: vp.width, vh: vp.height, r: PHONE.screenRadius * geo.k };
  }

  /** Sends where the screen is, or hides the window, when that changed. */
  sync() {
    if (!this.sock) return;
    if (!this.visible()) {
      if (this.shownBefore) this.send({ op: "hide", tag: this.tag });
      this.shownBefore = false;
      this.lastEdges = "";
      return;
    }
    const r = this.screenRect();
    // Right edges follow the window's right edge; the phone is centred, so top and bottom follow its middle.
    const e = { left: [1, r.x - r.vw], top: [0.5, r.y - r.vh / 2], right: [1, r.x + r.w - r.vw], bottom: [0.5, r.y + r.h - r.vh / 2], radius: r.r };
    const key = JSON.stringify(e);
    if (key === this.lastEdges) return;
    this.lastEdges = key;
    this.shownBefore = true;
    this.seq = Math.max(this.seq + 1, Date.now() * 100); // time-based: ordered across copies too
    this.send({ op: "edges", tag: this.tag, seq: this.seq, ...e });
    this.send({ op: "lease", tag: this.tag });
  }

  /** One send per layout pass: the block's and the phone area's size events come together. */
  schedule(cx) {
    if (this.pending) return;
    this.pending = true;
    cx.spawn(async (cx) => { await cx.sleep(0); this.pending = false; this.sync(); });
  }

  // MARK: actions

  command(c, cx) {
    if (c === "focus") this.handle.focus();
    else if (c === "devices") { this.picking = !this.picking; this.confirming = false; this.sync(); }
    else if (c === "home") this.press("home");
    else if (c === "rotate") this.rotate();
    else if (c === "annotate") this.toggleAnnotate();
    else if (c === "add") { const t = this.target(); if (t && this.picks.length) this.paste(t, cx); }
    else if (c === "close") this.hide();
  }

  pick(d, cx) {
    this.picking = false;
    this.confirming = false;
    this.actionError = null;
    this.clearPicks();
    if (this.attached && this.attached.udid !== d.udid) { this.send({ op: "detach" }); this.attached = null; }
    this.udid = d.udid;
    save(d.udid);
    if (!booted(d)) this.act("Booting", "boot", cx);
    else this.attach();
  }

  /** Boots or shuts down the picked device with simctl (the helper only streams booted ones). */
  act(label, verb, cx) {
    const udid = this.udid;
    this.busy = label;
    this.picking = false;
    this.confirming = false;
    if (verb === "shutdown") { this.send({ op: "detach" }); this.attached = null; }
    cx.spawn(async (cx) => {
      const r = await exec("xcrun", ["simctl", verb, udid], { timeout: 180000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0 && !/current state: (Booted|Shutdown)/.test(r.stderr)) this.actionError = r.stderr.trim() || `simctl ${verb} failed`;
      this.busy = null;
      this.send({ op: "listDevices" });
      cx.notify();
    });
    cx.notify();
  }

  press(name, phase) { if (this.live()) this.send(phase ? { op: "button", name, phase } : { op: "button", name }); }
  rotate() { if (this.live()) this.send({ op: "rotate", dir: "right" }); }

  retry() {
    this.ended = false;
    this.attached = null;
    this.send({ op: "listDevices" }); // its answer attaches again
  }

  // The runtime's cleanup hook (the block went away, another layout, Herdr quit).
  // One direct write: the runtime cancels cleanup after 250 ms, before a queued write may run.
  async close() {
    const bye = JSON.stringify({ op: "hide", tag: this.tag }) + "\n" + JSON.stringify({ op: "quit" }) + "\n";
    await this.sock?.write(bye).catch(() => {});
  }

  hide() {
    this.close();
    const b = this.block();
    if (b) run("layout.hide", { id: b.id });
  }

  // MARK: annotate

  toggleAnnotate() {
    this.annotating = !this.annotating && this.live();
    this.send({ op: "annotate", on: this.annotating });
  }

  clearPicks() {
    this.picks = [];
    this.keysHere();
  }

  keysHere() {
    this.typing = false;
    if (!checking()) this.handle.focus();
  }

  addPick(m) {
    if (!this.annotating || this.picks.some((p) => JSON.stringify(p.el.frame) === JSON.stringify(m.frame))) return;
    const note = InputState.new({ placeholder: "Add a note" });
    note.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    note.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.picks.push({ el: m, note });
  }

  /** What goes into the agent's prompt. */
  prompt() {
    const d = this.device();
    const lines = [`Simulator: ${oneLine(d?.name) || "?"}, ${oneLine(d?.runtime) || "?"}`];
    this.picks.forEach(({ el, note }, i) => {
      const id = el.id ? ` (${oneLine(el.id)})` : "";
      const [x, y, w, h] = (el.frame ?? []).map(Math.round);
      lines.push(`${i + 1}. ${oneLine(el.type)} "${oneLine(el.label)}"${id}`, `   frame ${x},${y} ${w}×${h} pt`);
      const text = oneLine(note.value());
      if (text) lines.push(`   note: ${text}`);
      if (el.imagePath) lines.push(`   image: ${oneLine(el.imagePath)}`);
    });
    return clean(lines.join("\n"));
  }

  /** The focused pane when it runs an agent: agents turn on bracketed paste, so newlines don't send. */
  target() {
    const pane = focused()?.pane;
    const p = pane && panes().find((x) => x.pane === pane && x.terminal && x.program?.agent);
    return p ? { pane: p.pane, name: p.program.name || p.program.key || "agent" } : null;
  }

  // Stock Herdr has no "paste this text" command: the text goes on the clipboard and
  // terminal.paste pastes it into the agent's prompt (bracketed, so it isn't sent).
  paste(target, cx) {
    cx.write_to_clipboard(this.prompt());
    run("pane.focus", { pane: target.pane });
    run("terminal.paste");
    notify({ title: `Added to the ${target.name} prompt`, body: "Not sent: edit it, then press Return. It is also on the clipboard.", level: "success" });
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform && m.shift && e.key === "h") { this.press("home"); return cx.stop_propagation(); }
    if (m.platform && !m.shift && e.key === "right") { this.rotate(); return cx.stop_propagation(); }
    if (m.platform || m.control || m.alt || m.function || this.typing) return;
    if (e.key === "escape" && (this.annotating || this.picking)) {
      if (this.annotating) this.toggleAnnotate();
      this.picking = false;
      this.confirming = false;
      cx.notify();
      return cx.stop_propagation();
    }
    const hid = this.live() && !this.annotating ? hidKey(e.key) ?? (e.key_char ? hidKey(e.key_char) : null) : null;
    if (!hid) return;
    cx.stop_propagation();
    // A whole press per key down: a key released elsewhere can't stay down on the device.
    const shift = hid[1] || m.shift;
    if (shift) this.send({ op: "key", code: 225, down: true });
    this.send({ op: "key", code: hid[0], down: true });
    this.send({ op: "key", code: hid[0], down: false });
    if (shift) this.send({ op: "key", code: 225, down: false });
  }

  // MARK: render

  render(cx) {
    this.rendered = true;
    const t = theme();
    const z = this.z ?? 1;
    return v_flex().id("root").relative().size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.root = size; this.schedule(cx); cx.notify(); })
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      // Herdr's zoom: mod units to points. A wide ruler keeps the size's rounding out of it.
      .child(div().id("ios-sim-ruler").absolute().top(0).left(0).w(RULER).h(0)
        .on_size_change((size, cx) => { this.z = size.width / RULER; this.schedule(cx); cx.notify(); }))
      .child(this.toolbar(t))
      .child(div().id("ios-sim-stage").relative().flex_1().min_h(0).w_full()
        .on_size_change((size, cx) => { this.stage = size; this.schedule(cx); cx.notify(); })
        .child(this.stageContent(t, z)))
      .when(this.annotating, (el) => el.child(div().flex_none().w_full().px(PAD).pb(PAD).flex().justify_center().child(this.card(t))))
      .child(this.statusLine(t))
      .when(this.picking, (el) => el.child(this.menu(t, TOOLBAR - 4, 8)));
  }

  /** The phone fitted to the phone area, in points, with its offset there (whole points). */
  fitted() {
    const unit = this.geometry(1);
    const z = this.z ?? 1, room = this.stage ?? { width: unit.size.w * z, height: unit.size.h * z };
    const k = Math.max(0.2, Math.min((room.width - 2 * PAD * z) / unit.size.w, (room.height - 2 * PAD * z) / unit.size.h, z));
    // A whole-point screen width keeps the drawn hole and the helper's window on the same pixels.
    const geo = this.geometry(Math.floor(PHONE.screen * k) / PHONE.screen);
    const s = geo.screen;
    geo.screen = { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) };
    geo.ox = Math.round((room.width - geo.size.w) / 2);
    geo.oy = Math.round((room.height - geo.size.h) / 2);
    return geo;
  }

  geometry(k) {
    const a = this.attached ?? DEFAULT_POINTS;
    const portrait = { width: Math.min(a.width, a.height), height: Math.max(a.width, a.height) };
    return phoneGeometry(k, portrait, Math.max(0, ROTATIONS.indexOf(this.rotation)));
  }

  // MARK: toolbar

  toolbar(t) {
    const d = this.device();
    const live = this.live();
    const picker = h_flex().id("ios-sim-pick").flex_1().min_w(0).h(30).px(8).gap(7).items_center().rounded(8).cursor_pointer()
      .bg(this.picking ? t.selected : t.hover).hover((s) => s.bg(t.selected))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { this.picking = !this.picking; this.confirming = false; this.send({ op: "listDevices" }); this.sync(); cx.notify(); })
      .child(svg(ICON("phone")).size(14).flex_none().text_color(t.muted))
      .child(div().font_weight(500).truncate().child(d?.name ?? (this.devices?.length ? "Choose a simulator" : "No simulator")))
      .when(Boolean(d), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child(d.runtime)))
      .child(div().flex_1())
      .child(svg(ICON("chevron")).size(12).flex_none().text_color(t.muted));
    return h_flex().id("ios-sim-toolbar").flex_none().h(TOOLBAR).px(8).w_full().items_center().gap(2)
      .on_size_change((size, cx) => { this.bar = size.height; this.schedule(cx); })
      .child(picker)
      .child(this.tool(t, "ios-sim-home", "home", "Home  ⌘⇧H", live, false, () => this.press("home")))
      .child(this.tool(t, "ios-sim-rotate", "rotate", "Rotate  ⌘→", live, false, () => this.rotate()))
      .child(this.tool(t, "ios-sim-annotate", "annotate", this.annotating ? "Annotate  Esc to stop" : "Annotate", live, this.annotating, () => this.toggleAnnotate()))
      .child(div().w(1).h(18).mx(2).flex_none().bg(t.border))
      .child(this.tool(t, "ios-sim-close", "close", "Close", true, false, () => this.hide()));
  }

  tool(t, id, icon, tip, enabled, pressed, onClick) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .tooltip(tip)
      .on_mouse_down("left", stop)
      .when(pressed, (el) => el.bg(t.accent))
      .when(!enabled, (el) => el.opacity(0.35))
      .when(enabled, (el) => el.cursor_pointer().when(!pressed, (el) => el.hover((s) => s.bg(t.hover))).on_click((_e, cx) => { onClick(); cx.notify(); }))
      .child(svg(ICON(icon)).size(icon === "close" ? 13 : 14).text_color(pressed ? t.accent_foreground : t.foreground));
  }

  // MARK: the device menu (the helper's window hides while it is open: it would cover it)

  menu(t, top, left) {
    const devices = this.devices ?? [];
    const current = this.device();
    const row = (d) => h_flex().id(`ios-sim-dev-${d.udid}`).h(30).px(8).gap(8).items_center().rounded(7)
      .when(d.udid === current?.udid, (el) => el.bg(t.selected))
      .when(Boolean(this.busy), (el) => el.opacity(0.5))
      .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pick(d, cx); cx.notify(); }))
      .child(div().truncate().when(!booted(d), (el) => el.text_color(t.muted)).child(d.name))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(d.runtime))
      .child(div().flex_1())
      .when(d.udid === current?.udid, (el) => el.child(svg(ICON("check")).size(13).flex_none().text_color(t.foreground)))
      .when(!booted(d) && d.udid !== current?.udid, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child("Boots on pick")));
    const heading = (text) => div().px(8).py(4).text_size(11).text_color(t.muted).child(text);
    const rule = () => div().h(1).mx(6).my(4).bg(t.border);
    const on = devices.filter(booted), off = devices.filter((d) => !booted(d));
    return v_flex().id("ios-sim-menu").absolute().top(top).left(left).right(8).max_h(420).overflow_y_scroll().p(5).gap(1)
      .rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", stop)
      .when(!devices.length, (el) => el.child(div().p(8).text_color(t.muted).child(this.devices ? "No simulators yet" : "Loading simulators…")))
      .when(on.length > 0, (el) => el.child(heading("Booted")).children(on.map(row)))
      .when(on.length > 0 && off.length > 0, (el) => el.child(rule()))
      .when(off.length > 0, (el) => el.child(heading("Shut down")).children(off.map(row)))
      .when(booted(current) && !this.busy, (el) => el.child(rule()).child(this.shutdownItem(t, current)));
  }

  // A destructive device action never fires on one click: the item asks first, in place.
  shutdownItem(t, d) {
    if (!this.confirming) {
      return h_flex().id("ios-sim-shutdown").h(30).px(8).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.confirming = true; cx.notify(); })
        .child(`Shut down ${d.name}`);
    }
    const small = (id, label, primary, onClick) => div().id(id).h(24).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .when(primary, (el) => el.bg(t.blocked).text_color(t.solid_foreground).font_weight(600))
      .when(!primary, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
    return h_flex().h(34).px(8).gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().child(`Shut down ${d.name}?`))
      .child(small("ios-sim-shutdown-yes", "Shut down", true, (cx) => this.act("Shutting down", "shutdown", cx)))
      .child(small("ios-sim-shutdown-no", "Cancel", false, (cx) => { this.confirming = false; cx.notify(); }));
  }

  // MARK: the phone and its states

  stageContent(t, z) {
    const state = this.state();
    if (state) return div().size_full().flex().items_center().justify_center().p(PAD).child(this.notice(t, state));
    return this.phone(t, z);
  }

  /** What shows instead of the phone; null when the screen is live. */
  state() {
    const d = this.device();
    if (checking()) return { title: "iOS Simulator", body: "The simulator screen shows here." };
    if (this.problem) return { title: "Can’t start the simulator helper", body: this.problem, button: "Try again", action: () => { this.problem = null; }, status: "Helper not running", error: true };
    if (!this.sock || !this.devices) return { spinner: true, title: "Looking for simulators", status: "Loading" };
    if (!this.devices.length) return { title: "No simulators yet", body: "Create one in Xcode under Window › Devices and Simulators, or from a terminal:", mono: 'xcrun simctl create "iPhone 16" "iPhone 16"', button: "Refresh", action: () => this.send({ op: "listDevices" }), status: "No devices" };
    if (!d) return { title: "Choose a simulator", body: "Pick one from the menu above.", button: "Choose", action: () => { this.picking = true; }, status: "No device" };
    if (this.busy) return { spinner: true, title: `${this.busy} ${d.name}`, body: this.busy === "Booting" ? "This can take a minute the first time." : "", status: this.busy };
    if (!booted(d)) return { title: `${d.name} is shut down`, body: "Boot it to see and use its screen here.", button: `Boot ${d.name}`, action: (cx) => this.act("Booting", "boot", cx), status: "Shut down" };
    if (this.ended) return { title: "The simulator screen stopped", body: "Try again to reconnect.", button: "Try now", action: () => this.retry(), status: "Not connected", error: true };
    if (!this.live()) return { spinner: true, title: `Connecting to ${d.name}`, body: "The screen shows up here in a moment.", status: "Connecting" };
    return null;
  }

  notice(t, s) {
    return v_flex().max_w(300).items_center().gap(10).p(16).rounded(16).bg(t.chrome).border_1().border_color(t.border)
      .on_mouse_down("left", stop)
      .when(Boolean(s.spinner), (el) => el.child(svg(SPINNER).size(20).text_color(t.muted).spin(900)))
      .child(div().text_size(13.5).font_weight(600).text_center().child(s.title))
      .when(Boolean(s.body), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.muted).text_center().child(s.body)))
      .when(Boolean(s.mono), (el) => el.child(div().max_w(260).px(8).py(4).rounded(6).bg(t.hover).font_family("Geist Mono").text_size(11.5).child(s.mono)))
      .when(Boolean(this.actionError), (el) => el.child(div().text_size(12).text_color(t.blocked).text_center().child(this.actionError)))
      .when(Boolean(s.button), (el) => el.child(div().id("ios-sim-action").mt(4).h(28).px(12).flex().items_center().rounded(7).cursor_pointer()
        .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_weight(600)
        .on_click((_e, cx) => { this.actionError = null; s.action(cx); cx.notify(); }).child(s.button)));
  }

  /** The drawn phone around an empty screen area: the helper's window covers that area. */
  phone(t, z) {
    const geo = this.fitted();
    const u = (p) => p / z; // points to mod units
    const at = (r) => div().absolute().left(u(r.x)).top(u(r.y)).w(u(r.w)).h(u(r.h));
    const r = (n) => u(n * geo.k);
    return div().absolute().left(u(geo.ox)).top(u(geo.oy)).w(u(geo.size.w)).h(u(geo.size.h))
      .on_mouse_down("left", (_e, cx) => { this.handle.focus(); cx.stop_propagation(); })
      // Volume and Side press like the real ones: held while the pointer is down.
      .children(geo.buttons.map((b) => at(b.rect).id(`ios-sim-btn-${b.name}`).rounded(r(PHONE.button)).bg(PHONE.line)
        .tooltip(b.label)
        .when(!b.inert, (el) => el.cursor_pointer().hover((st) => st.bg(PHONE.lineHover))
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.held = b.name; this.press(b.name, "down"); })
          .on_mouse_up("left", () => this.release())
          .on_hover((over) => { if (!over) this.release(); }))))
      .child(at(geo.body).rounded(r(PHONE.outerRadius)).bg(PHONE.body).shadow_xl())
      .child(at(geo.screen).id("ios-sim-screen").rounded(r(PHONE.screenRadius)).bg("#000000"))
      .child(at(geo.island).rounded(Math.min(u(geo.island.w), u(geo.island.h)) / 2).bg("#000000"))
      .child(at(geo.body).rounded(r(PHONE.outerRadius)).border(1.5).border_color(PHONE.line));
  }

  release() {
    if (!this.held) return;
    this.press(this.held, "up");
    this.held = null;
  }

  // MARK: the picks card

  card(t) {
    const target = this.target();
    const n = this.picks.length;
    return v_flex().id("ios-sim-card").w_full().max_w(360).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", stop)
      .child(h_flex().h(38).px(12).items_center().border_b(1).border_color(t.border).text_size(12.5).font_weight(600)
        .child(div().flex_1().child(`${n} picked`))
        .when(n > 0, (el) => el.child(div().id("ios-sim-clear").h(24).px(6).flex().items_center().rounded(6).cursor_pointer()
          .text_size(11.5).font_weight(400).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.clearPicks(); cx.notify(); }).child("Clear"))))
      .child(v_flex().p(6).gap(6).max_h(240).overflow_y_scrollbar()
        .children(this.picks.map((p, i) => this.row(t, p, i)))
        .child(div().px(6).pt(2).pb(4).text_size(11.5).line_height("16px").text_color(t.muted)
          .child("Click an element to pick it. Taps don't reach the app while annotating.")))
      .child(v_flex().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().id("ios-sim-add").w_full().h(30).flex().items_center().justify_center().rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_weight(600)
          .when(!(n && target), (el) => el.opacity(0.35))
          .when(Boolean(n && target), (el) => el.cursor_pointer().on_click((_e, cx) => { this.paste(target, cx); cx.notify(); }))
          .child(target ? `Add to ${target.name} prompt` : "Focus an agent to add these")));
  }

  row(t, p, i) {
    return v_flex().gap(6).p(8).rounded(8).bg(t.hover)
      .child(h_flex().gap(8).items_center()
        .child(div().size(18).flex_none().rounded(9).bg(t.accent).text_color(t.accent_foreground).flex().items_center().justify_center()
          .text_size(11).font_weight(600).child(String(i + 1)))
        .child(div().min_w(0).truncate().text_size(12.5).font_weight(500).child(oneLine(p.el.label || p.el.id) || "Element"))
        .child(div().flex_none().text_size(11.5).text_color(t.muted).child(p.el.type ?? ""))
        .child(div().flex_1())
        .child(div().id(`ios-sim-remove-${i}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .tooltip(`Remove ${p.el.label || "this pick"}`).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.picks.splice(i, 1); this.keysHere(); cx.notify(); })
          .child(svg(ICON("close")).size(11).text_color(t.muted))))
      .child(div().h(28).px(8).flex().items_center().rounded(6).bg(t.selected).cursor_text()
        .child(Input.new(p.note).h_full().w_full().text_size(12).text_color(t.foreground)));
  }

  statusLine(t) {
    const state = this.state();
    const a = this.attached;
    const text = state?.status ?? `Live · ${a?.width ?? "?"} × ${a?.height ?? "?"} pt`;
    const dot = state?.error ? t.blocked : state ? null : t.accent;
    return h_flex().flex_none().h(STATUS).px(12).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(div().size(7).rounded(4).flex_none().when(Boolean(dot), (el) => el.bg(dot)).when(!dot, (el) => el.border(1.5).border_color(t.dim)))
      .child(div().truncate().child(this.actionError && !state ? this.actionError : text));
  }
}
