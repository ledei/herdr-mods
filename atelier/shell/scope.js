// The scope lock (V2Select). A selection (a board, an element picked with Select, or an area dragged with the Area
// tool) can be locked as the scope: an accent outline with the badge "Only this part · <label>" and an unlock button.
// Agents change only what is locked (view-state scope {kind, ids, rect?, label, sha?}; atelierd's scope check and the
// PostToolUse hook flag anything else). Esc clears an unlocked area; a locked scope stays until it is unlocked.
import * as api from './api.js';

const LOCK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const X = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const stem = (f) => f.replace(/\.dc\.html$/, '');
const box = (n, [x, y, w, h]) => { n.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`; return n; };
// Clicks on the shell's own controls over the canvas never reach the canvas's pointer handlers (pan, pick).
export const own = (n) => { n.addEventListener('pointerdown', (e) => e.stopPropagation()); return n; };

/** The board under a pointer event and the point in its CSS px, or null. */
export function boardAt(e, boards, camera) {
  const n = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('board'));
  const b = n && boards.get(n.dataset.file);
  if (!b) return null;
  const r = b.el.getBoundingClientRect(), { s } = camera.get();
  return { b, x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

/** A press on a board: a drag draws a rect (board px) on the layer; done({b, rect}) on release, or done({b, x, y}) for a
 *  click (under 4 px of movement). */
export function dragRect(e, hit, { layer, camera }, done) {
  const { b } = hit, { s } = camera.get(), r0 = b.el.getBoundingClientRect();
  const at = (ev) => [Math.min(Math.max((ev.clientX - r0.left) / s, 0), b.w), Math.min(Math.max((ev.clientY - r0.top) / s, 0), b.h)];
  const [x0, y0] = at(e);
  let rect = null, n = null;
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const [x1, y1] = at(ev);
    if (!n && Math.hypot((x1 - x0) * s, (y1 - y0) * s) < 4) return;
    rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)].map((v) => Math.round(v));
    if (!n) { n = el('div', 'dragrect'); layer.append(n); }
    box(n, [b.x + rect[0], b.y + rect[1], rect[2], rect[3]]);
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    n?.remove();
    if (ev.type === 'pointercancel') return;
    done(rect && rect[2] >= 4 && rect[3] >= 4 ? { b, rect } : { b, x: x0, y: y0 });
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

/** selection(): main's {kind: 'board'|'element', board, id?, label?, bbox?} or null; page(): the page shown;
 *  onChange(): the scope changed (view-state). */
export function createScope({ layer, canvas, boards, camera, selection, page, onChange }) {
  let locked = null; // {kind, board, ids, rect?, label, bbox, sha}
  let area = null; // the Area tool's selection, unlocked: {board, rect}
  const marks = el('div', 'marks smarks');

  // The elements a rect holds, from the live board's layers: each one inside it whose parent is not.
  async function inside(b, [x, y, w, h]) {
    const t = await boards.ask(b, 'tree', { depth: 12 }, { pin: true, ms: 10000 }).catch(() => null);
    const ids = [];
    const fits = (r) => r && r[2] > 0 && r[3] > 0 && r[0] >= x - 1 && r[1] >= y - 1 && r[0] + r[2] <= x + w + 1 && r[1] + r[3] <= y + h + 1;
    (function walk(ns) { for (const n of ns || []) { if (fits(n.bbox)) ids.push(n.id); else walk(n.children); } })(t?.tree);
    return ids.slice(0, 50);
  }
  async function lock() {
    const s = area ? { kind: 'region', board: area.board, rect: area.rect, bbox: area.rect, label: 'Area' } : selection();
    if (!s) return;
    const b = boards.get(s.board);
    const ids = s.kind === 'board' ? [s.board] : s.kind === 'element' ? [s.id] : await inside(b, s.rect);
    // atelierd snapshots every board first, so whatever an agent writes next can be reverted (older atelierd: no route).
    const r = await api.json('POST', '/__atelier/scope/lock', { canvas, ids }).catch(() => ({}));
    const tid = s.kind === 'element' ? `#${/#(\d+)/.exec(s.id)[1]}` : '';
    const label = s.kind === 'board' ? b?.label || stem(s.board) : s.kind === 'region' ? 'Area' : !s.label || /^[a-z][\w-]*$/.test(s.label) ? `${s.label || ''} ${tid}`.trim() : s.label; // a bare tag gets its #tid
    locked = { kind: s.kind, board: s.board, ids, ...(s.rect ? { rect: s.rect } : {}), label, bbox: s.kind === 'board' ? null : s.bbox, sha: r.sha || {} };
    area = null;
    draw(); onChange();
  }
  function unlock() { locked = null; draw(); onChange(); }

  // A rect, a badge or a "lock" chip at the top-left of r (board px) on board b; for a whole board at its top-right.
  function frame(b, r, cls, label, isLocked) {
    const whole = !r, [x, y, w, h] = r || [0, 0, b.w, b.h];
    marks.append(box(el('div', `scoperect ${cls}`), [b.x + x, b.y + y, w, h]));
    const chip = own(el('div', `scopechip${isLocked ? ' locked' : ''}${whole ? ' right' : ''}`));
    chip.style.cssText = whole ? `left:${b.x + b.w}px;top:${b.y}px` : `left:${b.x + x}px;top:${b.y + y}px`;
    if (isLocked) {
      chip.innerHTML = `${LOCK}<span></span><button type="button" class="unlock" aria-label="Unlock the scope" title="Unlock">${X}</button>`;
      chip.querySelector('span').textContent = `Only this part · ${label}`;
      chip.querySelector('button').onclick = unlock;
    } else {
      chip.innerHTML = `<button type="button" class="lockbtn" title="Agents change only what you lock. Esc clears it.">${LOCK}<span>Only this part</span></button>`;
      chip.querySelector('button').onclick = () => { lock(); };
    }
    marks.append(chip);
  }
  function draw() {
    if (!marks.isConnected) layer.append(marks);
    marks.replaceChildren();
    const p = page(), on = (f) => { const b = boards.get(f); return b && b.page === p ? b : null; };
    if (locked && on(locked.board)) frame(on(locked.board), locked.kind === 'board' ? null : locked.bbox || locked.rect, 'locked', locked.label, true);
    const s = area ? { board: area.board, r: area.rect, cls: 'area' } : selection() && { board: selection().board, r: selection().kind === 'board' ? null : selection().bbox, kind: selection().kind, id: selection().id };
    const same = locked && s && s.board === locked.board && (s.kind === 'board' ? locked.kind === 'board' : s.id && locked.ids.includes(s.id));
    if (s && on(s.board) && !same && (s.r || s.kind === 'board')) frame(on(s.board), s.r, s.cls || 'pending', '', false);
  }

  return {
    draw,
    /** At start: the scope locked before this page loaded (view-state keeps it across a reload). */
    async restore() {
      const v = await api.json('GET', `/__agent/view?canvas=${encodeURIComponent(canvas)}`).catch(() => null);
      const s = v?.scope;
      if (!s || !Array.isArray(s.ids) || !['board', 'element', 'region'].includes(s.kind)) return;
      const board = s.kind === 'board' ? s.ids[0] : s.kind === 'region' ? s.board ?? s.ids[0]?.split('#')[0] : s.ids[0]?.split('#')[0];
      locked = { kind: s.kind, board, ids: s.ids, ...(s.rect ? { rect: s.rect } : {}), label: String(s.label || ''), bbox: s.rect || null, sha: s.sha || {} };
    },
    /** The Area tool's press on a board: true when it took the gesture. */
    down(e) {
      const hit = boardAt(e, boards, camera);
      if (!hit) return false;
      dragRect(e, hit, { layer, camera }, ({ b, rect }) => { area = rect ? { board: b.file, rect } : null; draw(); });
      return true;
    },
    escape() { if (!area) return false; area = null; draw(); return true; },
    /** After a hot swap: the locked element may have moved. */
    async refresh(b) {
      if (locked?.kind !== 'element' || locked.board !== b.file) return;
      const r = await boards.ask(b, 'bbox', { id: locked.ids[0] }).catch(() => null);
      if (r?.bbox) { locked.bbox = r.bbox; draw(); }
    },
    /** For view-state: {kind, ids, rect?, label, sha?} while locked, else null. */
    get: () => locked && { kind: locked.kind, ids: locked.ids, ...(locked.rect ? { rect: locked.rect, board: locked.board } : {}), label: locked.label, ...(Object.keys(locked.sha).length ? { sha: locked.sha } : {}) },
  };
}
