// Variants and versions (V2Variants). On the canvas: each variants group's dashed frame with its title, a label above
// every board (A base, B, C …, kept), Keep / Archive the others / New variant under it, prop variants (one file once
// more with other Tweaks, in a frame of its own here: boards.js holds one board per file) and a compare board (an old
// version beside the board, read-only). Beside it: the Versions panel (a board's snapshots, checkpoints, restore,
// compare, kopia), from a toolbar button; under 600 px it folds into a drawer at the bottom.
import * as api from './api.js';
import { own } from './scope.js';
import { boardUrl } from './boards.js';

const ICO = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const COPY = ICO('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>');
const CHECK = ICO('<path d="M20 6 9 17l-5-5"/>');
const PLUS = ICO('<path d="M12 5v14"/><path d="M5 12h14"/>');
const HISTORY = ICO('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>');
const X = ICO('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const PROPS_MS = 3000;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const html = (tag, cls, h) => { const e = el(tag, cls); e.innerHTML = h; return e; };
const stem = (f) => String(f || '').replace(/\.dc\.html$/, '');
// A version's ts (2026-11-20T13-05-00-000Z) or a checkpoint's ISO time → 13:05 local (13:05:09 with seconds).
const clock = (ts, seconds) => { const d = new Date(String(ts).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z.*$/, 'T$1:$2:$3.$4Z')); return Number.isFinite(+d) ? d.toTimeString().slice(0, seconds ? 8 : 5) : ''; };
const brief = (props) => Object.entries(props || {}).slice(0, 2).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ').slice(0, 40);
// What a checkpoint restore brought back, and what it could not (its version gone, or no canvas entry to put back).
const names = (files) => files.map(stem).join(', ');
const restoredText = (label, o) => `${o.restored.length} board${o.restored.length === 1 ? '' : 's'} back at "${label}"`
  + (o.added?.length ? `; put back on the canvas: ${names(o.added)}` : '') + (o.removed?.length ? `; taken off again (in trash): ${names(o.removed)}` : '')
  + (o.missing?.length ? `. Could not restore ${names(o.missing)}: its saved version is gone or unreadable, or the checkpoint has no canvas entry for it` : '');
// The icon is ours (markup); the text may come from groups.json or a checkpoint name, so it is only ever text.
const button = (cls, text, onclick, icon = '') => { const b = html('button', cls, icon); b.append(text); b.type = 'button'; b.onclick = onclick; return b; };
// Canvas px plus screen px: stays the same size on screen at any zoom (--s is on the layer).
const at = (x, y, dx = 0, dy = 0) => `left:calc(${x}px + ${dx}px / var(--s));top:calc(${y}px + ${dy}px / var(--s))`;

/** ctx: layer, canvas (id), boardsUrl, boards, camera, page() (the page shown), showPage(page, focusFile),
 *  selected() (the one selected board's file, or null), select(file), tell(message) (to the herdr panel). */
export function init({ layer, canvas, boardsUrl, boards, camera, page, showPage, selected, select, tell }) {
  let groups = [], compare = null, panelFor;
  const frames = new Map(); // key → {node, frame, props?} for prop variants and the compare board
  const marks = el('div', 'vmarks');

  // ---------- data ----------
  async function reload() {
    try { groups = (await api.json('GET', `/__atelier/groups?canvas=${encodeURIComponent(canvas)}`)).groups; } catch { groups = []; }
    draw();
  }
  const post = (p, body) => api.json('POST', p, { canvas, ...body });
  const variant = (body) => post('/__agent/variants', body).catch((e) => note(e.message));

  // ---------- on the canvas ----------
  function draw() {
    const p = page(), sel = selected(), want = new Set();
    marks.replaceChildren();
    for (const g of groups) {
      if (g.kind !== 'variants') continue;
      const items = (g.boards || []).map((file) => ({ file, b: boards.get(file), label: g.labels?.[file] || '' })).filter((i) => i.b?.page === p)
        .map((i) => ({ ...i, x: i.b.x, y: i.b.y, w: i.b.w, h: i.b.h }));
      for (const pv of g.propVariants || []) {
        if (pv.page !== p || !boards.get(pv.file)) continue;
        const key = `${g.id}~${pv.label}`;
        want.add(key);
        vboard(key, pv.file, pv, { props: pv.props, title: `${stem(pv.file)} · ${pv.label}` });
        items.push({ file: pv.file, label: pv.label, props: pv.props, x: pv.x, y: pv.y, w: pv.w, h: pv.h });
      }
      if (items.length) drawGroup(g, items, sel);
    }
    const cb = compare && boards.get(compare.file);
    if (cb?.page === p) {
      want.add('compare');
      const box = compareBox(cb);
      const v = vboard('compare', compare.file, box, { v: compare.ts, title: `${stem(compare.file)} v${compare.n}, read-only`, want: true });
      v.node.classList.add('vcompare');
      const pill = own(html('div', 'vpill vold', `v${compare.n}<span>read-only</span>`));
      pill.style.cssText = at(box.x, box.y);
      pill.append(button('vclose', '', () => { compare = null; draw(); }, X));
      pill.lastChild.setAttribute('aria-label', 'Close the comparison');
      marks.append(pill);
    }
    for (const [k, v] of frames) if (!want.has(k) || !v.node.isConnected) { v.node.remove(); frames.delete(k); boards.extra(k, null); changed = true; }
    if (changed) { changed = false; boards.budget(); }
    layer.append(marks); // last: above the boards
    if (!panel.hidden && panelFor !== sel) renderPanel();
  }

  function drawGroup(g, items, sel) {
    const x0 = Math.min(...items.map((i) => i.x)), y0 = Math.min(...items.map((i) => i.y));
    const x1 = Math.max(...items.map((i) => i.x + i.w)), y1 = Math.max(...items.map((i) => i.y + i.h));
    const frame = el('div', 'vframe');
    frame.style.cssText = `${at(x0, y0, -12, -64)};width:calc(${x1 - x0}px + 24px / var(--s));height:calc(${y1 - y0}px + 76px / var(--s))`;
    // For compareBox: the frame in canvas px with its title and bar as they are at 50 %, so the place does not move with the zoom.
    frame.box = [x0 - 24, y0 - 128, x1 - x0 + 48, y1 - y0 + 200];
    const title = html('div', 'vtitle', `${COPY}<b></b><span></span>`);
    title.querySelector('b').textContent = g.name || 'Variants';
    title.querySelector('span').textContent = `variants · ${items.length}`;
    title.style.cssText = at(x0, y0, -12, -64);
    marks.append(frame, title);
    for (const i of items) {
      const kept = !i.props && g.picked === i.file;
      const pill = html('div', `vpill${i.file === g.base && !i.props ? ' base' : ''}${kept ? ' kept' : ''}`, `${kept ? CHECK : ''}<b></b><span></span>`);
      pill.querySelector('b').textContent = i.label;
      pill.querySelector('span').textContent = i.props ? brief(i.props) : i.file === g.base ? 'base' : kept ? 'kept' : '';
      pill.style.cssText = at(i.x, i.y);
      marks.append(pill);
    }
    // Keep acts on the selected variant of this group; Archive the others once one is kept; New variant of the selection or the base.
    const mine = items.find((i) => !i.props && i.file === sel);
    const bar = own(el('div', 'vbar'));
    bar.style.cssText = at(x0, y1, -12, 12);
    if (mine && g.picked !== mine.file) bar.append(button('ghost', `Keep ${mine.label}`, () => variant({ action: 'pick', file: mine.file }), CHECK));
    const others = items.some((i) => !i.props && i.file === g.picked) ? items.filter((i) => !i.props && i.file !== g.picked) : []; // not on a page without the kept one (Archive)
    if (others.length) bar.append(button('ghost', 'Archive the others', async () => { for (const i of others) await variant({ action: 'archive', file: i.file }); }));
    bar.append(button('ghost', 'New variant', () => post('/__agent/board', { op: 'variant', file: mine?.file || g.base }).catch((e) => note(e.message)), PLUS));
    marks.append(bar);
  }

  // A frame of its own on the layer for file (?v=ts for compare); props go to its bridge once it booted. It is one of
  // boards.js's live frames: without a slot it shows its label and Show live, which asks for one (want). changed: a
  // frame came or moved, so the budget runs again after draw.
  let changed = false;
  function vboard(key, file, box, { props, v, title, want = false }) {
    let it = frames.get(key);
    const src = `${boardUrl(boardsUrl, file, v ? `${file}?v=${v}` : file)}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
    if (!it || !it.node.isConnected || it.src !== src || JSON.stringify(it.props) !== JSON.stringify(props)) {
      it?.node.remove();
      const node = el('div', 'vboard');
      node.append(el('div', 'ph', title));
      const bar = own(el('div', 'vbar'));
      bar.style.cssText = at(0, 0, 12, 12);
      bar.append(button('ghost small', 'Show live', () => { it.want = true; boards.budget(); }));
      node.append(bar);
      it = { node, bar, frame: null, props, src, file, origin: new URL(src).origin, title, want, on: false, live: (on) => frameOn(it, on) };
      frames.set(key, it);
      layer.append(node);
      boards.extra(key, it);
      changed = true;
    }
    if (it.x !== box.x || it.y !== box.y || it.w !== box.w || it.h !== box.h) { Object.assign(it, { x: box.x, y: box.y, w: box.w, h: box.h }); changed = true; }
    it.node.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
    return it;
  }
  // A live slot came (the frame loads) or went (back to the label and Show live).
  function frameOn(it, on) {
    if (!on) { it.frame?.remove(); it.frame = null; delete it.node.dataset.props; it.node.append(it.bar); return; }
    const f = el('iframe');
    f.title = it.title;
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    if (it.props) it.node.dataset.props = 'waiting';
    it.bar.remove();
    it.node.append(f);
    it.frame = f;
    f.src = it.src;
  }

  // Where the old version goes: in free space beside the board (right, else below, else further right past whatever is
  // in the way), never over another board of the page, a prop variant or a variants frame (the board's own too).
  // GAP leaves room for the labels and pills above a board.
  const GAP = 80;
  function compareBox(cb) {
    const taken = boards.shown().filter((b) => b !== cb).map((b) => [b.x, b.y, b.w, b.h]);
    for (const [k, v] of frames) if (k !== 'compare' && v.node.isConnected) taken.push([v.x, v.y, v.w, v.h]);
    for (const n of marks.querySelectorAll('.vframe')) taken.push(n.box);
    // What a box of the board's size at x, y would overlap (with GAP around it), or undefined.
    const blocker = (x, y) => taken.find(([tx, ty, tw, th]) => x < tx + tw + GAP && tx < x + cb.w + GAP && y < ty + th + GAP && ty < y + cb.h + GAP);
    const box = (x, y) => ({ x, y, w: cb.w, h: cb.h });
    const right = cb.x + cb.w + GAP, below = cb.y + cb.h + GAP;
    if (!blocker(right, cb.y)) return box(right, cb.y);
    if (!blocker(cb.x, below)) return box(cb.x, below);
    let x = right;
    for (let t = blocker(x, cb.y); t; t = blocker(x, cb.y)) x = t[0] + t[2] + GAP;
    return box(x, cb.y);
  }
  // The old version beside the board, and the view on both.
  function showCompare(c) {
    compare = c;
    draw();
    const b = boards.get(c.file), o = compareBox(b);
    const x = Math.min(b.x, o.x), y = Math.min(b.y, o.y);
    camera.fit({ x, y: y - 60, w: Math.max(b.x + b.w, o.x + o.w) - x, h: Math.max(b.y + b.h, o.y + o.h) - y + 60 }, { animate: true });
  }

  // ---------- the bridge of our frames: booted → props {set} (T11's op); no answer in PROPS_MS: the board shows its defaults ----------
  const waiting = new Map();
  addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    const it = [...frames.values()].find((x) => x.frame && x.frame.contentWindow === e.source);
    if (!it || e.origin !== it.origin) return;
    const m = e.data;
    if (m.__atelier === 'res') { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
    if (m.__atelier === 'event' && m.type === '__dc_booted' && it.props) sendProps(it);
  });
  function sendProps(it) {
    const id = crypto.randomUUID();
    it.node.dataset.props = 'sent';
    const t = setTimeout(() => { waiting.delete(id); if (it.frame) it.node.dataset.props = 'failed'; it.node.title = 'These Tweaks did not reach the board: it shows its defaults.'; }, PROPS_MS);
    waiting.set(id, (m) => { clearTimeout(t); if (!it.frame) return; it.node.dataset.props = m.error === undefined ? 'ok' : 'failed'; if (m.error !== undefined) it.node.title = String(m.error); });
    it.frame.contentWindow.postMessage({ __atelier: 'req', id, op: 'props', args: { set: it.props } }, it.origin);
  }

  // ---------- the Versions panel ----------
  const panel = own(el('aside', 'vpanel'));
  panel.setAttribute('aria-label', 'Versions');
  panel.hidden = true;
  document.body.append(panel);
  const toggle = button('tool', '', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-pressed', String(!panel.hidden)); if (!panel.hidden) renderPanel(); }, HISTORY);
  toggle.setAttribute('aria-label', 'Versions'); toggle.title = 'Versions'; toggle.setAttribute('aria-pressed', 'false');
  document.getElementById('toolbar')?.append(toggle);
  let picked = null, naming = false, noteText = '', copied = null; // copied: the kopia's folder, while its note shows
  function note(t) { noteText = t; const n = panel.querySelector('.vnote'); if (n) n.textContent = t; }

  async function renderPanel() {
    const file = selected();
    if (file !== panelFor) { noteText = ''; copied = null; } // a message stays until the selection moves on
    panelFor = file;
    let data;
    try { data = await api.json('GET', file ? `/__atelier/versions?canvas=${encodeURIComponent(canvas)}&file=${encodeURIComponent(file)}` : `/__agent/versions?canvas=${encodeURIComponent(canvas)}`); }
    catch (e) { data = { versions: [], checkpoints: [] }; noteText = e.message; }
    if (panelFor !== file) return; // the selection moved on while this loaded
    const cps = data.checkpoints || [], list = (data.versions || []).map((ts, i) => ({ ts, n: i + 1 })).reverse();
    if (!list.some((v) => v.ts === picked)) picked = list[0]?.ts ?? null;
    const head = html('div', 'vhead', `${HISTORY}<b>Versions</b>`);
    if (naming) {
      const f = el('input', 'vname');
      f.placeholder = 'Name this checkpoint'; f.maxLength = 120;
      f.onkeydown = async (e) => {
        if (e.key === 'Escape') { naming = false; return renderPanel(); }
        if (e.key !== 'Enter') return;
        naming = false;
        try { const cp = await post('/__agent/checkpoint', { label: f.value.trim() }); noteText = `Checkpoint "${cp.label}" saved`; } catch (err) { noteText = err.message; }
        renderPanel();
      };
      head.append(f);
      setTimeout(() => f.focus());
    } else head.append(button('ghost small', 'Checkpoint', () => { naming = true; renderPanel(); }));
    const rows = list.map((v) => {
      const cp = cps.find((c) => c.files?.[file] === v.ts);
      const r = button(`vrow${v.ts === picked ? ' on' : ''}`, '', () => { picked = v.ts; renderPanel(); }, '<b></b><span></span><i class="dim"></i>');
      r.querySelector('b').textContent = `v${v.n}`;
      r.querySelector('span').textContent = cp ? `Checkpoint: ${cp.label}` : '';
      r.querySelector('i').textContent = clock(v.ts);
      r.setAttribute('aria-pressed', String(v.ts === picked));
      return r;
    });
    const cur = list.find((v) => v.ts === picked);
    const acts = el('div', 'vacts');
    if (cur) {
      acts.append(
        button('ghost', `Compare v${cur.n}`, () => showCompare({ file, ts: cur.ts, n: cur.n })),
        button('ghost', 'Restore', async () => {
          try { await post('/__agent/restore', { file, ts: cur.ts, expectSha: data.sha }); noteText = `${stem(file)} is back at v${cur.n}; what it was is the newest version`; } catch (e) { noteText = e.message; }
          renderPanel();
        }));
    }
    const cpRows = [...cps].reverse().map((c) => {
      const r = html('div', 'vrow cp', '<b></b><i class="dim"></i>');
      // Names cut short can read the same ("Before restoring…"): the time to the second, and the full name on hover.
      r.querySelector('b').textContent = c.label;
      r.querySelector('i').textContent = clock(c.ts, true);
      r.title = `${c.label}, ${clock(c.ts, true)}`;
      r.append(button('ghost small', 'Restore all', async () => {
        try { noteText = restoredText(c.label, await post('/__agent/version', { action: 'restoreCheckpoint', id: c.id })); } catch (e) { noteText = e.message; }
        renderPanel();
      }));
      return r;
    });
    const foot = el('div', 'vfoot');
    foot.append(button('ghost', 'Copy canvas (kopia)', async () => {
      // The panel puts the copy in Recent canvases (the canvas menu); Open the copy opens it now.
      try { const k = await post('/__agent/board', { op: 'kopia' }); tell({ type: 'kopia', path: k.path }); copied = k.path; noteText = `Copied to ${k.path}. It is in Recent canvases.`; } catch (e) { copied = null; noteText = e.message; }
      renderPanel();
    }));
    if (copied) { const path = copied; foot.append(button('ghost', 'Open the copy', () => tell({ type: 'open', path }))); }
    const msg = el('div', 'vnote dim', noteText);
    msg.setAttribute('aria-live', 'polite');
    panel.replaceChildren(head,
      el('div', 'vsub', file ? stem(file) : 'Select a board to see its versions.'),
      ...(file && !rows.length ? [el('div', 'vempty dim', 'No versions yet. One is kept before every change.')] : rows), acts,
      el('div', 'vsub', 'Checkpoints'), ...(cpRows.length ? cpRows : [el('div', 'vempty dim', 'None yet.')]), foot, msg);
  }

  // ---------- events ----------
  function onEvent(ev) {
    if (ev.type === 'groups') return reload();
    if (ev.type === 'compare' && typeof ev.file === 'string') {
      const b = boards.get(ev.file);
      if (!b) return;
      api.json('GET', `/__atelier/versions?canvas=${encodeURIComponent(canvas)}&file=${encodeURIComponent(ev.file)}`).then((v) => {
        if (b.page !== page()) showPage(b.page, ev.file);
        select(ev.file);
        showCompare({ file: ev.file, ts: ev.ts, n: v.versions.indexOf(ev.ts) + 1 });
      }, () => {});
    }
    if (ev.type === 'file' && ev.file?.endsWith('.dc.html')) { // a prop variant reloads with the new file
      for (const it of frames.values()) if (it.frame && it.props && it.src === boardUrl(boardsUrl, ev.file)) it.frame.src = it.src;
      if (!panel.hidden && ev.file === panelFor) renderPanel();
    }
  }

  reload();
  return { draw, reload, onEvent };
}
