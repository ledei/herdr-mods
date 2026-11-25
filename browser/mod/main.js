// A browser pane. The herdr-web helper (bin/herdr-web, source in helpers/web) is the only browser: a real WebKit
// window kept over the page area, which owns every tab, the user's and each agent's. This panel keeps the toolbar
// and the tab strip, tells the helper where the page area is and which group of tabs to show, and talks to it
// over a local socket (the protocol is helpers/web/PROTOCOL.md).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, appHome, checking, notify, nextCommand, theme, spaces, panes, shared, openOverlay, layout, window, run } from "herdr";
import net from "net";
import { readFile, exists } from "fs/promises";

const BAR = 36;
const STRIP = 30; // the tab strip under the toolbar
const CHROME = BAR + STRIP;
const DIALOG = "herdr-browser.dialog"; // set by the import dialog while it is open (see browser-import)
// Herdr binds cmd-t/cmd-w to its own tabs. Deeper key contexts win, so these reach the panel first.
const BINDINGS = [
  { keystroke: "cmd-t", action: "herdr_browser::new_tab", context: "HerdrBrowser" },
  { keystroke: "cmd-w", action: "herdr_browser::close_tab", context: "HerdrBrowser" },
];
const KEYS_ID = JSON.stringify(BINDINGS); // part of the signature: a hot reload that changes BINDINGS binds anew
// Herdr can apply a keys.json change up to ~10 s late (its poll fallback when a file event is missed), and
// that apply clears our bindings again: keep rebinding this long after the file changes.
const KEYS_SETTLE = 12000;
const MAX_TABS = 9; // the helper's limit per group
const OPEN = "herdr-browser.open"; // {url, at}: a localhost link from a terminal (see link.js)

const findNode = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => findNode(c, id)).find(Boolean));
// The docked panel is open on the browser: true even when Herdr skips a frame (it can stall about every 30 s), which
// "did this copy draw since the last tick" alone reads as closed, hiding the page until the pointer moves over it.
const panelOpen = () => {
  const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "browser" && window()?.visible !== false);
};

// Each layout docks the panel with its own margins: remember the last measured ones per layout (named by its tab
// bar's mod), so a panel opened from a key or a link shows the page before the pointer has crossed it.
const tabsMod = (n) => (n?.id === "tabs" && n.content?.mod) || (n?.children ?? []).map(tabsMod).find(Boolean);
const gapsKey = () => `gaps:${tabsMod(layout()) ?? "?"}`;

const utf8 = (bytes) => decodeURIComponent(Array.from(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(""));

const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
// The host of an http(s) URL, lowercased; "" for anything else (about:blank, data:).
const host = (url) => (/^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url ?? "")?.[1] ?? "").toLowerCase();

// The shown group's tabs and the active one's live fields, from the helper's last `groups` event (which tabs
// exist, their urls and titles) and the `tab` events (loading, back, forward). A group it doesn't list shows nothing.
function groupView(groups, shown, live) {
  const tabs = (groups?.find((g) => g.id === shown)?.tabs ?? []).map((x) => ({ id: x.id, url: x.url ?? "", title: x.title ?? "", active: Boolean(x.active) }));
  const a = tabs.find((x) => x.active), l = (a && live.get(a.id)) || {};
  return { tabs, url: a?.url ?? "", loading: Boolean(l.loading), canBack: Boolean(l.canBack), canForward: Boolean(l.canForward) };
}

// A `tab` event's url, title and active flag, applied to the groups event it belongs to. A tab that event doesn't
// list yet waits for the next `groups`.
function patchTab(groups, m) {
  for (const g of groups ?? []) {
    const t = g.tabs?.find((x) => x.id === m.id);
    if (!t) continue;
    t.url = m.url ?? t.url;
    t.title = m.title ?? t.title;
    if (m.active) for (const x of g.tabs) x.active = x === t;
    return;
  }
}

// pkill -f matches this regex against whole command lines: it names one port file and nothing longer (port-12, not port-123).
const stopPattern = (pf) => `--port-file ${pf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;

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
    this.nq = Promise.resolve();
    this.live = new Map(); // tab id -> { loading, canBack, canForward }, from `tab` events
    this.bindKeys(undefined, cx);
    if (checking()) return;
    cx.timer.every(3000, (cx) => this.watchKeys(cx));
    cx.timer.every(250, (cx) => this.nativeTick(cx));
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
    this.webBin = `${appHome()}/bin/herdr-web`;
    try { this.hpid = parseInt((await exec("/bin/sh", ["-c", "echo $PPID"])).stdout, 10) || 0; } catch { this.hpid = 0; }
    while (!this.closed) {
      try {
        await this.nativeSession(cx);
      } catch (e) {
        this.setStatus(`Browser error: ${e?.message ?? e}`, cx);
      }
      if (this.closed) return;
      await wait(cx, 1000);
    }
  }

  nativeDir() { return `${appHome()}/data/herdr-web`; }

  async nativeOpen() {
    let text;
    try { text = String(await readFile(`${this.nativeDir()}/port-${this.hpid}`, "utf8")); } catch { return null; }
    const [port, token] = text.trim().split("\n");
    if (!port || !token) return null;
    try {
      const s = await net.connect("127.0.0.1", Number(port));
      await s.write(JSON.stringify({ op: "hello", token, v: 2, role: "panel" }) + "\n");
      return s;
    } catch { return null; }
  }

  async nativeSession(cx) {
    let s = await this.nativeOpen();
    if (!s) {
      if (!(await exists(this.webBin))) return this.setStatus("Browser helper not installed", cx);
      const dir = this.nativeDir(), pf = `${dir}/port-${this.hpid}`;
      // $PPID is Herdr: the helper follows that pid's window and exits with it.
      await exec("/bin/sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1" && rm -f "$2" && (nohup "$3" --herdr-pid $PPID --port-file "$2" >>"$1/helper-$PPID.log" 2>&1 &)', "sh", dir, pf, this.webBin]);
      for (let i = 0; i < 50 && !s && !this.closed; i++) { await wait(cx, 100); s = await this.nativeOpen(); }
      if (!s) { this.setStatus("The native view didn't start", cx); await wait(cx, 1000); return; }
    }
    this.nsock = s;
    this.themeSock = s;
    this.sentBg = null;
    this.nq = Promise.resolve();
    this.groups = undefined; // the helper's groups event, with `tab` events patched in
    this.shownGroup = "user";
    this.shownSent = null; // a new helper shows "user" until told otherwise
    this.seeded = 0;
    this.live.clear();
    this.stale = false;
    this.shown = false;
    this.lastRect = "";
    this.nativeState();
    const ended = new Promise((resolve) => { this.nend = resolve; });
    cx.notify();
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
    if (this.stale) {
      // A helper whose hello has no `v` is an older build that can't show groups. Stop that one only (found by
      // its port file, never by name: other Herdr windows have their own); the next try starts the current one.
      this.setStatus("Updating the browser helper…", cx);
      try { await exec("/usr/bin/pkill", ["-f", "--", stopPattern(`${this.nativeDir()}/port-${this.hpid}`)]); } catch {}
      this.stale = false;
    }
    cx.notify();
  }

  nraw(m) {
    const s = this.nsock;
    if (!s) return;
    this.nq = this.nq.then(() => s.write(JSON.stringify(m) + "\n")).catch(() => {});
  }

  nativeEvent(m, cx) {
    if (m.ev === "hello") {
      if (!(m.v >= 2)) { this.stale = true; this.nend?.(); }
    } else if (m.ev === "key") return this.nativeKey(m, cx);
    else if (m.ev === "groups") {
      this.groups = Array.isArray(m.groups) ? m.groups : [];
      this.shownGroup = typeof m.shown === "string" ? m.shown : "user";
      const ids = new Set(this.groups.flatMap((g) => (g.tabs ?? []).map((t) => t.id)));
      for (const id of this.live.keys()) if (!ids.has(id)) this.live.delete(id);
      this.nativeState();
    } else if (m.ev === "tab") {
      if (typeof m.id !== "string") return;
      this.live.set(m.id, { loading: Boolean(m.loading), canBack: Boolean(m.canBack), canForward: Boolean(m.canForward) });
      patchTab(this.groups, m);
      this.nativeState();
    } else if (m.ev === "selecting") {
      this.state = { ...this.state, selecting: Boolean(m.on), pickAgent: m.on ? m.agent ?? null : null };
    } else if (m.ev === "picked") {
      this.state = { ...this.state, selecting: false, pickAgent: null };
      if (m.cancel || m.agent) this.multiPick = false;
      if (!m.cancel) {
        if (m.agent) notify({ title: `Element sent to ${m.agent}`, body: m.summary ?? "Element", level: "success" });
        else if (this.multiPick) {
          // The helper put the XML on the clipboard: paste it into the focused terminal (no Enter), then pick again,
          // so several elements gather in the agent's prompt before the person writes and sends it. Esc or Select stops.
          run("terminal.paste");
          this.state = { ...this.state, selecting: true };
          this.tabOp("pick", { on: true });
          notify({ title: "Element added to the terminal", body: `${m.summary ?? "Element"} — pick another, or Esc to stop`, level: "success" });
        } else notify({ title: "Element copied", body: `${m.summary ?? "Element"} — XML copied to clipboard; paste it into the chat`, level: "success" });
      }
    } else if (m.ev === "error") return this.showError(String(m.message ?? "Browser error"), cx);
    else return;
    cx.notify();
  }

  // Shortcuts pressed while the page has the keyboard (the helper took them; Herdr was not the key window).
  // Every panel copy gets them: only the one showing the page acts, or each copy would open its own tab.
  nativeKey(m, cx) {
    if (!this.shown) return;
    if (m.name === "newtab") this.newTab(cx);
    else if (m.name === "closetab") this.closeTab();
    else if (m.name === "focusurl") { this.editing = true; this.input.focus(); this.input.select_all?.(); }
    else if (m.name === "selecttab") {
      const t = this.state.tabs?.[Number(m.n) - 1];
      if (t) this.nraw({ op: "select", id: t.id });
    }
    cx.notify();
  }

  nativeState() {
    const v = groupView(this.groups, this.shownGroup, this.live);
    this.state = { ...this.state, connected: true, ...v, group: this.shownGroup, groups: this.groups };
    const shownUrl = v.url && v.url !== "about:blank" ? v.url : "";
    if (!this.editing && this.input.value() !== shownUrl) this.input.set_value(shownUrl);
  }

  // The helper may leave the user's group empty (the last tab closed): open a tab whenever it is, at most once a
  // second and a half, because the groups event that shows the new tab can lag. Only a copy that drew since the last
  // tick does it: a hidden copy keeps its timers, and two copies would open two tabs.
  seedUser() {
    if (!this.rendered || !this.groups || this.groups.find((g) => g.id === "user")?.tabs?.length || Date.now() - this.seeded < 1500) return;
    this.seeded = Date.now();
    this.nraw({ op: "tab", url: "about:blank" });
  }

  // A link from link.js: open it in the active tab when that is empty, else in a new tab. Only a copy that drew
  // (the shown panel) takes it, and only once; a request older than 15 s is stale.
  openRequested() {
    const o = shared(OPEN);
    if (!this.rendered || !this.groups || !o?.url || !(o.at > (this.openedAt ?? 0)) || Date.now() - o.at > 15000) return;
    this.openedAt = o.at;
    const a = this.state.tabs?.find((t) => t.active), n = this.state.tabs?.length ?? 0;
    if (!a?.url || a.url === "about:blank" || n >= MAX_TABS) this.tabOp("go", { url: o.url });
    else this.nraw({ op: "tab", group: this.state.group, url: o.url });
  }

  // An op on the active tab of the shown group; the helper reads the tab's string id.
  tabOp(op, extra) {
    const id = this.state.tabs?.find((t) => t.active)?.id;
    this.nraw({ op, ...(id ? { id } : {}), ...extra });
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
    try { localStorage.setItem(gapsKey(), JSON.stringify([this.gapR, this.gapB])); } catch {}
    this.nativeSync();
  }

  pageRect() {
    if (this.gapR == null) { try { [this.gapR, this.gapB] = JSON.parse(localStorage.getItem(gapsKey()) ?? "[null,null]"); } catch {} }
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
    if (!this.nsock) { this.rendered = false; return; }
    this.seedUser();
    this.openRequested();
    if (this.dialogOpen()) {
      if (this.shown) { this.nraw({ op: "hide" }); this.shown = false; this.lastRect = ""; }
      this.rendered = false;
      return;
    }
    const bg = theme().background; // an empty tab and the window show this until a page paints
    if (bg && bg !== this.sentBg && this.nsock === this.themeSock) { this.sentBg = bg; this.nraw({ op: "theme", bg }); }
    const open = panelOpen();
    if (this.rendered || open) this.nativeSync();
    else if (this.shown) { this.nraw({ op: "hide" }); this.shown = false; this.lastRect = ""; }
    this.rendered = false;
    if (this.shown || open) cx.notify(); // draws again only if shown: that is what the next lease checks
  }

  showError(text, cx) {
    this.error = text;
    this.errorTimer?.cancel();
    this.errorTimer = cx.timer.after(5000, (cx) => { this.error = null; cx.notify(); });
    cx.notify();
  }

  setStatus(text, cx) {
    if (this.status === text) return;
    this.status = text;
    cx.notify();
  }

  resized(size, cx) {
    this.size = size;
    this.nativeSync();
    cx.notify();
  }

  // The helper turns typed text into a URL or a search; one set of rules, there.
  navigate(text, cx) {
    const url = text.trim();
    if (!url) return;
    this.tabOp("go", { url });
    this.handle.focus();
    cx.notify();
  }

  setSelect(on, cx) {
    this.multiPick = on;
    this.state = { ...this.state, selecting: on, pickAgent: null };
    this.tabOp("pick", { on });
    cx.notify();
  }

  // Only the shortcuts the helper doesn't take itself; typing and the mouse go straight to its view.
  key(e, cx) {
    // Keys bubble up from the URL bar too: those are the Input's.
    if (!this.handle.is_focused()) return;
    const k = e.keystroke;
    if (k === "cmd-l") this.input.focus();
    else if (k === "cmd-shift-r") this.tabOp("reloadHard");
    else if (k === "cmd-r") this.tabOp("reload");
    else if (k === "cmd-shift-s") this.setSelect(!this.state.selecting, cx);
    else if (e.key?.toLowerCase() === "escape" && this.state.selecting) this.setSelect(false, cx);
    else return;
    cx.stop_propagation();
  }

  // A new tab goes into the shown group, an agent's included (the helper names it). At the limit the helper
  // refuses it, so don't clear and focus the URL bar: what's typed there would replace the active tab's page.
  newTab(cx) {
    if (!this.nsock || !this.groups) return;
    if ((this.state.tabs?.length ?? 0) >= MAX_TABS) return this.showError(`At most ${MAX_TABS} tabs`, cx);
    this.nraw({ op: "tab", group: this.state.group, url: "about:blank" });
    this.editing = true;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  closeTab(id) {
    id ??= this.state.tabs?.find((t) => t.active)?.id;
    if (this.nsock && id != null) this.nraw({ op: "close", id });
  }

  // The group to show: an agent's whose terminal is in the herdr tab on screen (the most recently active
  // first, as the helper orders them), else the panel's own. Null until the helper's first groups event.
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
    if (!want || !this.nsock || want === this.shownSent) return;
    this.shownSent = want;
    this.nraw({ op: "show", group: want });
  }

  openImport() {
    const hosts = new Set();
    for (const g of this.state.groups ?? [{ tabs: this.state.tabs ?? [] }]) {
      for (const tab of g.tabs ?? []) {
        const h = host(tab.url);
        if (h) hosts.add(h);
      }
    }
    openOverlay({ mod: "browser-import", kind: "dialog", width: 420, height: 520, props: { open: [...hosts], native: true } });
  }

  async close() {
    this.closed = true;
    if (this.nsock) { this.nraw({ op: "hide" }); this.nend?.(); }
  }

  message() {
    if (this.error) return this.error;
    return !this.nsock ? this.status ?? "Starting browser…" : this.gapR == null ? "Move the pointer over the page" : null;
  }

  render() { this.rendered = true; return this.renderReal(); }
  renderReal() {
    const t = theme(), s = this.state;
    this.syncShown();
    const btn = (id, icon, enabled, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(svg(`mods/browser/${icon}.svg`).size(14));
    const pill = (id, icon, label, on, enabled, action) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(action))
      .child(svg(`mods/browser/${icon}.svg`).size(14)).child(label);
    const live = Boolean(this.nsock);
    // An agent asked for the pick: say whose it is, so a click on the page isn't taken for the user's own.
    const pick = s.selecting && s.pickAgent ? `For ${s.pickAgent.length > 14 ? `${s.pickAgent.slice(0, 13)}…` : s.pickAgent}` : "Select";
    const bar = h_flex().h(BAR).flex_none().px(6).gap(2).items_center().border_b_1().border_color(t.border)
      .child(btn("back", "back", live && s.canBack, () => this.tabOp("back")))
      .child(btn("fwd", "forward", live && s.canForward, () => this.tabOp("forward")))
      .child(btn("reload", "reload", live, () => this.tabOp("reload")))
      .child(div().id("url").flex_1().min_w(0).h(26).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .child(pill("select", "select", pick, s.selecting, live, (_e, cx) => this.setSelect(!s.selecting, cx)))
      .child(pill("signins", "key", "Sign-ins", false, true, () => this.openImport()))
      .child(div().w(12).flex_none().flex().items_center().justify_center()
        .when(live && Boolean(s.loading), (el) => el.child(div().size(6).rounded(3).bg(t.accent).loop("opacity", { from: 0.25, to: 1, period: 900 }))));
    const msg = this.message();
    // The helper's own window covers this area once it is placed; what shows here is the message before that.
    const page = div().id("page").relative().flex_1().min_h(0).overflow_hidden().bg(t.background)
      .key_context("HerdrBrowserPage").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .when(Boolean(msg), (el) => el.child(div().absolute().inset_0().flex().items_center().justify_center()
        .child(div().px(12).py(6).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(msg))));
    return v_flex().id("browser-root").size_full().key_context("HerdrBrowser")
      .on_action("herdr_browser::new_tab", (_e, cx) => this.newTab(cx))
      .on_action("herdr_browser::close_tab", () => this.closeTab())
      .on_size_change((size, cx) => this.resized(size, cx))
      .on_mouse_move((e) => this.trackBounds(e))
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
        .on_click(() => { if (!tab.active) this.nraw({ op: "select", id: tab.id }); })
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
