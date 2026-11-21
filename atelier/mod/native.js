// The native view's pure parts: port files, the shell URL, where the page sits (from the layout, no pointer needed)
// and what to send atelier-web each tick (rect when it moved, lease while shown, hide once).

/** atelier-web's port file: "<port>\n<token>\n". */
export function parseHelperPort(text) {
  const [p, token] = String(text ?? "").trim().split("\n");
  const port = Number(p);
  return Number.isInteger(port) && port > 0 && token?.trim() ? { port, token: token.trim() } : null;
}

/** atelierd's port file (<ATELIER_HOME>/run/atelierd.json): {ui, boards, token, pid} plus the UI port, else null. */
export function parseAtelierd(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { return null; }
  const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(o?.ui ?? "");
  if (!m || !/^http:\/\/127\.0\.0\.1:\d+$/.test(o.boards ?? "") || typeof o.token !== "string" || !o.token || !Number.isInteger(o.pid)) return null;
  return { ui: o.ui, boards: o.boards, token: o.token, pid: o.pid, port: Number(m[1]) };
}

/** The shell page for a canvas. No token: it goes to the loaded page through shellInit, never in a URL. load (a new
 *  number per open, e.g. Date.now()) makes each open a new document: WebKit only scrolls on a go that changes the hash. */
export function shellUrl(ui, canvas, board, load) {
  const h = `canvas=${encodeURIComponent(canvas)}`;
  return `${ui}/__shell/index.html${load ? `?load=${load}` : ""}#${board ? `${h}&board=${encodeURIComponent(board)}` : h}`;
}

/** Whether `url` is the shell document at atelierd's UI origin (any hash, ?load=<n> or no query), the only page that
 *  may get the token. */
export function isShellUrl(ui, url) {
  if (!ui || typeof url !== "string") return false;
  const page = `${ui}/__shell/index.html`;
  return url.startsWith(page) && /^(\?load=\d+)?(#|$)/.test(url.slice(page.length));
}

/** For each tab event: init when a load of the shell page ends while a canvas is open (a canvas opened, Cmd-R, the
 *  state replayed on a reconnect: start with `pending` true), not on later events of that same load. */
export function shellLoadStep(pending, ev, canvas) {
  if (ev.loading) return { pending: true, init: false };
  const init = pending && Boolean(canvas) && isShellUrl(canvas.ui, ev.url);
  return { pending: pending && !init, init };
}

// WebKit can end a load before the shell's module ran (F4 saw it in a real WKWebView): wait up to 5 s for the function.
const waitFor = (fn) => `for (let i = 0; i < 50 && !window.${fn}; i++) await new Promise((r) => setTimeout(r, 100)); `;

/** The helper op that hands the token to a loaded shell (once per load: the shell deletes __atelierInit). */
export const shellInit = (id, ref, token) =>
  ({ op: "jsAsync", id, ref, code: `${waitFor("__atelierInit")}return window.__atelierInit ? window.__atelierInit(token) : false`, args: { token } });

/** The helper op that tells the shell its view ("panel" | "popped" | "full"): popped, it draws its own top strip. */
export const shellMode = (id, ref, mode) =>
  ({ op: "jsAsync", id, ref, code: `${waitFor("__atelierMode")}return window.__atelierMode ? (window.__atelierMode(mode), true) : false`, args: { mode } });

// ---- where the page sits ----
// No mod API gives an element's position without a pointer event, and the panel copy may never see one (the native
// view covers the page). So the block's top and right edges come from the shown layout tree (layout()): padding,
// gaps and the px sizes of the siblings before it in a column and after it in a row. Both are in layout px.
// shortcut: dividers are not counted (the atelier layout has none on those edges); a sibling sized by weight there
// makes the edge unknown, and the page then stays hidden.

// padding: n, [vertical, horizontal] or [top, right, bottom, left]; only top and right matter here.
const pad = (p) => (typeof p === "number" ? { t: p, r: p } : Array.isArray(p) && p.length >= 2 ? { t: p[0], r: p[1] } : { t: 0, r: 0 });

function pathTo(node, id) {
  if (node?.id === id) return [node];
  for (const c of node?.children ?? []) {
    const p = pathTo(c, id);
    if (p) return [node, ...p];
  }
  return null;
}

/** {shown, top, right} for the block `id`: whether it is on screen, and its top and right edges (layout px from the
 *  window's top and right, null when they can't be known). Null when the layout has no such block. */
export function placement(tree, id) {
  const path = pathTo(tree, id);
  if (!path) return null;
  let shown = !path.some((n) => n.hidden), top = 0, right = 0;
  // An edge moves in by the padding plus each shown sibling on that side and its gap; unknown once one has no px.
  const add = (edge, padding, sibs, gap) => {
    const shownSibs = sibs.filter((s) => !s.hidden);
    if (edge === null || shownSibs.some((s) => typeof s.size?.px !== "number")) return null;
    return shownSibs.reduce((a, s) => a + s.size.px + gap, edge + padding);
  };
  for (let i = 0; i < path.length - 1; i++) {
    const parent = path[i], child = path[i + 1], kids = parent.children, at = kids.indexOf(child);
    if (parent.type === "stack") { if ((parent.active ?? kids[0]?.id) !== child.id) shown = false; continue; }
    const p = pad(parent.padding), gap = parent.gap ?? 0;
    top = add(top, p.t, parent.type === "column" ? kids.slice(0, at) : [], gap);
    right = add(right, p.r, parent.type === "row" ? kids.slice(at + 1) : [], gap);
  }
  return { shown, top, right };
}

/** The page rect atelier-web wants (window units, as viewport_size): the block minus the strip on top. `size` is the
 *  block's on_size_change size, already in window units; layout px and the strip's px are scaled by `zoom`. */
export function pageRect({ place, size, vp, zoom, strip }) {
  if (!place || place.top === null || place.right === null || !size || !vp) return null;
  const s = strip * zoom, h = size.height - s;
  if (size.width < 8 || h < 8) return null;
  return {
    x: Math.round(vp.width - place.right * zoom - size.width), y: Math.round(place.top * zoom + s),
    w: Math.round(size.width), h: Math.round(h), vw: Math.round(vp.width), vh: Math.round(vp.height),
  };
}

// ---- show, hide, lease ----

const DIALOG_MAX_MS = 30 * 60 * 1000; // a stamp left by a dialog that never cleared it stops counting after this

/** A shared dialog key (herdr-browser.dialog, atelier.dialog): the open time in ms, or "closed". */
export function dialogOpen(v, now = Date.now()) {
  if (v === undefined || v === null || v === "closed") return false;
  const t = Number(v);
  return Number.isFinite(t) && now - t < DIALOG_MAX_MS;
}

/** The rect to show the page at, or null to hide it: herdr draws dialogs, popups and our menus under the native view,
 *  so it must be away while any of them is up, while the panel isn't drawn, and while the page is popped out. */
export function wanted({ connected, rendered, place, dialog, popped, menu, rect }) {
  return connected && rendered && place?.shown && !dialog && !popped && !menu ? rect ?? null : null;
}

// ---- herdr's own overlays ----
// No mod API lists open overlays, so the panel asks `herdr-app status`, whose `overlays` names each one's mod ("layout"
// for a layout overlay, null for one without a copy). Our own (a stale float copy), toasts and other mods' long-lived
// windows don't hide the page; the ignoreOverlays setting adds names to that list.
// shortcut: status gives names, not kinds: a window overlay of a mod not in the list hides the page until it closes
// (the panel logs each such name once), and a toast mod with another name than "toast" counts as a dialog.

const NOT_OVER = ["atelier", "toast", "ios-sim"];
const POLL_MS = 90, POLL_IDLE_MS = 500; // 90, not 100: the 50 ms timer's tick at ~100 ms still asks when it lands early

/** The open overlays' names from `herdr-app status` output, else null. */
export function herdrOverlays(stdout) {
  try { const o = JSON.parse(stdout).overlays; return Array.isArray(o) ? o : null; } catch { return null; }
}

/** The names a setting value adds to the ignore list: its non-empty strings. */
export const ignoredOverlays = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && n) : []);

const hiding = (names, extra) => names.filter((n) => !NOT_OVER.includes(n) && !extra.includes(n));

export const herdrOverlayOpen = (names, extra = []) => hiding(names, extra).length > 0;

export const initialPoll = () => ({ busy: false, at: -Infinity, open: false, hiding: [] });

/** Whether to ask now: never while the last ask runs; about 10 a second while the page can show, else 2. */
export const pollDue = (s, now, fast) => !s.busy && now - s.at >= (fast ? POLL_MS : POLL_IDLE_MS);

export const pollStart = (s, now) => ({ ...s, busy: true, at: now });

/** After an ask: open while any overlay that hides the page is (`hiding` names them); a failed ask (null or bad
 *  output) keeps what was last seen. `extra`: ignoredOverlays from the settings. */
export function pollEnd(s, stdout, extra = []) {
  const names = herdrOverlays(stdout);
  if (!names) return { ...s, busy: false, hiding: [] };
  const h = hiding(names, extra);
  return { ...s, busy: false, open: h.length > 0, hiding: h };
}

export const initialSync = () => ({ last: "", shown: false });

/** What to send for this tick: `rect` when it moved (or after a hide, which drops the helper's rect), else `lease`
 *  to keep it shown; one `hide` when it goes away. */
export function step(state, want) {
  if (!want) return state.shown ? { ops: [{ op: "hide" }], state: initialSync() } : { ops: [], state };
  const key = JSON.stringify(want);
  return { ops: [key === state.last ? { op: "lease" } : { op: "rect", ...want }], state: { last: key, shown: true } };
}

// ---- HTTP to atelierd over net (the mod runtime's fetch is capability-gated; net is what the browser mod uses) ----

const utf8Length = (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, "x").length; // no TextEncoder in the mod runtime

/** One HTTP/1.0 request for atelierd (so node answers unchunked): Host names its loopback listener; the token only when given. */
export function httpRequest({ port, method, path, token, body }) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const head = [`${method} ${path} HTTP/1.0`, `Host: 127.0.0.1:${port}`, "Connection: close"];
  if (token) head.push(`Authorization: Bearer ${token}`);
  if (body !== undefined) head.push("Content-Type: application/json", `Content-Length: ${utf8Length(text)}`);
  return `${head.join("\r\n")}\r\n\r\n${text}`;
}

/** {status, json} from a whole reply (atelierd answers JSON with content-length, no chunking), else null. */
export function parseHttp(text) {
  const m = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  let json = null;
  try { json = JSON.parse(m[2]); } catch {}
  return { status: Number(m[1]), json };
}

/** The id of the first layout block whose content is `mod`, or null. */
export function blockOf(node, mod) {
  if (!node) return null;
  if (node.content?.mod === mod) return node.id;
  for (const c of node.children ?? []) { const id = blockOf(c, mod); if (id) return id; }
  return null;
}

// ---- the canvas's three views ----
// panel: in herdr's side panel. popped: atelier-web's own titled window (its mode event is the truth, so a Dock button
// or closing that window counts too). full: the panel alone in herdr's window: the layout nodes around it hidden with
// layout.hide (herdr has no zoom for a layout block; layout.switch would make a new panel copy and reload the page).
// `full` lists the nodes this hid, to show exactly those again; `seen` once a layout tree shows the chat hidden.

const FULL_HIDES = ["sidebar", "main", "status-row"];
const hiddenIn = (tree, id) => pathTo(tree, id)?.some((n) => n.hidden) ?? null; // null: no such node
const fullShown = (tree) => hiddenIn(tree, "main") === true && Boolean(placement(tree, blockOf(tree, "atelier") ?? "atelier")?.shown);

/** At start: a full screen saved in shared state holds only while the layout still shows it. */
export function initialMode(full, tree) {
  const ok = Array.isArray(full) && full.length > 0 && full.every((id) => typeof id === "string") && fullShown(tree);
  return { popped: false, full: ok ? full : null, seen: ok };
}

export const modeOf = (s) => (s.popped ? "popped" : s.full ? "full" : "panel");

/** One change of view. Actions: full, panel (the strip's way back, Bring back), popOut {frame?}, esc, helper {popped}
 *  (atelier-web's mode event), layout (each tick). Returns the state, atelier-web ops and herdr commands ([name, args]). */
export function modeStep(s, a, tree) {
  const out = (state, ops = [], cmds = []) => ({ state, ops, cmds });
  const unfull = (st) => out({ ...st, full: null, seen: false }, [], (s.full ?? []).map((id) => ["layout.show", { id }]));
  switch (a.type) {
    case "full": {
      if (s.popped || s.full) return out(s);
      const hide = FULL_HIDES.filter((id) => hiddenIn(tree, id) === false);
      return out({ ...s, full: hide, seen: false }, [], hide.map((id) => ["layout.hide", { id }]));
    }
    case "esc": return s.full ? unfull(s) : out(s);
    case "panel": return s.popped ? out(s, [{ op: "attach" }]) : s.full ? unfull(s) : out(s);
    case "popOut": {
      const r = s.full ? unfull(s) : out(s);
      return { ...r, ops: [{ op: "detach", ...(a.frame ? { frame: a.frame } : {}) }] };
    }
    case "helper": {
      const popped = Boolean(a.popped);
      if (popped === s.popped) return out(s);
      if (popped) return s.full ? unfull({ ...s, popped }) : out({ ...s, popped });
      return out({ ...s, popped }, [], [["layout.select", { stack: "panel-body", child: blockOf(tree, "atelier") ?? "atelier" }], ["layout.show", { id: "panel" }]]);
    }
    case "layout": {
      if (!s.full) return out(s);
      const shown = fullShown(tree);
      if (!s.seen) return out(shown ? { ...s, seen: true } : s);
      return shown ? out(s) : unfull(s);
    }
    default: return out(s);
  }
}

// ---- live shots (atelier_shot runner "live") ----
// The shell cannot capture its cross-origin board frames, so it asks the mod, which asks atelier-web for a native
// snapshot of that page rect into its own folder (the only place it may write), <webDir>/shots/<ref>.png; atelierd
// collects the file from there by ref. The answer goes back to the shell through window.__atelierShot.

const SHOT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The helper op for the shell's {type:"snapshot", ref, rect} (page px), or null for a malformed one.
 *  @param {string} webDir @param {any} d */
export function shotOp(webDir, d) {
  const r = d?.rect;
  if (!SHOT_REF.test(d?.ref ?? "") || !r || !["x", "y", "w", "h"].every((k) => Number.isFinite(r[k]))) return null;
  if (r.w < 1 || r.h < 1 || r.w > 8000 || r.h > 8000) return null;
  return { op: "snapshot", ref: `shot:${d.ref}`, path: `${webDir}/shots/${d.ref}.png`, rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
}

/** For atelier-web's {op:"snapshot"} reply to a shotOp: the jsAsync that hands {w, h} or {error} to the shell, else null.
 *  @param {string} id @param {any} m */
export function shotDone(id, m) {
  const ref = typeof m?.ref === "string" && m.ref.startsWith("shot:") ? m.ref.slice(5) : "";
  if (!SHOT_REF.test(ref)) return null;
  const result = m.error !== undefined ? { error: String(m.error).slice(0, 300) } : { w: Number(m.w) || 0, h: Number(m.h) || 0 };
  return { op: "jsAsync", id, ref: `shot-done:${ref}`, code: "return window.__atelierShot ? window.__atelierShot(ref, result) : false", args: { ref, result } };
}
