// The layers panel (V2Canvas / V2Select): the selected board's tree from /__agent/tree (live from the board while the
// shell is open), with collapse. Hovering a row outlines its element on the canvas, a click selects it as the Select
// tool does, and dragging a row among its siblings moves the element in the source (POST /__atelier/edit with
// insertBefore / insertAfter, the user's own edit). The tree comes again when the board's file changes.
// Under 600 px the panel folds, with the inspector, into one drawer behind a "Layers" button.
import * as api from './api.js';
import { own } from './scope.js';

const ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';
const CHEV = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const stem = (f) => String(f || '').replace(/\.dc\.html$/, '');
const OPEN_DEPTH = 2; // levels shown open at first; deeper ones open on demand or around the selection

/** layer: the canvas layer (hover outline); boards: createBoards(); page(): the page shown; select({board, element}): main's. */
export function createLayers({ layer, canvas, boards, page, select }) {
  let board = null, tree = [], selected = null, loading = 0, timer = 0;
  const open = new Set(), shut = new Set(); // ids the user opened or closed
  const panel = own(el('aside', 'lpanel'));
  panel.setAttribute('aria-label', 'Layers');
  panel.hidden = true;
  const head = el('div', 'lhead');
  head.innerHTML = `${ICON}<span>Layers</span>`;
  const name = el('span', 'tag lboard');
  head.append(name);
  const list = el('div', 'llist');
  list.setAttribute('role', 'tree');
  const msg = el('div', 'lmsg');
  msg.setAttribute('role', 'alert');
  panel.append(head, list, msg);
  const fold = own(el('button', 'ghost lfold'));
  fold.type = 'button';
  fold.innerHTML = `${ICON}<span>Layers</span>`;
  fold.setAttribute('aria-expanded', 'false');
  fold.hidden = true;
  fold.onclick = () => fold.setAttribute('aria-expanded', String(document.documentElement.classList.toggle('lopen')));
  document.body.append(panel, fold);
  const marks = el('div', 'marks lmarks');

  // ---------- hover outline ----------
  function hover(n) {
    marks.replaceChildren();
    const b = boards.get(board);
    if (!n?.bbox || !b || b.page !== page()) return;
    if (!marks.isConnected) layer.append(marks);
    const o = el('div', 'lhover');
    o.style.cssText = `left:${b.x + n.bbox[0]}px;top:${b.y + n.bbox[1]}px;width:${n.bbox[2]}px;height:${n.bbox[3]}px`;
    marks.append(o);
  }

  // ---------- rows ----------
  const isOpen = (n, d) => !shut.has(n.id) && (open.has(n.id) || d < OPEN_DEPTH || onPath(n));
  const onPath = (n) => !!selected && n.children?.some((k) => k.id === selected || onPath(k));
  let drag = null; // {id, parent}
  function row(n, d, parent) {
    const r = el('div', 'lrow');
    r.setAttribute('role', 'treeitem');
    r.dataset.id = n.id;
    r.style.paddingLeft = `${8 + d * 14}px`;
    r.setAttribute('aria-selected', String(n.id === selected));
    const kids = n.children?.length > 0, opened = kids && isOpen(n, d);
    if (kids) r.setAttribute('aria-expanded', String(opened));
    const t = el('button', 'ltwist');
    t.type = 'button';
    t.innerHTML = CHEV;
    t.tabIndex = -1;
    t.setAttribute('aria-label', opened ? 'Collapse' : 'Expand');
    if (!kids) t.style.visibility = 'hidden';
    t.onclick = (e) => { e.stopPropagation(); if (opened) { shut.add(n.id); open.delete(n.id); } else { open.add(n.id); shut.delete(n.id); } render(); };
    r.append(t, el('span', 'lname', n.label || n.tag), el('span', 'tag', `${n.tag}${n.more ? ` +${n.more}` : ''}`));
    r.onpointerenter = () => hover(n);
    r.onpointerleave = () => hover(null);
    r.onclick = () => select({ board, element: { id: n.id, label: n.label, bbox: n.bbox } });
    // Drag among siblings: only template elements (a repeat inside sc-for moves with all its repeats, so not by hand).
    if (!n.id.includes('@')) {
      r.draggable = true;
      r.ondragstart = (e) => { drag = { id: n.id, parent }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); r.classList.add('dragging'); };
      r.ondragend = () => { drag = null; r.classList.remove('dragging'); clearDrop(); };
    }
    r.ondragover = (e) => {
      if (!drag || drag.parent !== parent || drag.id === n.id || n.id.includes('@')) return;
      e.preventDefault();
      clearDrop();
      const box = r.getBoundingClientRect();
      r.classList.add(e.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
    };
    r.ondragleave = () => r.classList.remove('drop-before', 'drop-after');
    r.ondrop = (e) => {
      e.preventDefault();
      const before = r.classList.contains('drop-before'), from = drag?.id;
      clearDrop();
      if (from && drag.parent === parent) move(from, n.id, before);
    };
    return [r, opened ? n.children.flatMap((k) => rows(k, d + 1, n.id)) : []];
  }
  const rows = (n, d, parent) => { const [r, kids] = row(n, d, parent); return [r, ...kids]; };
  const clearDrop = () => { for (const x of list.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after'); };
  function render() {
    list.replaceChildren(...tree.flatMap((n) => rows(n, 0, null)));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  // ---------- data ----------
  async function load() {
    const want = board, n = ++loading;
    if (!want) return;
    try {
      const r = await api.json('GET', `/__agent/tree?canvas=${encodeURIComponent(canvas)}&board=${encodeURIComponent(want)}&depth=12`);
      if (n !== loading || want !== board) return;
      tree = Array.isArray(r.tree) ? r.tree : [];
      msg.textContent = tree.length ? '' : 'This board has no layers yet.';
      render();
    } catch (e) {
      if (n === loading) msg.textContent = `Layers could not be read: ${e.message}`;
    }
  }
  async function move(id, target, before) {
    msg.textContent = '';
    try {
      const { sha } = await api.json('GET', `/__agent/resolve?canvas=${encodeURIComponent(canvas)}&id=${encodeURIComponent(id)}`);
      const r = await api.json('POST', '/__atelier/edit', { canvas, expectSha: sha, edits: [{ id, [before ? 'insertBefore' : 'insertAfter']: target }], follow: selected ? [selected] : [] });
      // The selection may be the moved element or one it moved past: its id now names something else.
      const now = selected && r.ids?.[selected];
      if (now && now !== selected) select({ board, element: { id: now, label: '', bbox: null } });
    } catch (e) { msg.textContent = e.message; }
  }

  return {
    /** The selected board and element (main's select()): the panel shows that board's tree, the element's row marked. */
    show(file, id = null) {
      selected = id;
      panel.hidden = fold.hidden = !file;
      if (!file) { board = null; tree = []; hover(null); document.documentElement.classList.remove('lopen'); fold.setAttribute('aria-expanded', 'false'); return; }
      if (file !== board) { board = file; tree = []; open.clear(); shut.clear(); msg.textContent = ''; name.textContent = stem(file); list.replaceChildren(); load(); }
      else render();
    },
    /** After the board's file changed or it went live: the tree again (bboxes and ids may have moved). */
    refresh(file) {
      if (file !== board) return;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    },
  };
}
