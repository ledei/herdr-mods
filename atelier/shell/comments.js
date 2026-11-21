// Comments (V2Comment): pins and areas drawn on the boards (canvas px, screen-sized), the composer, the thread popover
// and the Comments list with its open count. With the Comment tool a click in a board pins the element under it by its
// exact id (the bridge's "at"), and a drag comments on an area. Pins follow their element: after a board file changes
// the list comes again (atelierd follows each anchor to its element, or marks it drifted), and live boards give fresh
// bboxes, which go back to atelierd so snapshots draw them right too.
import * as api from './api.js';
import { boardAt, dragRect, own } from './scope.js';

const PIN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const WARN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
const TRASH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const stem = (f) => String(f || '').replace(/\.dc\.html$/, '');
const ago = (ts) => {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return !Number.isFinite(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const tidOf = (id) => /#(\d+)/.exec(id || '')?.[1];

/** focus(file): show that board's page; onChange(kind): 'count' (open count changed), 'tool' (repin wants the tool). */
export function createComments({ layer, canvas, boards, camera, page, focus, onChange }) {
  let list = [], open = null, draft = null, repin = null, showResolved = false;
  const live = new Map(); // comment id → bbox the live board gave
  const marks = el('div', 'marks cmarks');
  const panel = own(el('aside', 'cpanel'));
  panel.setAttribute('aria-label', 'Comments');
  panel.hidden = true;
  document.body.append(panel);

  const num = (k) => list.indexOf(k) + 1;
  const boardOf = (k) => boards.get(k.board || k.anchor?.id?.split('#')[0]);
  const bboxOf = (k) => (k.kind === 'area' ? k.rect : live.get(k.id) || k.anchor?.bbox || null);
  const shown = (k) => k.status !== 'resolved' || showResolved || open === k.id;
  // The board's label for it, else its source text without the {{ holes }}, else its tag.
  const label = (k) => k.anchor?.label || (k.anchor?.text60 || '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim() || k.anchor?.tag || 'Area';
  const where = (k) => [k.anchor?.tag, tidOf(k.anchor?.id) && `#${tidOf(k.anchor.id)}`].filter(Boolean).join(' ');

  // ---------- on the canvas ----------
  function pinAt(b, k, [x, y, w]) {
    const p = own(el('button', `pin${k.status === 'resolved' ? ' done' : ''}${k.drifted ? ' drifted' : ''}`, String(num(k))));
    p.type = 'button';
    p.dataset.id = k.id;
    p.setAttribute('aria-label', `Comment ${num(k)}, ${k.drifted ? 'lost its element' : k.status}`);
    p.style.cssText = `left:${b.x + x + w}px;top:${b.y + y}px`;
    p.onclick = () => { open = open === k.id ? null : k.id; draft = null; draw(); };
    marks.append(p);
  }
  function popAt(b, x, y, node) {
    const wrap = el('div', 'cpop-at');
    wrap.style.cssText = `left:${b.x + x}px;top:${b.y + y}px`;
    wrap.append(own(node));
    marks.append(wrap);
    // Kept on screen: moved left or up by what would stick out (it then overlaps its element, never the edge).
    const r = node.getBoundingClientRect(); // the wrapper undoes the zoom: these are screen px
    const dx = Math.max(0, r.right - innerWidth + 8), up = Math.max(0, 8 - r.top), dy = Math.max(0, r.bottom - innerHeight + 76); // 76: the toolbar
    if (dx) node.style.left = `${18 - dx}px`;
    if (up || dy) node.style.top = `${-40 + (up || -dy)}px`;
  }
  function draw() {
    if (!marks.isConnected) layer.append(marks);
    // A redraw (a push from an agent, fresh bboxes) while someone is typing in the composer or a reply: the same
    // composer or thread, drawn again, keeps the text and the focus. A send empties its field first.
    const was = marks.querySelector('.cpop input'), typed = was && { of: was.closest('.cpop').of, text: was.value, focused: was === document.activeElement };
    marks.replaceChildren();
    const p = page();
    for (const k of list) {
      const b = boardOf(k), r = bboxOf(k);
      if (!b || b.page !== p || !r || !shown(k)) continue;
      if (k.kind === 'area') { const a = el('div', 'carea'); a.style.cssText = `left:${b.x + r[0]}px;top:${b.y + r[1]}px;width:${r[2]}px;height:${r[3]}px`; marks.append(a); }
      else if (open === k.id && !k.drifted) { const o = el('div', 'cring'); o.style.cssText = `left:${b.x + r[0]}px;top:${b.y + r[1]}px;width:${r[2]}px;height:${r[3]}px`; marks.append(o); }
      pinAt(b, k, r);
      if (open === k.id) popAt(b, r[0] + r[2], r[1], thread(k));
    }
    if (draft) {
      const b = boards.get(draft.board), r = draft.kind === 'area' ? draft.rect : draft.anchor.bbox || [draft.x, draft.y, 0, 0];
      if (b && b.page === p) {
        const o = el('div', draft.kind === 'area' ? 'carea' : 'cring');
        o.style.cssText = `left:${b.x + r[0]}px;top:${b.y + r[1]}px;width:${r[2]}px;height:${r[3]}px`;
        marks.append(o);
        popAt(b, r[0] + r[2], r[1], composer());
      }
    }
    const now = typed && marks.querySelector('.cpop input');
    if (now && now.closest('.cpop').of === typed.of) { now.value = typed.text; if (typed.focused) now.focus(); }
    if (!panel.hidden) renderPanel();
    onChange('count');
  }

  // ---------- composer and thread ----------
  function field(placeholder, send) {
    const row = el('div', 'crow');
    const lab = el('label', 'cfield');
    lab.append(el('span', 'sr', placeholder));
    const input = el('input');
    input.placeholder = placeholder;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); const t = input.value.trim(); input.value = ''; send(t); }
      if (e.key === 'Escape') { e.stopPropagation(); open = null; draft = null; draw(); }
    });
    lab.append(input);
    row.append(lab);
    return { row, input };
  }
  function head(icon, prefix, k) {
    const h = el('div', 'chead');
    h.innerHTML = icon;
    h.append(prefix, el('b', '', k ? label(k) : ''), ' ', el('span', 'tag', k ? where(k) : ''));
    return h;
  }
  function composer() {
    const pop = el('div', 'cpop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'New comment');
    const d = draft;
    pop.of = d;
    const h = d.kind === 'area' ? head(PIN, 'Comment on an area of ', null) : head(PIN, 'Comment on ', { anchor: d.anchor, kind: 'pin' });
    if (d.kind === 'area') h.querySelector('b').textContent = stem(d.board);
    const { row, input } = field('Add a comment', (text) => post(text));
    const go = el('button', 'prim', 'Comment');
    go.type = 'button';
    go.onclick = () => input.value.trim() && post(input.value.trim());
    row.append(go);
    pop.append(h, row);
    queueMicrotask(() => input.focus());
    return pop;
  }
  async function post(text) {
    const d = draft;
    draft = null;
    try {
      const k = await api.json('POST', '/__agent/comments', { canvas, text, from: 'shell', kind: d.kind, board: d.board,
        ...(d.kind === 'area' ? { rect: d.rect } : { anchor: { id: d.anchor.id, label: d.anchor.label, bbox: d.anchor.bbox } }) });
      if (!list.some((x) => x.id === k.id)) list.push(k); // the push of its own write may have reloaded the list first
      open = k.id;
    } catch (e) { toast(`The comment was not saved: ${e.message}`); }
    draw();
  }
  function thread(k) {
    const pop = el('div', 'cpop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Comment thread ${num(k)}`);
    pop.of = k.id;
    const h = head(PIN, k.kind === 'area' ? 'Area on ' : 'Pinned to ', k.kind === 'area' ? null : k);
    if (k.kind === 'area') h.querySelector('b').textContent = stem(k.board);
    if (k.own) {
      const del = el('button', 'cdel');
      del.type = 'button'; del.innerHTML = TRASH; del.title = 'Delete'; del.setAttribute('aria-label', 'Delete this comment');
      del.onclick = () => act('/__atelier/comments/delete', { id: k.id }, () => { list = list.filter((x) => x !== k); open = null; });
      h.append(del);
    }
    pop.append(h);
    if (k.drifted) pop.append(lost(k));
    for (const m of [k, ...(k.replies || [])]) {
      const msg = el('div', 'cmsg');
      const who = el('span', 'who', m.author || 'Anonym');
      who.append(el('span', 'dim', ` ${m.kind === 'agent' ? '(agent) ' : ''}· ${ago(m.ts)}`));
      msg.append(who, el('span', '', m.text));
      pop.append(msg);
    }
    const { row } = field('Reply', (text) => act('/__agent/reply', { id: k.id, text, kind: 'user' }, (r) => Object.assign(k, r.comment)));
    const res = el('button', 'ghost', k.status === 'resolved' ? 'Reopen' : 'Resolve');
    res.type = 'button';
    res.onclick = () => act('/__agent/resolve', { id: k.id, open: k.status === 'resolved' }, (r) => Object.assign(k, r));
    row.append(res);
    pop.append(row);
    return pop;
  }
  // "Comment 3 lost its element. Pin it again": the next click with the Comment tool pins it to a new element.
  function lost(k) {
    const n = el('div', 'clost');
    n.innerHTML = WARN;
    const t = el('span', '', `Comment ${num(k)} lost its element. `);
    const a = el('a', '', 'Pin it again');
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); repin = k.id; open = null; onChange('tool'); draw(); toast('Click the element to pin it to.'); };
    t.append(a);
    n.append(t);
    return n;
  }
  async function act(route, body, then) {
    try { then(await api.json('POST', route, { canvas, ...body })); } catch (e) { toast(e.status === 404 ? 'This Atelier cannot do that yet.' : e.message); }
    draw();
  }
  function toast(text) {
    const t = el('div', 'ctoast', text);
    t.setAttribute('role', 'status');
    document.body.append(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ---------- the list ----------
  function renderPanel() {
    const n = list.filter((k) => k.status !== 'resolved').length;
    const h = el('div', 'phead');
    h.append(el('b', '', 'Comments'), el('span', 'dim', `${n} open`));
    const tog = el('button', 'ghost quiet', showResolved ? 'Hide resolved' : 'Show resolved');
    tog.type = 'button';
    tog.onclick = () => { showResolved = !showResolved; draw(); renderPanel(); };
    h.append(tog);
    const items = list.filter((k) => k.status !== 'resolved' || showResolved).map((k) => {
      const it = el('button', `citem${k.status === 'resolved' ? ' done' : ''}`);
      it.type = 'button';
      it.dataset.id = k.id;
      const top = el('span', 'ctop');
      top.append(el('span', `pin small${k.drifted ? ' drifted' : ''}`, String(num(k))), el('span', 'cwhere', `${stem(k.board)} › ${label(k)}`));
      it.append(top, el('span', 'ctext', k.text), el('span', 'dim', `${k.author} · ${ago(k.ts)}${k.replies?.length ? ` · ${k.replies.length} repl${k.replies.length === 1 ? 'y' : 'ies'}` : ''}${k.drifted ? ' · lost its element' : ''}`));
      it.onclick = () => { focus(k.board); open = k.id; draft = null; draw(); };
      return it;
    });
    panel.replaceChildren(h, ...(items.length ? items : [el('div', 'dim cempty', 'No comments yet. Click an element with the Comment tool (C).')]));
  }

  // ---------- the Comment tool's press on a board ----------
  function down(e) {
    const hit = boardAt(e, boards, camera);
    if (!hit) return false;
    dragRect(e, hit, { layer, camera }, async ({ b, rect, x, y }) => {
      open = null;
      if (rect && !repin) { draft = { kind: 'area', board: b.file, rect }; return draw(); }
      // A snapshot is made live first (as an agent's ask is), then asked what is under the click.
      const at = await boards.ask(b, 'at', { x: x ?? rect[0], y: y ?? rect[1] }, { pin: !(b.frame && b.booted), ms: 10000 }).catch(() => null);
      if (!at) return toast('No element there.');
      if (repin) {
        const id = repin;
        repin = null;
        return act('/__atelier/comments/repin', { id, anchor: { id: at.id, label: at.label, bbox: at.bbox } }, (k) => { Object.assign(list.find((x) => x.id === id) || {}, k); open = id; });
      }
      draft = { kind: 'pin', board: b.file, anchor: { id: at.id, label: at.label, bbox: at.bbox, tag: at.tag } };
      draw();
    });
    return true;
  }

  // ---------- data ----------
  async function reload() {
    try { list = (await api.json('GET', `/__agent/comments?canvas=${encodeURIComponent(canvas)}&status=all`)).comments || []; } catch { return; }
    draw();
    for (const b of boards.shown()) if (b.frame && b.booted) refresh(b);
  }
  // The live board's bboxes for its pins; sent back so a snapshot draws them right too.
  async function refresh(b) {
    const mine = list.filter((k) => k.kind !== 'area' && !k.drifted && boardOf(k) === b && /#\d/.test(k.anchor?.id || ''));
    if (!mine.length || !b.frame) return;
    const items = [];
    for (const k of mine) {
      const r = await boards.ask(b, 'bbox', { id: k.anchor.id }, { ms: 3000 }).catch(() => null);
      if (!r?.bbox || r.bbox[2] <= 0) continue;
      live.set(k.id, r.bbox);
      if (JSON.stringify(r.bbox) !== JSON.stringify(k.anchor.bbox)) items.push({ id: k.id, bbox: r.bbox });
    }
    draw();
    if (items.length) api.json('POST', '/__atelier/comments/bbox', { canvas, items }).then(() => items.forEach((i) => { const k = list.find((x) => x.id === i.id); if (k) k.anchor.bbox = i.bbox; })).catch(() => {});
  }

  return {
    draw, down, reload, refresh,
    setTool(on) { panel.hidden = !on; if (on) renderPanel(); else { draft = null; repin = null; open = null; } draw(); },
    // A board file changed: atelierd has followed the anchors by the time the swap lands.
    fileChanged(file) { const b = boards.get(file); setTimeout(() => reload().then(() => b && refresh(b)), 300); },
    escape() { if (!draft && !open && !repin) return false; draft = null; open = null; repin = null; draw(); return true; },
    openCount: () => list.filter((k) => k.status !== 'resolved').length,
  };
}
