// The boards of one canvas: their elements on the layer, snapshots (<img> from /__atelier/thumb), the live budget
// (at most LIVE iframes, agents' boards included) and the bridge in each live frame. Each frame has its own origin on
// the boards port (boardUrl); messages go to that frame's origin only, and only messages from it are heard.
// A frame never moves in the DOM: moving an iframe reloads it (WebKit has no moveBefore). So a board an agent uses off
// this page keeps its element on the layer, hidden (.off) at the view's corner, and shows in place when its page opens.
import * as api from './api.js';
import { own } from './scope.js';

const LIVE = 6, LOADING = 3, THUMBS = 6, LOAD_ZONE = 700, KEEP_ZONE = 1700, PIN_MS = 30000, THUMB_WAIT = 40000, RETRY_MS = 5000;
const stem = (f) => f.replace(/\.dc\.html$/, '');
const PILL = { // the strip's Play pill: icon and word (uppercase in shell.css)
  Play: '<span class="pp"><svg class="ico" viewBox="5 3 15 18" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg>Play</span>',
  Stop: '<span class="pp"><svg class="ico" viewBox="4 4 16 16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg>Stop</span>',
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** layer: the transformed layer; onChange(kind, board): 'live' | 'errors' | 'swapped' | 'painted' | 'esc' (pressed in a board)
 *  | 'play' (its strip's Play pill). */
// Each board frame gets its own origin, <key>.localhost on the boards port (it resolves to loopback), so one board's
// script cannot reach into another's frame and post as it. key: the board's file, plus the version for a variant.
// atelierd serves a board's document only on the origin made for it (server/boards.mjs boardLabel, the same hash).
export function boardUrl(boardsUrl, file, key = file) {
  const u = new URL(boardsUrl);
  return `${u.protocol}//b${boardLabel(u.pathname, key)}.localhost:${u.port}${u.pathname}${encodeURIComponent(file)}`;
}
/** FNV-1a 64 of "<canvas path>|<key>", base 36: the label of a board's origin. */
export function boardLabel(pathname, key) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${pathname}|${key}`)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(36);
}

export function createBoards({ layer, canvas, boardsUrl, camera, onChange }) {
  const all = new Map(); // file → board
  let page = null, shown = [], loading = 0, reloads = 0, zoom = 1;
  const loadQ = [], waiting = new Map();
  const askQ = []; // agent asks waiting for a live slot: all LIVE are held by boards with an agent ask in flight
  let asks = 0; // orders agent asks (Date.now() ties within a ms)
  const thumbQ = [];
  // file → {timer, ended}: a snapshot slot, from the ask to the render's "thumb" event. By file, not board: the board
  // may be replaced (moved to another page) or gone by then.
  const slots = new Map();
  let keep = () => false;

  // ---------- model and elements ----------
  // The boards from the canvas summary. Again after a canvas.json change: boards that stay keep their frame (and its
  // state) and only move or resize; one that left this page or the canvas goes.
  function setBoards(list) {
    const next = new Map(list.filter((r) => r.file.endsWith('.dc.html')).map((r) => [r.file, r]));
    for (const [file, b] of all) {
      const r = next.get(file);
      if (r && r.page === b.page) {
        if (r.w !== b.w || r.h !== b.h) { b.needThumb = true; b.thumbFails = 0; } // the snapshot is keyed by size too
        Object.assign(b, { x: r.x, y: r.y, w: r.w, h: r.h, title: r.title, missing: r.missing });
        if (b.el) place(b);
        continue;
      }
      drop(b); b.el?.remove(); b.lbl?.remove(); all.delete(file); free(file);
      for (const q of askQ.filter((q) => q.b === b)) { askQ.splice(askQ.indexOf(q), 1); q.fail('the board was unloaded'); }
    }
    for (const r of next.values()) if (!all.has(r.file)) {
      all.set(r.file, { ...r, label: stem(r.file), frame: null, booted: false, loaded: null, pinned: 0, asked: 0, agents: 0, errors: [], thumbUrl: null, needThumb: true, thumbFails: 0, el: null, lbl: null });
    }
  }
  function place(b) {
    if (b.page !== page) { // off this page: at the view's top-left corner, where a frame keeps running
      const { s, tx, ty } = camera.get();
      b.el.style.cssText = `left:${-tx / s}px;top:${-ty / s}px;width:${b.w}px;height:${b.h}px`;
    } else {
      b.el.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
      b.lbl.style.cssText = `left:${b.x}px;top:${b.y}px;--w:${b.w}`;
    }
    b.el.classList.toggle('off', b.page !== page);
    mark(b);
  }
  function build(b) {
    const d = el('div', 'board');
    d.dataset.file = b.file;
    const img = el('img');
    img.alt = ''; img.decoding = 'async'; img.draggable = false;
    const ph = el('div', 'ph');
    const fail = el('span', 'fail', 'Snapshot failed · ');
    fail.append(el('span', 'retry', 'Retry'));
    ph.append(el('span', '', b.missing ? `${b.label} (file missing)` : b.label), fail);
    d.append(img, ph);
    const l = el('div', 'lbl');
    l.dataset.file = b.file;
    const bad = el('span', 'bad', '!');
    bad.setAttribute('aria-label', 'Board error');
    const play = own(el('button', 'play')); // main.js opens its menu, or stops
    play.type = 'button';
    play.onclick = (e) => onChange('play', b, e); // e.detail 0: by key
    l.append(el('span', 'dot'), el('span', 't', b.label), el('span', 'k'), bad, play);
    l.title = b.title || b.file;
    b.el = d; b.lbl = l; b.img = img;
    if (b.thumbUrl) { img.src = b.thumbUrl; d.classList.add('thumb'); }
    place(b);
  }
  function mark(b) { // the name strip: live dot, "live" or "snapshot · w × h", error badge
    if (!b.lbl) return;
    const live = !!b.frame && b.booted;
    b.el.classList.toggle('live', live);
    b.lbl.classList.toggle('live', live);
    b.lbl.classList.toggle('err', b.errors.length > 0);
    b.lbl.querySelector('.k').textContent = live ? (playing ? `playing · ${Math.round(zoom * 100)}%` : 'live') : `snapshot${b.w === 390 && b.h === 844 ? '' : ` · ${b.w} × ${b.h}`}`;
    b.lbl.querySelector('.bad').title = b.errors[0] || '';
    const stop = playing && played === b.file, p = b.lbl.querySelector('.play');
    if (p.dataset.on === String(stop)) return;
    p.dataset.on = String(stop);
    p.innerHTML = PILL[stop ? 'Stop' : 'Play'];
    p.setAttribute('aria-label', `${stop ? 'Stop' : 'Play'} ${b.label}`);
    if (stop) p.removeAttribute('aria-haspopup'); else p.setAttribute('aria-haspopup', 'menu');
  }

  // Shows page pid: its title, notes and boards. Another page: its frames go, except an agent's (pinned), which stay
  // hidden on the layer. The same page again (canvas.json changed): boards already there stay.
  function showPage(pid, notes, firstPage, title) {
    if (pid !== page) {
      const now = Date.now();
      for (const b of all.values()) if (b.frame && !(b.pinned > now) && !b.agents) drop(b);
      for (const n of [...layer.children]) {
        const held = n.classList.contains('board') && all.get(n.dataset.file).frame; // removing it would end its frame
        if (!held) n.remove();
      }
    } else for (const n of layer.querySelectorAll('.note, .ptitle')) n.remove();
    page = pid;
    layer.prepend(...Object.values(notes || {}).filter((n) => (n.page ?? firstPage) === pid).map(noteEl));
    shown = [...all.values()].filter((b) => b.page === pid);
    for (const b of shown) {
      if (!b.el) build(b);
      if (!b.thumbUrl) b.needThumb = true;
      if (!b.el.isConnected) layer.append(b.el); // never re-append a connected board: that would reload its frame
      if (!b.lbl.isConnected) layer.append(b.lbl);
    }
    for (const b of all.values()) if (b.el?.isConnected) place(b); // a held or re-added board comes out of hiding, or goes into it
    if (title) {
      const t = el('div', 'ptitle', title), r = bounds(false);
      t.style.cssText = `left:${r.x}px;top:${r.y}px`;
      layer.prepend(t);
    }
  }
  function noteEl(n) {
    const d = el('div', `note ${n.kind === 'title1' ? 't1' : 'st'}`, n.text || '');
    // Same sizing as the Studio canvas: a title fits its maxW, 44-72 px.
    const base = { s: 14, m: 20, l: 28, xl: 40, xxl: 56 }[n.size] || (n.size > 0 ? n.size : n.kind === 'title1' ? 72 : 18), W = n.maxW || 1200;
    const size = n.kind === 'title1' ? Math.max(44, Math.min(base, Math.floor((W * 1.6) / Math.max(8, (n.text || '').length)))) : base;
    d.style.cssText = `left:${n.x || 0}px;top:${n.y || 0}px;font-size:${size}px;${n.kind === 'title1' ? `width:${W}px` : n.w ? `width:${n.w}px` : ''}`;
    d.dataset.size = size;
    d.classList.toggle('tiny', tiny(size));
    return d;
  }
  // Notes hide below 25% zoom once their text would be under 9 px on screen (as in Claude Design); only on a change.
  const tiny = (size) => zoom < 0.25 && size * zoom < 9;
  function zoomed(s) {
    if (s === zoom) return;
    zoom = s;
    for (const n of layer.querySelectorAll('.note')) n.classList.toggle('tiny', tiny(n.dataset.size));
    if (playing) for (const b of shown) mark(b);
  }
  // Play mode: live boards say "playing · <zoom>" in their name strip; the played board's pill says Stop.
  let playing = false, played = null;
  function setPlaying(on, file = null) { playing = !!on; played = file; for (const b of shown) mark(b); }
  // Page bounds in canvas px (boards, with their name strips when strips is set, and notes), for the first view of a
  // page and the title's place.
  function bounds(strips = true) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
    const lbl = strips ? 30 : 0;
    for (const b of shown) grow(b.x, b.y - lbl, b.w, b.h + lbl);
    for (const n of layer.querySelectorAll('.note')) grow(parseFloat(n.style.left), parseFloat(n.style.top), n.offsetWidth, n.offsetHeight);
    return x0 === Infinity ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- where boards are on screen ----------
  function onScreen(list = shown) {
    const { s, tx, ty } = camera.get(), { W, H } = camera.size();
    return list.map((b) => {
      const l = tx + b.x * s, t = ty + b.y * s, r = l + b.w * s, bt = t + b.h * s;
      return { b, gap: Math.max(0, -r, l - W) + Math.max(0, -bt, t - H), d: Math.hypot((l + r) / 2 - W / 2, (t + bt) / 2 - H / 2) };
    });
  }
  const visible = () => onScreen().filter((v) => v.gap === 0).sort((a, z) => a.d - z.d).map((v) => v.b);

  // ---------- the live budget ----------
  // Frames that are not boards (variants.js's prop variants and compare board, on this page) take live slots too:
  // extra(key, {x, y, w, h, want, live(on)}) adds one (null removes it). live(on) is called when it gains or loses its
  // slot; want (asked for: Show live, a compare just opened) ranks it with the selection.
  const extras = new Map();
  function extra(key, x) {
    const was = extras.get(key);
    if (was && was !== x && was.on) { was.on = false; was.live(false); }
    if (x) extras.set(key, x); else extras.delete(key);
  }
  // prefer(b): boards to keep live first (the selection); remembered for later passes. Pinned boards (an agent is
  // using them) come first and count: beyond LIVE the least recently asked lose their pin, never one with an agent ask
  // in flight (ask() keeps those at most LIVE).
  function budget(prefer = keep) {
    keep = prefer;
    const now = Date.now(), want = new Set();
    for (const b of all.values()) if (!(b.pinned > now) && !b.agents) b.pinned = 0;
    const pins = [...all.values()].filter((b) => b.pinned).sort((a, z) => (z.agents > 0) - (a.agents > 0) || z.asked - a.asked);
    for (const b of pins.slice(LIVE)) b.pinned = 0;
    for (const b of pins.slice(0, LIVE)) want.add(b);
    // Show live (want) ranks an extra with the selection only while it is on screen, and ends once it is far away.
    const xs = [...extras.values()], held = (b) => b.frame || b.on;
    const first = ({ b, gap }) => (xs.includes(b) ? !!b.want && gap === 0 : !!keep(b));
    const near = [...onScreen(), ...onScreen(xs)];
    for (const { b, gap } of near) if (b.want && xs.includes(b) && gap > KEEP_ZONE) b.want = false;
    const cand = near.filter((v) => !v.b.missing && !want.has(v.b))
      .sort((a, z) => (first(z) - first(a)) || (a.gap - z.gap) || (a.d - z.d));
    for (const v of cand) {
      if (want.size >= LIVE) break;
      if (first(v) || v.gap <= LOAD_ZONE || (held(v.b) && v.gap <= KEEP_ZONE)) want.add(v.b);
    }
    for (const b of all.values()) if (want.has(b)) live(b); else if (b.frame) drop(b);
    for (const x of xs) if (want.has(x) !== !!x.on) { x.on = want.has(x); x.live(x.on); }
    for (const b of all.values()) if (b.frame && b.page !== page) place(b); // follow the view
    pump();
  }
  const srcOf = (b) => `${boardUrl(boardsUrl, b.file)}${reloads ? `?r=${reloads}` : ''}`;
  const originOf = (b) => new URL(boardUrl(boardsUrl, b.file)).origin;
  function live(b) {
    if (b.frame) return;
    if (!b.el) build(b);
    if (!b.el.isConnected) layer.append(b.el); // off this page: hidden at the view's corner (place)
    const f = el('iframe');
    f.title = b.label;
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'); // never navigates the shell
    b.frame = f; b.booted = false;
    watchLoad(b);
    b.el.append(f);
    loadQ.push(b);
  }
  function pump() {
    while (loading < LOADING && loadQ.length) {
      const b = loadQ.shift();
      if (!b.frame || b.frame.src) continue;
      loading++;
      const f = b.frame;
      let done = false;
      const end = b.endLoad = () => { if (done) return; done = true; loading--; pump(); };
      b.loaded.then(() => setTimeout(end, 4000)); // or sooner: __dc_booted, or drop
      setTimeout(end, 15000);
      f.src = srcOf(b);
    }
  }
  // b.loaded resolves on the board's load (not the about:blank a frame without src fires on insertion). A board
  // without the dc runtime never says it booted: it counts as live 4 s later.
  function watchLoad(b) {
    const f = b.frame;
    b.loaded = new Promise((r) => f.addEventListener('load', function on() {
      if (!f.getAttribute('src')) return;
      f.removeEventListener('load', on);
      r();
      setTimeout(() => { if (b.frame === f && !b.booted) { b.booted = true; mark(b); onChange('live', b); } }, 4000);
    }));
  }
  function drop(b) {
    if (!b.frame) return;
    for (const [id, w] of waiting) if (w.b === b) { waiting.delete(id); w.done({ error: 'the board was unloaded' }); }
    const end = b.endLoad;
    b.endLoad = null;
    b.frame.remove();
    b.frame = null; b.booted = false; b.loaded = null; b.pinned = 0;
    if (b.page !== page) b.el?.remove(); // a held board off this page goes with its frame
    mark(b);
    onChange('live', b);
    end?.(); // its load slot is free now
  }
  function reload(b) {
    if (!b.frame) return;
    b.booted = false; mark(b);
    watchLoad(b);
    reloads++;
    b.frame.src = srcOf(b);
  }

  // ---------- the bridge ----------
  const byWindow = (w) => { for (const b of all.values()) if (b.frame?.contentWindow === w) return b; return null; };
  addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    const b = byWindow(e.source), m = e.data;
    if (!b || e.origin !== originOf(b)) return;
    if (m.__atelier === 'res') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w.done(m); } return; }
    if (m.__atelier === 'esc') return onChange('esc', b);
    if (m.__atelier !== 'event') return;
    if (m.type === '__dc_booted') {
      b.booted = true; b.endLoad?.(); mark(b); onChange('live', b);
      ask(b, 'status', {}).then((st) => setErrors(b, st.renderErrors, st.consoleErrors), () => {});
    } else if (m.type === '__dc_render_errors' && Array.isArray(m.errors)) setErrors(b, m.errors, b.consoleErr);
  });
  // Render errors (pushed by the bridge) and console errors (read with status once it booted), up to 10.
  function setErrors(b, render = [], consoleErr = []) {
    b.consoleErr = consoleErr;
    const next = [...new Set([...render, ...consoleErr].map((t) => String(t).slice(0, 300)))].slice(0, 10);
    if (JSON.stringify(next) === JSON.stringify(b.errors)) return;
    b.errors = next; mark(b); onChange('errors', b);
  }
  // One request to the board's bridge; with pin (an agent's request) the board is made live first, pinned as the most
  // recently asked. It waits from the start, so dropping a board that still loads fails it at once; ms counts from the load.
  // An agent ask that would need a 7th board while LIVE boards have one in flight waits its turn (first in, first out),
  // at most ms, the server's timeout for that cmd.
  function ask(b, op, args, { pin = false, ms = 60000 } = {}) {
    if (!pin) return request(b, op, args, ms);
    if (!askQ.length && room(b)) return agentAsk(b, op, args, ms);
    return new Promise((ok, no) => {
      const end = Date.now() + ms; // the caller's deadline covers the wait: an ask the server gave up on never runs
      const q = { b, go: () => { clearTimeout(t); agentAsk(b, op, args, Math.max(end - Date.now(), 1)).then(ok, no); }, fail: (e) => { clearTimeout(t); no(new Error(e)); } };
      const t = setTimeout(() => { askQ.splice(askQ.indexOf(q), 1); no(new Error('no live slot came free')); }, ms);
      askQ.push(q);
    });
  }
  const room = (b) => b.agents > 0 || [...all.values()].filter((x) => x.agents).length < LIVE;
  function nextAsk() { while (askQ.length && room(askQ[0].b)) askQ.shift().go(); }
  function agentAsk(b, op, args, ms) {
    b.agents++; b.asked = ++asks; b.pinned = Date.now() + PIN_MS;
    budget(); setTimeout(() => budget(), PIN_MS + 50);
    return request(b, op, args, ms).finally(() => { b.agents--; nextAsk(); });
  }
  async function request(b, op, args, ms) {
    const f = b.frame;
    if (!f) throw new Error('the board is not live');
    const id = crypto.randomUUID();
    return new Promise((ok, no) => {
      let t = 0;
      waiting.set(id, { b, done: (m) => { clearTimeout(t); m.error !== undefined ? no(new Error(m.error)) : ok(m.result); } });
      b.loaded.then(() => {
        if (!waiting.has(id) || b.frame !== f) return;
        t = setTimeout(() => { waiting.delete(id); no(new Error('the board did not answer')); }, ms);
        f.contentWindow.postMessage({ __atelier: 'req', id, op, args }, originOf(b));
      });
    });
  }

  // ---------- snapshots ----------
  // Asks for the snapshots the shown boards need (none yet, rendered since, or the file changed), a few at a time,
  // nearest the view centre first and live boards last. A slot stays taken while atelierd renders (until its "thumb"
  // event), so the next pick follows the view as it is then. retry: also those still without one (an SSE event may
  // have been missed).
  function wantThumbs({ retry = false } = {}) {
    if (retry) for (const file of slots.keys()) rendered(file); // their events may be among the missed ones
    for (const b of shown) if (!b.missing && !slots.has(b.file) && !thumbQ.includes(b) && (b.needThumb || (retry && !b.thumbUrl))) { b.needThumb = false; thumbQ.push(b); }
    nextThumb();
  }
  function nextThumb() {
    if (slots.size >= THUMBS || !thumbQ.length) return;
    const rank = new Map(onScreen().map((v) => [v.b, v]));
    const key = (b) => { const v = rank.get(b); return v ? [b.frame ? 1 : 0, v.gap, v.d] : [2, 0, 0]; };
    thumbQ.sort((a, z) => { const p = key(a), q = key(z); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
    while (slots.size < THUMBS && thumbQ.length) {
      const b = thumbQ.shift();
      if (all.get(b.file) !== b) continue; // gone from the canvas, or replaced
      if (b.page !== page) { b.needThumb = true; continue; } // asked again when its page opens
      fetchThumb(b);
    }
  }
  function fetchThumb(b) {
    const s = { timer: 0, ended: false };
    slots.set(b.file, s);
    api.thumb(canvas, b.file).then(async (blob) => {
      // The slot waits for the "thumb" event, unless it came before this answer did (or the board went).
      // No event in THUMB_WAIT: asked again as if it came.
      if (!blob) { if (!s.ended && slots.get(b.file) === s) s.timer = setTimeout(() => thumbReady(b.file), THUMB_WAIT); return; }
      const url = URL.createObjectURL(blob), old = b.thumbUrl;
      b.thumbUrl = url; b.thumbFails = 0;
      b.el?.classList.remove('failed');
      if (b.img) { b.img.src = url; await b.img.decode().catch(() => {}); b.el.classList.add('thumb'); }
      if (old) URL.revokeObjectURL(old);
    }).catch(() => failed(b)).finally(() => {
      b.painted = true; onChange('painted', b);
      if (!s.timer) { free(b.file, s); wantThumbs(); } // also asks again for one that changed while this was in flight
    });
  }
  function free(file, s = slots.get(file)) { if (s && slots.get(file) === s) { clearTimeout(s.timer); slots.delete(file); } }
  function rendered(file) { // the render ended (or we stopped waiting): the slot is free, or will be once the ask answers
    const s = slots.get(file);
    if (s?.timer) free(file, s); else if (s) s.ended = true;
  }
  // "Snapshot failed · Retry" on the placeholder; asked once more by itself RETRY_MS later.
  function failed(b) {
    if (b.thumbUrl) return; // the older snapshot stays
    b.el?.classList.add('failed');
    if (b.thumbFails++ === 0) setTimeout(() => retryThumb(b.file), RETRY_MS);
  }
  function retryThumb(file) {
    const b = all.get(file);
    if (!b || !b.el?.classList.contains('failed')) return;
    b.el.classList.remove('failed');
    b.needThumb = true;
    if (b.page === page) wantThumbs();
  }
  function thumbReady(file) {
    rendered(file);
    const b = all.get(file);
    if (b) b.needThumb = true;
    if (b?.page === page) wantThumbs(); else nextThumb();
  }
  function thumbFailed(file) {
    rendered(file);
    const b = all.get(file);
    if (b) failed(b);
    nextThumb();
  }

  // ---------- an outside edit ----------
  // A live board swaps in place (its state kept) through the bridge's update op, else reloads; every board gets a new snapshot.
  async function fileChanged(file) {
    const b = all.get(file);
    if (!b) return;
    if (b.frame) {
      try { const r = await ask(b, 'update', {}, { ms: 5000 }); if (r?.reload) reload(b); else onChange('swapped', b); } catch { reload(b); }
    }
    thumbReady(file);
  }

  return {
    setBoards, showPage, bounds, budget, extra, visible, ask, wantThumbs, thumbReady, thumbFailed, retryThumb, fileChanged, zoomed, setPlaying,
    get: (file) => all.get(file) || null,
    shown: () => shown,
    painted: () => visible().every((b) => b.missing || b.painted),
  };
}
