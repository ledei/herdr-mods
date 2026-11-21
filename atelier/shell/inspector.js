// The inspector (V2Select's right panel): for the selected element, its text, colours (fill, colour), size (width,
// height, font size) and position (margin, padding) as the source has them (GET /__atelier/element), and the source
// line. A change goes to POST /__atelier/edit with the sha the fields were read from, as one style declaration or the
// text, so the file changes in that one place; the board reloads from the file watch. Errors show under the field.
import * as api from './api.js';
import { own } from './scope.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const long = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h).toLowerCase();
// [section, [label, style property, kind, placeholder from the rendered box]]
const FIELDS = [
  ['Position', [['Margin', 'margin'], ['Padding', 'padding']]],
  ['Size', [['W', 'width', 'num', (b) => b?.[2]], ['H', 'height', 'num', (b) => b?.[3]], ['Font size', 'font-size', 'num']]],
  ['Colour', [['Fill', 'background', 'colour'], ['Colour', 'color', 'colour']]],
];

/** canvas: the canvas id. show({board, id, label, bbox}) or show(null); refresh(file) after a file change. */
export function createInspector({ canvas }) {
  let cur = null, data = null, n = 0, timer = 0;
  const panel = own(el('aside', 'ipanel'));
  panel.setAttribute('aria-label', 'Inspector');
  panel.hidden = true;
  document.body.append(panel);

  async function load() {
    const want = cur, k = ++n;
    if (!want) return;
    try {
      const d = await api.json('GET', `/__atelier/element?canvas=${encodeURIComponent(canvas)}&id=${encodeURIComponent(want.id)}`);
      if (k !== n || want !== cur) return;
      data = d;
      // A field being typed in keeps what is typed (a hot swap re-reads the element); the next change uses the new sha.
      if (!document.activeElement?.matches?.('.ipanel .ifield')) render();
    } catch (e) {
      if (k === n) { data = null; render(e.message); }
    }
  }

  // The fill is the background-color declaration when the element has one, else background.
  const prop = (p) => (p === 'background' && data.style && data.style['background-color'] !== undefined ? 'background-color' : p);
  // One edit at a time, each with the sha the one before it left: a quick tab to the next field never sends a stale sha.
  // A 409 (the file changed under the panel: an agent's edit) is not retried, since the id may name another element
  // now: the element is read again and the refusal stays under its field until that field is changed again.
  let chain = Promise.resolve();
  const errors = new Map(); // field label → why the last change was refused
  const commit = (edit, label) => { chain = chain.then(() => send(edit, label)); return chain; };
  async function send(edit, label) {
    errors.delete(label);
    try {
      const r = await api.json('POST', '/__atelier/edit', { canvas, expectSha: data.sha, edits: [{ id: data.id, ...edit }] });
      data = { ...data, sha: r.sha };
      const next = r.ids?.[data.id];
      if (next && next !== cur.id) cur = { ...cur, id: next };
    } catch (e) {
      errors.set(label, e.status === 409 ? 'The file changed since this was read (another edit). It is read again now: check it and change it once more.' : e.message);
    }
    notes();
    await load();
  }
  const notes = () => { for (const k of panel.querySelectorAll('.inote[data-for]')) k.textContent = errors.get(k.dataset.for) || ''; };
  function noteFor(label) {
    const note = el('div', 'inote', errors.get(label) || '');
    note.setAttribute('role', 'alert');
    note.dataset.for = label;
    return note;
  }
  function input(value, placeholder, onCommit, label) {
    const i = el('input', 'ifield');
    i.type = 'text';
    i.value = value ?? '';
    if (placeholder != null) i.placeholder = String(Math.round(placeholder));
    i.setAttribute('aria-label', label);
    i.spellcheck = false;
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = value ?? ''; i.blur(); } };
    i.onchange = () => { if (i.value.trim() !== (value ?? '')) onCommit(i.value.trim()); };
    return i;
  }
  function field(label, p, kind, ph) {
    const row = el('div', 'ikv'), note = noteFor(label);
    const key = prop(p), value = data.style?.[key];
    const set = (v) => commit({ style: { [key]: v === '' ? null : kind === 'num' && /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v } }, label);
    const shown = kind === 'num' && value && /^-?\d+(\.\d+)?px$/.test(value) ? value.slice(0, -2) : value;
    const i = input(shown, ph?.(cur.bbox), set, label);
    i.disabled = !data.style;
    const wrap = el('span', 'ival');
    if (kind === 'colour') {
      const sw = el('input', 'iswatch');
      sw.type = 'color';
      sw.value = value && HEX.test(value) ? long(value) : '#000000';
      sw.disabled = !data.style;
      sw.setAttribute('aria-label', `${label} colour`);
      sw.style.setProperty('--c', value || 'transparent');
      sw.onchange = () => { i.value = sw.value.toUpperCase(); set(i.value); };
      wrap.append(sw);
    }
    wrap.append(i);
    row.append(el('span', 'ik', label), wrap);
    return [row, note];
  }

  function render(error) {
    panel.hidden = !cur;
    if (!cur) return panel.replaceChildren();
    const head = el('div', 'ihead');
    head.append(el('span', 'iname', cur.label || data?.tag || ''), el('span', 'tag', data ? `${data.tag} · #${data.tid}` : ''));
    if (!data) { panel.replaceChildren(head, el('div', 'inote pad err', error || '')); return; }
    const parts = [head];
    if (data.text !== null) {
      const sec = el('div', 'isec'), note = noteFor('Text');
      const t = input(data.text, null, (v) => commit({ text: v }, 'Text'), 'Text');
      t.classList.add('wide');
      const row = el('div', 'ikv');
      row.append(el('span', 'ik', 'Text'), t);
      sec.append(row, note);
      parts.push(sec);
    }
    for (const [title, list] of FIELDS) {
      const sec = el('div', 'isec');
      sec.append(el('div', 'ititle', title));
      for (const [label, p, kind, ph] of list) sec.append(...field(label, p, kind, ph));
      parts.push(sec);
    }
    if (!data.style) parts.push(el('div', 'inote pad', `This element's style is ${data.styleWhy}.`));
    parts.push(el('div', 'isrc', `Source: ${data.file}, line ${data.line}`));
    panel.replaceChildren(...parts);
  }

  return {
    show(s) {
      const same = s && cur && s.id === cur.id && s.board === cur.board;
      cur = s && s.id ? s : null;
      if (!same) { data = null; errors.clear(); render(); load(); } else if (s.bbox) cur = { ...cur, bbox: s.bbox };
    },
    refresh(file) {
      if (!cur || cur.board !== file) return;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    },
  };
}
