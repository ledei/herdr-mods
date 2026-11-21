// The shell: opens the canvas, shows a page, keeps the live budget, picks with Select, writes view-state for the
// agents and answers their commands (SSE {type:"cmd"} → the board's bridge → POST /__agent/result).
import * as api from './api.js';
import { createCamera } from './camera.js';
import { createBoards } from './boards.js';
import { createComments } from './comments.js';
import { createScope } from './scope.js';
import { createLayers } from './layers.js';
import { createInspector } from './inspector.js';
import { init as initTweaks } from './tweaks.js';
import { init as initVariants } from './variants.js';
import { init as initCapture } from './capture.js';

const $ = (id) => document.getElementById(id);
const view = $('view'), layer = $('layer');
const RUNNER = window.webkit?.messageHandlers?.atelierShell ? 'live-webkit' : 'live-chrome';
const setState = (state, title, sub = '') => {
  document.body.dataset.state = state;
  if (title !== undefined) $('state').querySelector('.title').textContent = title;
  $('state-sub').textContent = sub;
};

let canvas = null, summary = null, boards = null, camera = null, comments = null, scope = null;
let layers = null, inspector = null, tweaks = null; // T10 layers and inspector, T11 Tweaks (Play)
let variants = null; // T9: variant groups, prop variants, compare, the Versions panel
let capture = null; // T12: marked screenshots, recordings, the tray and its Send
let page; // undefined until the first page is shown; null on a canvas without pages
const cams = new Map(); // page → camera, so a page comes back where it was left
const sel = { boards: new Set(), ids: [], labels: new Map(), el: null }; // el: {board, id, bbox} drawn as the outline
let tool = 'select';

// ---------- view-state: at most one PUT per 600 ms, and only when it changed ----------
let viewTimer = 0, viewLast = 0, viewSent = '';
function viewState() {
  const errs = summary.boards.map((r) => boards.get(r.file)).filter((b) => b?.errors.length);
  const last = sel.ids.at(-1);
  return {
    canvas: canvas.id, mode: tool === 'none' ? 'play' : 'canvas', page, zoom: Math.round(camera.get().s * 100) / 100,
    visibleArtboards: boards.visible().slice(0, 20).map((b) => b.file),
    selectedArtboards: [...sel.boards].slice(0, 20), selected: sel.ids.slice(-20),
    selection: last ? [{ id: last, kind: 'element', label: sel.labels.get(last) || '' }] : [],
    erroredArtboards: errs.slice(0, 10).map((b) => b.file), firstError: errs[0] ? `${errs[0].file}: ${errs[0].errors[0]}`.slice(0, 300) : null,
    dirty: false, // no edits in the shell yet
    scope: scope?.get() ?? null, openComments: comments?.openCount() ?? 0,
    play: tool === 'none' ? played : null, tweaks: tweaks?.get() ?? null,
    targetSession: capture?.target()?.session ?? null, // the agent picked in the strip (its herdr address): atelier-hook
  };
}
function queueView() {
  if (!canvas || viewTimer) return;
  viewTimer = setTimeout(() => {
    viewTimer = 0;
    const body = JSON.stringify(viewState());
    if (body === viewSent) return;
    viewSent = body; viewLast = Date.now();
    api.json('PUT', '/__atelier/view', JSON.parse(body)).catch(() => { viewSent = ''; });
  }, Math.max(0, viewLast + 600 - Date.now()));
}

// ---------- selection ----------
function outline() {
  layer.querySelector('.elsel')?.remove();
  for (const b of boards.shown()) { b.el.classList.toggle('sel', sel.boards.has(b.file) && !sel.el); b.lbl.classList.toggle('sel', sel.boards.has(b.file)); }
  comments?.draw(); scope?.draw(); variants?.draw();
  const e = sel.el, b = e && boards.get(e.board);
  if (!b || b.page !== page || !e.bbox || e.covered || tool === 'none') return;
  const o = document.createElement('div');
  o.className = 'elsel';
  o.style.cssText = `left:${b.x + e.bbox[0]}px;top:${b.y + e.bbox[1]}px;width:${e.bbox[2]}px;height:${e.bbox[3]}px`;
  layer.append(o);
}
function select({ board = null, element = null } = {}) {
  sel.boards = new Set(board ? [board] : []);
  sel.ids = element ? [element.id] : [];
  sel.labels = new Map(element ? [[element.id, element.label]] : []);
  sel.el = element ? { board, id: element.id, bbox: element.bbox } : null;
  outline();
  layers?.show(board, element?.id ?? null); inspector?.show(board && element ? { board, ...element } : null);
  errorCard(board && boards.get(board));
  boards.budget(keep);
  tweaks?.retarget(); playCheck();
  queueView();
}
const keep = (b) => sel.boards.has(b.file);
// Play: the board being played (the selected one, else the first on screen), as Tweaks takes it, and whether it is
// still: from a wait when it becomes the one, then from every agent's wait on it (command()); null until known.
let played = { board: null, settled: null };
const playTarget = () => [...sel.boards][0] || boards.visible()[0]?.file || null;
function playCheck() {
  if (tool !== 'none') return;
  const f = playTarget(), b = f && boards.get(f);
  if (f === played.board) return;
  played = { board: f, settled: null };
  boards.setPlaying(true, f); // its pill says Stop
  if (b?.frame) boards.ask(b, 'wait', { timeoutMs: 3000 }, { ms: 6000 }).then((r) => { if (played.board === f) { played.settled = !!r?.settled; queueView(); } }, () => {});
}
// After a hot swap or an agent's steps the element may have moved, gone, or be under the next screen (or out again).
async function refreshOutline(b) {
  if (!sel.el || sel.el.board !== b.file) return;
  try { const r = await boards.ask(b, 'bbox', { id: sel.el.id }); sel.el.bbox = r?.bbox ?? null; sel.el.covered = !!r?.covered; } catch { sel.el.bbox = null; }
  outline();
}
async function pick(b, e) {
  const r = b.el.getBoundingClientRect(), { s } = camera.get();
  const x = (e.clientX - r.left) / s, y = (e.clientY - r.top) / s;
  if (!b.frame || !b.booted) return select({ board: b.file }); // a snapshot: the board, made live for the next pick
  try {
    const hit = await boards.ask(b, 'at', { x, y }, { ms: 3000 });
    select(hit ? { board: b.file, element: hit } : { board: b.file });
  } catch { select({ board: b.file }); }
}
function errorCard(b) {
  const card = $('errcard');
  card.hidden = !b?.errors.length;
  if (card.hidden) return;
  card.querySelector('b').textContent = b.label;
  const msg = b.errors[0].trim();
  card.querySelector('p').textContent = `${msg}${/[.!?]$/.test(msg) ? '' : '.'} The board still runs. Agents see this error too.`;
}
$('errcard').querySelector('.x').onclick = () => { $('errcard').hidden = true; };

// ---------- pointer: drag pans, a click selects (name strip: the board; inside a board with Select: the element) ----------
let drag = null;
view.addEventListener('pointerdown', (e) => {
  if ((e.button !== 0 && e.button !== 1) || full) return; // Play full screen: the gutter holds the board
  if (e.button === 0 && (tool === 'comment' ? comments.down(e) : tool === 'area' && scope.down(e))) return; // a pin, an area
  drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  view.setPointerCapture(e.pointerId);
});
view.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) { drag.moved = true; view.classList.add('panning'); }
  drag.x = e.clientX; drag.y = e.clientY;
  camera.pan(dx, dy);
});
view.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const moved = drag.moved;
  drag = null;
  view.classList.remove('panning');
  if (moved || e.button !== 0) return;
  const hit = document.elementsFromPoint(e.clientX, e.clientY);
  const lbl = hit.find((n) => n.classList?.contains('lbl')), board = hit.find((n) => n.classList?.contains('board'));
  if (board && hit.some((n) => n.classList?.contains('retry'))) return boards.retryThumb(board.dataset.file);
  if (lbl) return select({ board: lbl.dataset.file });
  if (board && tool === 'select') return pick(boards.get(board.dataset.file), e);
  if (!board) select();
});
view.addEventListener('pointercancel', () => { drag = null; view.classList.remove('panning'); });
document.addEventListener('contextmenu', (e) => e.preventDefault()); // no WebKit Back/Reload menu in the canvas

// ---------- toolbar, pages, zoom, keys ----------
function setTool(t) {
  tool = t;
  document.body.classList.toggle('select', t === 'select');
  document.body.classList.toggle('marking', t === 'comment' || t === 'area'); // the shell takes the clicks, as with Select
  document.body.classList.toggle('commenting', t === 'comment'); // shell.css: the comments panel has the right side
  if (rightPanel(t) && versionsOpen()) versionsButton().click(); // one panel on the right: the last asked for
  for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  comments?.setTool(t === 'comment');
  modeSwitch();
  queueView();
}
const rightPanel = (t) => t === 'comment' || t === 'none'; // tools with a panel on the right: Comments, Tweaks
const versionsButton = () => $('toolbar').querySelector('.tool[aria-label="Versions"]');
const versionsOpen = () => versionsButton()?.getAttribute('aria-pressed') === 'true';
// Versions opened over the comments panel or in Play: back to Select, so it has the right side.
$('toolbar').addEventListener('click', (e) => { if (e.target.closest?.('.tool[aria-label="Versions"]') && versionsOpen() && rightPanel(tool)) setTool('select'); });
// The pressed tool again: Select turns off (Play), Comment and Area go back to Select.
for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.onclick = () => setTool(tool !== b.dataset.tool ? b.dataset.tool : tool === 'select' ? 'none' : 'select');
// ---------- Design / Play ----------
// Play is no shell tool at all: clicks, taps and keys go to the boards. Design brings Select back. Each board's name
// strip has a Play pill (as in Claude Design): its menu plays that board on the canvas or full screen; Stop while it plays.
function modeSwitch() {
  const play = tool === 'none';
  boards?.setPlaying(play, play ? playTarget() : null);
  tweaks?.setOpen(play);
  capture?.setPlaying(play);
  if (boards) outline(); // the element outline is Design's: not over a board being played
  if (play) playCheck(); else { played = { board: null, settled: null }; leaveFull(); }
}
function playBoard(b, whole) {
  if (!sel.boards.has(b.file)) select({ board: b.file }); // the target (playTarget); a picked element in it stays
  setTool('none');
  if (!whole) return;
  full = { b, cam: camera.get(), asked: viewMode !== 'full' };
  document.body.classList.add('playfull');
  b.el.classList.add('solo');
  hide(true);
  camera.hold(true);
  fitSolo();
  if (full.asked) post({ type: 'full' });
}
// Play full screen: the board alone, fitted with an 8 px gutter; the canvas chrome hidden (shell.css body.playfull) and
// herdr's chat too (the mod's full screen, asked only when not in it already). Leaving puts back the camera and the view.
let full = null, viewMode = 'panel';
// Out of reach while hidden: the other boards (their frames still run an agent's steps), every name strip and pill.
const hide = (on) => { for (const n of layer.children) n.inert = on && !n.classList.contains('solo'); };
new MutationObserver(() => { if (full) hide(true); }).observe(layer, { childList: true }); // boards an agent brings in meanwhile
const fitSolo = () => camera.fit(full.b, { pad: 8, top: document.body.classList.contains('popped') ? 44 : 8, bottom: 8, most: 2 });
function leaveFull() {
  if (!full) return;
  const { b, cam, asked } = full;
  full = null;
  document.body.classList.remove('playfull');
  b.el?.classList.remove('solo');
  hide(false);
  camera.hold(false);
  camera.set(cam);
  if (asked && viewMode === 'full') post({ type: 'esc' });
}
// The pill's menu: right under the strip, keys (arrows, Enter, Esc or Tab give the focus back), closed by a click
// elsewhere or in a frame, a camera move or a page switch. Opened by key its first item has the focus; by mouse the menu
// itself, so no item looks picked.
const menu = document.createElement('div');
menu.className = 'pmenu'; menu.setAttribute('role', 'menu'); menu.tabIndex = -1; menu.hidden = true;
document.body.append(menu);
let menuFor = null; // the pill it opened from
addEventListener('resize', () => closeMenu(false)); // placed once, by the pill's place then
function closeMenu(refocus) { if (menu.hidden) return; menu.hidden = true; if (refocus) menuFor?.focus(); menuFor = null; }
function playPill(b, e) {
  if (tool === 'none' && played.board === b.file) return setTool('select'); // Stop
  const pill = b.lbl.querySelector('.play');
  if (menuFor === pill) return closeMenu(true);
  menuFor = pill;
  menu.setAttribute('aria-label', `Play ${b.label}`);
  menu.replaceChildren(...[['Play on canvas', false], ['Play full screen', true]].map(([text, whole]) => {
    const i = document.createElement('button');
    i.type = 'button'; i.tabIndex = -1; i.setAttribute('role', 'menuitem'); i.textContent = text;
    i.onclick = () => { closeMenu(false); playBoard(b, whole); };
    return i;
  }));
  const r = pill.firstChild.getBoundingClientRect();
  menu.style.cssText = `top:${b.lbl.getBoundingClientRect().bottom}px;right:${Math.max(8, innerWidth - r.right)}px`;
  menu.hidden = false;
  (e?.detail === 0 ? menu.firstChild : menu).focus();
}
menu.addEventListener('keydown', (e) => {
  const items = [...menu.children], n = items.length, down = e.key === 'ArrowDown';
  const i = items.indexOf(document.activeElement), from = i < 0 && !down ? 0 : i; // from none: Down the first, Up the last
  if (down || e.key === 'ArrowUp') items[(from + (down ? 1 : n - 1)) % n].focus();
  else if (e.key === 'Escape' || e.key === 'Tab') closeMenu(true); // the focus back on the pill
  else return;
  e.preventDefault(); e.stopPropagation();
});
addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target.closest?.('.play') !== menuFor) closeMenu(false); }, true);
addEventListener('blur', () => closeMenu(false)); // a click in a board's frame
// Room at the top for the page tabs and the page title (22 px, screen-sized, above the name strips).
const fitPage = (animate) => camera.fit(boards.bounds(), { animate, top: ($('pages').hidden ? 16 : 56) + 64 });
const pageTitle = (pid) => (summary.pages?.length ? (summary.pages.find((p) => p.id === pid)?.name || pid) : summary.title) || '';
$('zoom').onclick = () => fitPage(true);
// Esc (here or in a board) clears a selection; with none, it goes to the mod (full screen: the chat comes back).
// An open comment or an unlocked area goes first; a locked scope stays (it has its own unlock button).
// Play full screen: Esc stops it, back to Design and the view it came from.
const esc = () => { if (comments?.escape() || scope?.escape()) return; if (full) setTool('select'); else if (sel.boards.size || sel.ids.length) select(); else post({ type: 'esc' }); };
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.key === 'Escape') return esc();
  if (!boards) return;
  if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey) setTool(tool === 'select' ? 'none' : 'select');
  else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) setTool(tool === 'comment' ? 'select' : 'comment');
  else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) setTool(tool === 'area' ? 'select' : 'area');
  else if (e.key === '!' && e.shiftKey && !full) fitPage(true);
});
function tabs() {
  const nav = $('pages'), pages = summary.pages || [];
  nav.hidden = pages.length < 2;
  nav.replaceChildren(...pages.map((p) => {
    const t = document.createElement('button');
    t.className = 'ghost'; t.type = 'button'; t.setAttribute('role', 'tab'); t.dataset.page = p.id;
    t.textContent = p.name || p.id;
    t.setAttribute('aria-selected', String(p.id === page));
    t.onclick = () => showPage(p.id);
    return t;
  }));
}

// ---------- pages ----------
function showPage(pid, focus) {
  if (page !== undefined) cams.set(page, camera.get());
  page = pid;
  closeMenu(false);
  Object.assign(sel, { boards: new Set(), ids: [], labels: new Map(), el: null });
  outline(); // clears the ring on the page that goes
  layers?.show(null); inspector?.show(null);
  errorCard(null);
  const first = summary.pages?.[0]?.id ?? null;
  boards.showPage(pid, summary.notes, first, pageTitle(pid));
  tabs();
  const f = focus && boards.get(focus);
  if (f) camera.fit({ x: f.x, y: f.y - 30, w: f.w, h: f.h + 30 });
  else if (cams.has(pid)) camera.set(cams.get(pid));
  else fitPage(false);
  boards.budget(keep); // first: the boards going live take their snapshots last
  boards.wantThumbs();
  comments.draw(); scope.draw(); variants.draw(); // the page's pins and scope (showPage cleared the layer)
  queueView();
}

// ---------- events from atelierd ----------
async function onEvent(ev) {
  if (ev.canvas && ev.canvas !== canvas.id) return;
  variants.onEvent(ev); // groups, compare, a board file changed
  if (ev.type === 'cmd') return command(ev);
  if (ev.type === 'props') return tweaks.refresh(ev.board); // an agent's atelier_props set or reset
  if (ev.type === 'thumb') return ev.error ? boards.thumbFailed(ev.file) : boards.thumbReady(ev.file);
  if (ev.type === 'comments') return comments.reload();
  if (ev.type !== 'file') return;
  if (ev.file === 'canvas.json') return reloadCanvas();
  if (ev.file.endsWith('.dc.html')) comments.fileChanged(ev.file);
  await boards.fileChanged(ev.file);
}
// An agent's command for one board: forwarded to its bridge (live first, over the budget if need be), answered with the runner.
async function command(ev) {
  if (ev.op === 'shot') return liveShot(ev);
  if (ev.op === 'frames') return capture.frames(ev); // atelier_record live: native frames
  const { board, ...args } = ev.args && typeof ev.args === 'object' ? ev.args : {};
  let out;
  try {
    const b = typeof board === 'string' ? boards.get(board) : null;
    if (!b) throw new Error(board ? `no board ${board} on this canvas` : 'args.board is required');
    const ms = Number.isFinite(ev.ms) ? Math.min(Math.max(ev.ms, 1), 60000) : 15000; // the server stops waiting after ms
    const r = await boards.ask(b, ev.op, args, { pin: true, ms });
    out = { id: ev.id, result: r && typeof r === 'object' && !Array.isArray(r) ? { ...r, runner: RUNNER } : r };
    if (['play', 'state', 'wait'].includes(ev.op)) refreshOutline(b); // an agent's steps change the board under the outline
    if (ev.op === 'wait' && board === played.board && typeof r?.settled === 'boolean' && played.settled !== r.settled) { played.settled = r.settled; queueView(); }
  } catch (e) { out = { id: ev.id, error: String(e.message || e) }; }
  api.json('POST', '/__agent/result', out).catch(() => {});
}
// ---------- live shots ----------
// atelier_shot on the live board: wait in the board until it is still, then a native snapshot of its rect on screen.
// The page cannot capture a cross-origin frame, so the mod asks atelier-web (into its shots folder, named by ref,
// where atelierd collects it); window.__atelierShot(ref, {w, h} | {error}) brings the answer back.
const shots = new Map(); // ref → resolve
window.__atelierShot = (ref, r) => { const done = shots.get(ref); shots.delete(ref); done?.(r); return !!done; };
async function liveShot(ev) {
  const { board, ref, id, region, force, timeoutMs } = ev.args && typeof ev.args === 'object' ? ev.args : {};
  let out;
  let hide = [];
  try {
    const b = typeof board === 'string' ? boards.get(board) : null;
    if (!b) throw new Error(board ? `no board ${board} on this canvas` : 'args.board is required');
    if (!window.webkit?.messageHandlers?.atelierShell) throw new Error('live shots need the native view in herdr; use runner "headless"');
    if (typeof ref !== 'string' || !/^[0-9a-f-]{36}$/.test(ref)) throw new Error('bad shot ref');
    const ms = Math.min(Math.max(Number(timeoutMs) || 5000, 300), 20000);
    const w = await boards.ask(b, 'wait', { timeoutMs: ms }, { pin: true, ms: ms + 3000 });
    if (!w.settled && !force) { out = { id: ev.id, result: { ...w, runner: RUNNER } }; return; } // atelierd refuses it
    let box = [0, 0, b.w, b.h];
    if (typeof id === 'string') { const r = await boards.ask(b, 'bbox', { id }, { pin: true, ms: 5000 }); if (!r) throw new Error('no rendered element with that id'); box = r.bbox; }
    else if (region) box = [region.x, region.y, region.w, region.h];
    const r = b.el.getBoundingClientRect(), s = r.width / b.w;
    // Whole pixels inside the board's edges: a half-covered edge pixel would blend in whatever is beside the board.
    const l = r.left + box[0] * s, t = r.top + box[1] * s, x = Math.ceil(l), y = Math.ceil(t);
    const rect = { x, y, w: Math.floor(l + box[2] * s) - x, h: Math.floor(t + box[3] * s) - y };
    if (b.page !== page || rect.w < 1 || rect.h < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > innerWidth || rect.y + rect.h > innerHeight) {
      throw new Error('that part of the board is not fully on screen in Atelier; bring it into view, or use runner "headless"');
    }
    // The canvas chrome stays out of the picture: toolbar, tabs, outline, comment pins, scope, comments panel, toasts.
    hide = [$('toolbar'), $('pages'), $('zoom'), $('errcard'), layer.querySelector('.elsel'), ...document.querySelectorAll('.marks, .cpanel, .ctoast, .lpanel, .ipanel, .lfold, .tweaks, .vmarks, .vpanel, .cap-tray, .cap-toast')].filter(Boolean);
    for (const n of hide) n.style.visibility = 'hidden';
    const snap = await new Promise((ok, no) => {
      const t = setTimeout(() => { shots.delete(ref); no(new Error('the native snapshot did not answer')); }, 10000);
      shots.set(ref, (x) => { clearTimeout(t); ok(x); });
      post({ type: 'snapshot', ref, rect });
    });
    if (snap?.error) throw new Error(`native snapshot: ${snap.error}`);
    out = { id: ev.id, result: { settled: w.settled, ms: w.ms, running: w.running, scale: Math.round(s * 1000) / 1000, runner: RUNNER } };
  } catch (e) { out = { id: ev.id, error: String(e.message || e) }; } finally {
    for (const n of hide) n.style.visibility = '';
    api.json('POST', '/__agent/result', out).catch(() => {});
  }
}
// canvas.json changed (a board moved, added, removed): the page stays as it is, live boards keep running.
async function reloadCanvas() {
  summary = await api.json('GET', `/__atelier/canvas?canvas=${encodeURIComponent(canvas.id)}`);
  boards.setBoards(summary.boards);
  const first = summary.pages?.[0]?.id ?? null;
  if (summary.pages?.length && !summary.pages.some((p) => p.id === page)) return showPage(first);
  boards.showPage(page, summary.notes, first, pageTitle(page));
  tabs();
  if ([...sel.boards].some((f) => boards.get(f)?.page !== page)) select(); // removed or archived: no longer there to select
  outline();
  boards.wantThumbs();
  boards.budget(keep);
  variants.reload(); // groups.json changes with canvas.json (ops.variant)
  queueView();
}

// ---------- views: the mod says where the page is shown ('panel' | 'popped' | 'full') ----------
// Popped out, the page is a window of its own that herdr does not draw around: it draws a strip with a Dock button.
function post(m) { try { window.webkit?.messageHandlers?.atelierShell?.postMessage(m); } catch {} }
const popstrip = document.createElement('header');
popstrip.id = 'popstrip';
popstrip.innerHTML = '<span class="dim small">Atelier</span><button class="ghost" type="button" title="Back into the herdr panel">'
  + '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>Dock</button>';
popstrip.querySelector('button').onclick = () => post({ type: 'dock' });
document.body.prepend(popstrip);
window.__atelierMode = (mode) => {
  document.body.classList.toggle('popped', mode === 'popped');
  const was = viewMode;
  viewMode = mode;
  if (full && was === 'full' && mode !== 'full') setTool('select'); // herdr left its full screen (its own Esc): Play full screen ends
};

// ---------- start ----------
// The mod hands the token over once this page loaded (again after every reload): __atelierInit(token) → true, once.
// Nothing reaches atelierd before it.
window.__atelierInit = (t) => {
  if (typeof t !== 'string' || !t) return false;
  delete window.__atelierInit;
  api.setToken(t);
  main().catch((e) => { setState('error', 'Atelier could not open this canvas', String(e.message || e)); });
  return true;
};
if (!api.params.canvas) {
  setState('empty');
  $('state').replaceChildren($('empty-state').content.cloneNode(true));
}
async function main() {
  if (!api.params.canvas) return;
  const { canvases } = await api.json('GET', '/__atelier/canvases');
  const known = canvases.find((c) => c.id === api.params.canvas);
  if (!known) throw new Error('This canvas is not known to Atelier. Open it again from the canvas button.');
  canvas = await api.json('POST', '/__atelier/open', { path: known.path });
  summary = await api.json('GET', `/__atelier/canvas?canvas=${encodeURIComponent(canvas.id)}`);
  const n = summary.boards.filter((b) => b.file.endsWith('.dc.html')).length;
  setState('starting', 'Starting Atelier…', `Loading ${n} board${n === 1 ? '' : 's'}`);
  api.events(canvas.id, onEvent, () => boards.wantThumbs({ retry: true }));

  camera = createCamera(view, layer, {
    onMove: () => closeMenu(false), // the menu would stay where the pill was
    onZoom: (s) => { $('zoom').textContent = `${Math.round(s * 100)}%`; boards.zoomed(s); },
    onSettle: () => { boards.budget(keep); boards.wantThumbs(); tweaks?.retarget(); playCheck(); queueView(); },
  });
  boards = createBoards({
    layer, canvas: canvas.id, boardsUrl: canvas.boards, camera,
    onChange: (kind, b, e) => {
      if (kind === 'esc') esc();
      if (kind === 'play') playPill(b, e);
      if (kind === 'errors') { if (sel.boards.has(b.file)) errorCard(b); queueView(); }
      if (kind === 'swapped' || (kind === 'live' && b.booted)) { refreshOutline(b); comments.refresh(b); scope.refresh(b); layers.refresh(b.file); inspector.refresh(b.file); }
      if (kind === 'live' && b.booted) tweaks.live(b); // its Tweaks and motion come back to a frame that loaded again
      if (kind === 'swapped') tweaks.refresh(b.file);
      if (kind === 'painted' && document.body.dataset.state === 'starting' && boards.painted()) ready();
    },
  });
  const shown = () => page;
  comments = createComments({ layer, canvas: canvas.id, boards, camera, page: shown,
    focus: (file) => { const b = boards.get(file); if (b && b.page !== page) showPage(b.page, file); },
    onChange: (kind) => { if (kind === 'tool') setTool('comment'); else { badge(); queueView(); } } });
  scope = createScope({ layer, canvas: canvas.id, boards, camera, page: shown, onChange: queueView,
    selection: () => (sel.el ? { kind: 'element', board: sel.el.board, id: sel.el.id, bbox: sel.el.bbox, label: sel.labels.get(sel.el.id) } : sel.boards.size ? { kind: 'board', board: [...sel.boards][0] } : null) });
  layers = createLayers({ layer, canvas: canvas.id, boards, page: shown, select });
  inspector = createInspector({ canvas: canvas.id });
  tweaks = initTweaks({ api, boards, canvas: canvas.id, target: playTarget, onChange: queueView });
  variants = initVariants({ layer, canvas: canvas.id, boardsUrl: canvas.boards, boards, camera, page: shown, showPage,
    selected: () => (sel.boards.size === 1 ? [...sel.boards][0] : null), select: (file) => select({ board: file }), tell: post });
  capture = initCapture({ api, boards, camera, layer, canvas: canvas.id, post, onChange: queueView,
    selection: () => (sel.boards.size ? { board: [...sel.boards][0] } : null) });
  await scope.restore(); // before the first view-state write, which would drop it
  boards.setBoards(summary.boards);
  const focus = api.params.board && boards.get(api.params.board);
  showPage(focus ? focus.page : summary.pages?.[0]?.id ?? null, focus?.file);
  $('toolbar').hidden = false; $('zoom').hidden = false;
  setTool('select');
  comments.reload();
  if (boards.painted()) ready();
  setTimeout(ready, 4000); // never hide the canvas behind the spinner for long
  addEventListener('resize', () => { if (full) fitSolo(); boards.budget(keep); queueView(); });
}
// The Comment tool's open count.
function badge() {
  const n = comments.openCount(), k = $('toolbar').querySelector('[data-tool="comment"] .count');
  k.textContent = n > 99 ? '99+' : String(n);
  k.hidden = n === 0;
}
function ready() {
  if (document.body.dataset.state !== 'starting') return;
  setState('ready');
  performance.mark('atelier-painted'); // tests read it: every visible board shows its snapshot or its placeholder
}
