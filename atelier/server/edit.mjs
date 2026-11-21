// Element edits (atelier_edit and the shell's inspector and layers panel): [{id, style?, text?, attr?, remove?,
// insertBefore?, insertAfter?}] spliced into the board source at the bytes tidmap gives, so an edit of one attribute
// changes only that attribute's bytes. Every id is taken from the version the caller read (expectSha): a stale sha
// is refused, the version before the write is snapshotted (writeBoard), and the hot reload follows from the file watch.
// Agents' edits (/__agent/edit) stay inside the locked scope unless outOfScope gives a reason; the user's own
// (/__atelier/edit, the inspector) are not limited by the scope, which binds agents.
import fs from 'node:fs';
import { fail } from './canvas.mjs';
import { writeBoard } from './sidecar.mjs';
import { versions } from './versions.mjs';
import { tidmap, parseId } from './tidmap.mjs';
import { sendJson, readJson } from './http.mjs';
import { checkScope, follow, src60, idOf, extents, VOID, RAW } from './scope.mjs';

const MAX_EDITS = 50;
const WS = (b) => b === 32 || b === 9 || b === 10 || b === 13 || b === 12;
const hole = (s) => s.includes('{{');
const tidOf = (n) => `#${n.tid}`;
const cut = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// An element whose close tag is left out (<li>one<li>two): where it ends is a guess, so it is never cut by an edit.
const guessed = (n) => `${tidOf(n)} (a ${n.tag}) is closed only by what follows, so where it ends is a guess: edit it by hand at line ${n.line}`;

// ---------- what the source holds ----------

// The attributes of node n's start tag with byte offsets: {name, start, end, vStart, vEnd, quote} (vStart null: no value).
function attrSpans(buf, n) {
  const [a, b] = n.attrs.span, s = buf.subarray(a, b).toString('utf8'), out = [];
  const at = (i) => a + Buffer.byteLength(s.slice(0, i));
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (ws(s[i]) || s[i] === '/')) i++;
    if (i >= s.length) break;
    const n0 = i++;
    while (i < s.length && !ws(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++;
    const name = s.slice(n0, i).toLowerCase();
    let j = i; while (j < s.length && ws(s[j])) j++;
    let v = null;
    if (s[j] === '=') {
      j++; while (j < s.length && ws(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") { const e = s.indexOf(q, j + 1); v = [j + 1, e, q]; i = e + 1; } else { let e = j; while (e < s.length && !ws(s[e])) e++; v = [j, e, '']; i = e; }
    }
    if (!out.some((x) => x.name === name)) out.push({ name, start: at(n0), end: at(i), vStart: v && at(v[0]), vEnd: v && at(v[1]), quote: v ? v[2] : null, value: v ? s.slice(v[0], v[1]) : '' });
  }
  return out;
}

// A style value's declarations: [{name, start, end (the chunk with its ';'), vStart, vEnd}] as char offsets in value,
// the attribute's text as written: an entity is one character (&quot; a quote, the ; of &amp; no end), and a ; inside
// quotes or parentheses (url(data:…;base64,…)) ends nothing.
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/iy;
function declarations(value) {
  const out = [];
  let from = 0, paren = 0, q = '';
  const chunk = (to, end) => {
    const text = value.slice(from, to), c = text.indexOf(':');
    if (c > 0 && text.trim()) {
      const lead = text.length - text.trimStart().length, v0 = c + 1 + (text.slice(c + 1).length - text.slice(c + 1).trimStart().length);
      out.push({ name: text.slice(lead, c).trim().toLowerCase(), start: from, end, vStart: from + v0, vEnd: from + text.trimEnd().length });
    }
    from = end;
  };
  for (let i = 0; i < value.length; i++) {
    let ch = value[i];
    if (ch === '&') { ENTITY.lastIndex = i; const m = ENTITY.exec(value); if (m) { ch = decode(m[0]); i += m[0].length - 1; } }
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === ';' && !paren) chunk(i, i + 1);
  }
  chunk(value.length, value.length);
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A value as it is written inside an attribute quoted with quote.
const encodeIn = (s, quote) => s.replace(/&/g, '&amp;').replace(quote === "'" ? /'/g : /"/g, quote === "'" ? '&#39;' : '&quot;');

// The one run of text node n has of its own, as [from, to) bytes trimmed, or {why}.
function ownText(buf, map, all, n) {
  const ext = all[n.tid];
  if (n.ns !== 'html' || VOID.has(n.tag) || RAW.has(n.tag) || ext.end === n.end) return { why: `a ${n.tag} has no text to edit` };
  const kids = []; for (let t = n.tid + 1; t < n.tid + ext.size; t++) if (map.nodes[t].parent === n.tid) kids.push(t);
  const unsure = [n.tid, ...kids].find((t) => all[t].implied);
  if (unsure !== undefined) return { why: guessed(map.nodes[unsure]) };
  const gaps = []; let from = n.end;
  for (const k of kids) { gaps.push([from, map.nodes[k].start]); from = all[k].end; }
  gaps.push([from, ext.closeAt]);
  const runs = gaps.map(([a, b]) => { while (a < b && WS(buf[a])) a++; while (b > a && WS(buf[b - 1])) b--; return [a, b]; }).filter(([a, b]) => b > a);
  if (runs.length > 1) return { why: `${tidOf(n)} has text in ${runs.length} places between its children: edit it by hand` };
  if (!runs.length) return kids.length ? { why: `${tidOf(n)} has no text of its own: edit a child` } : { range: [n.end, n.end], text: '' };
  const text = buf.subarray(runs[0][0], runs[0][1]).toString('utf8');
  if (/<!--/.test(text)) return { why: `the text of ${tidOf(n)} holds a comment: edit it by hand` };
  return { range: runs[0], text };
}

// ---------- one edit → splices ----------

const NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,60}$/, PROP_RE = /^-{0,2}[a-zA-Z][-a-zA-Z0-9]{0,60}$/;
function styleSplice(buf, n, attrs, style) {
  const a = attrs.find((x) => x.name === 'style');
  if (a && hole(a.value)) fail(422, `the style of ${tidOf(n)} is built with {{ }} holes, which atelier_edit does not merge into; change it with your own edit tool at line ${n.line} (atelier_resolve gives the snippet)`);
  const quote = a?.quote || '"';
  let value = a ? a.value : '';
  const changes = [];
  for (const [k, v] of Object.entries(style)) {
    const prop = k.toLowerCase();
    if (!PROP_RE.test(prop)) fail(400, `not a CSS property: ${cut(k, 40)}`);
    if (v !== null && (typeof v !== 'string' && typeof v !== 'number')) fail(400, `style.${prop} must be a string, or null to remove it`);
    const val = v === null ? null : String(v).trim();
    const ds = declarations(value), d = ds.filter((x) => x.name === prop).at(-1);
    const was = d ? decode(value.slice(d.vStart, d.vEnd)) : null;
    if (was === val) continue; // before the check below: a value read back unchanged may hold a ; (url(data:x;base64,…))
    if (val !== null && (!val || /[;{}<>\n\r]/.test(val) || val.length > 300)) fail(400, `style.${prop}: "${cut(val, 40)}" is not a single CSS value (no ; { } < >)`);
    const raw = val && encodeIn(val, quote);
    if (val === null) {
      if (!d) continue;
      const last = ds.at(-1) === d && !value.slice(d.end - 1, d.end).includes(';');
      const prev = ds[ds.indexOf(d) - 1];
      value = last && prev ? value.slice(0, prev.end - 1) + value.slice(d.end) : value.slice(0, d.start) + value.slice(d.end);
    } else if (d) value = value.slice(0, d.vStart) + raw + value.slice(d.vEnd);
    else {
      const colon = ds.length && /:\s/.test(value.slice(ds[0].start, ds[0].vStart)) ? ': ' : ':', space = /;\s/.test(value) ? ' ' : '';
      const t = value.trimEnd();
      value = !t ? `${prop}${colon}${raw};` : t.endsWith(';') ? `${t}${space}${prop}${colon}${raw};${value.slice(t.length)}` : `${t};${space}${prop}${colon}${raw}${value.slice(t.length)}`;
    }
    changes.push(`${prop} ${was ?? '(none)'} → ${val ?? '(removed)'}`);
  }
  if (!changes.length) return { splices: [], summary: null };
  if (a && a.quote) return { splices: [{ from: a.vStart, to: a.vEnd, text: value }], summary: `${tidOf(n)} style: ${changes.join(', ')}` };
  return { splices: [a ? { from: a.start, to: a.end, text: `style="${value}"` } : insertAttr(n, `style="${value}"`)], summary: `${tidOf(n)} style: ${changes.join(', ')}` };
}
// A new attribute at the end of the start tag, after its last attribute. Every new one of an element goes in one
// splice (newAttrs), so two never run together or come out twice.
const insertAttr = (n, text) => ({ from: n.attrs.span[1], to: n.attrs.span[1], text, attr: true });
function newAttrs(buf, n, splices) {
  const add = splices.filter((x) => x.attr), at = n.attrs.span[1];
  if (!add.length) return splices;
  return [...splices.filter((x) => !x.attr), { from: at, to: at, text: (WS(buf[at - 1]) ? '' : ' ') + add.map((x) => x.text).join(' ') }];
}
// Object b's entries into a, keys lowercased (CSS properties and attribute names are case-insensitive), the last one winning.
const into = (a, b) => { for (const [k, v] of Object.entries(b)) a[k.toLowerCase()] = v; return a; };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function attrSplices(buf, n, attrs, attr) {
  const splices = [], changes = [];
  for (const [k, v] of Object.entries(attr)) {
    const name = k.toLowerCase();
    if (!NAME_RE.test(name)) fail(400, `not an attribute name: ${cut(k, 40)}`);
    if (name === 'style') fail(400, 'set style through style {property: value}, which merges into it');
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') fail(400, `attr.${name} must be a string, or null to remove it`);
    const a = attrs.find((x) => x.name === name), val = v === null ? null : String(v);
    if (a && hole(a.value)) fail(422, `${name} on ${tidOf(n)} is a {{ }} hole; changing it would cut its binding: edit it by hand at line ${n.line}`);
    if (val !== null && val.length > 2000) fail(400, `attr.${name} is over 2000 characters`);
    if (val === null) {
      if (!a) continue;
      let s = a.start; while (s > n.attrs.span[0] && WS(buf[s - 1])) s--;
      splices.push({ from: s, to: a.end, text: '' });
    } else {
      const text = val.replace(/"/g, '&quot;');
      if (a && a.quote === '"') splices.push({ from: a.vStart, to: a.vEnd, text });
      else if (a) splices.push({ from: a.start, to: a.end, text: `${name}="${text}"` });
      else splices.push(insertAttr(n, `${name}="${text}"`));
    }
    if ((a ? a.value : null) !== val) changes.push(`${name} ${a ? `"${cut(a.value, 30)}"` : '(none)'} → ${val === null ? '(removed)' : `"${cut(val, 30)}"`}`);
  }
  return { splices, summary: changes.length ? `${tidOf(n)} attr: ${changes.join(', ')}` : null };
}
function textSplice(buf, map, ext, n, text) {
  if (typeof text !== 'string' || text.length > 4000) fail(400, 'text must be a string of at most 4000 characters');
  if (hole(text)) fail(400, 'text cannot hold {{ }} holes: edit those by hand');
  const own = ownText(buf, map, ext, n);
  if (own.why) fail(422, own.why);
  if (hole(own.text)) fail(422, `the text of ${tidOf(n)} holds a {{ }} hole; replacing it would cut its binding: edit it by hand at line ${n.line}`);
  const now = encode(text.trim());
  if (now === own.text) return { splices: [], summary: null };
  return { splices: [{ from: own.range[0], to: own.range[1], text: now }], summary: `${tidOf(n)} text: "${cut(decode(own.text), 40)}" → "${cut(text.trim(), 40)}"` };
}

// Line helpers: the start of off's line when only spaces and tabs come before it there, and the byte after the newline
// that ends the line at end when only spaces and tabs follow; else null.
const lineStartIfAlone = (buf, off) => { let i = off; while (i > 0 && (buf[i - 1] === 32 || buf[i - 1] === 9)) i--; return i === 0 || buf[i - 1] === 10 ? i : null; };
const lineEndIfAlone = (buf, end) => { let i = end; while (i < buf.length && (buf[i] === 32 || buf[i] === 9 || buf[i] === 13)) i++; return buf[i] === 10 ? i + 1 : null; };
function moveSplices(buf, map, ext, n, targetId, after) {
  const p = parseId(targetId) || fail(400, `${after ? 'insertAfter' : 'insertBefore'} must be an element id`);
  const t = map.nodes[p.tid];
  if (!t || (p.path !== null && t.path !== p.path)) fail(409, `${targetId} is not in this version of the file: read the tree again`);
  if (p.repeat !== null) fail(400, 'move by the template element (an id without @k), not one repeat of it');
  if (t.parent !== n.parent || t.tid === n.tid) fail(400, `${after ? 'insertAfter' : 'insertBefore'} must be a sibling of ${tidOf(n)} (the same parent in the source)`);
  const e = ext[n.tid], te = ext[t.tid];
  for (const x of [n, t]) if (ext[x.tid].implied) fail(422, guessed(x));
  const ls = lineStartIfAlone(buf, e.start), le = lineEndIfAlone(buf, e.end);
  const at = after ? lineEndIfAlone(buf, te.end) : lineStartIfAlone(buf, te.start);
  // Each on lines of its own: whole lines move, indentation and all. Else the element alone, between its neighbours.
  const [from, to, at2] = ls !== null && le !== null && at !== null ? [ls, le, at] : [e.start, e.end, after ? te.end : te.start];
  const piece = buf.subarray(from, to).toString('utf8');
  return { splices: [{ from, to, text: '' }, { from: at2, to: at2, text: piece }], summary: `${tidOf(n)} moved ${after ? 'after' : 'before'} ${tidOf(t)}` };
}
function removeSplice(buf, ext, n) {
  const e = ext[n.tid], ls = lineStartIfAlone(buf, e.start), le = lineEndIfAlone(buf, e.end);
  if (e.implied) fail(422, guessed(n));
  const [from, to] = ls !== null && le !== null ? [ls, le] : [e.start, e.end];
  return { splices: [{ from, to, text: '' }], summary: `${tidOf(n)} ${n.tag} removed` };
}

// ---------- the edit ----------

// Splices against one buffer, all at its offsets: refused when two overlap; else applied in order of position.
function apply(buf, splices) {
  const list = splices.map((s, i) => ({ ...s, i })).sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from) || a.i - b.i);
  for (let k = 1; k < list.length; k++) {
    const a = list[k - 1], b = list[k];
    if (b.from < a.to && (b.to > b.from || b.from > a.from)) fail(400, 'two edits touch the same bytes (e.g. a move or remove and a change inside it): send them in separate calls');
  }
  const parts = []; let at = 0;
  for (const s of list) { parts.push(buf.subarray(at, s.from), Buffer.from(s.text)); at = s.to; }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}

// Changed lines between two versions: one hunk from the first to the last differing line (at most 20 each way).
function lineDiff(a, b) {
  const A = a.toString('utf8').split('\n'), B = b.toString('utf8').split('\n');
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const clip = (x) => cut(x.trim(), 200);
  return { line: p + 1, removed: A.slice(p, A.length - s).slice(0, 20).map(clip), added: B.slice(p, B.length - s).slice(0, 20).map(clip) };
}

/** edit(c, b, {agent}) inside the canvas lock. b: {expectSha, edits:[{id, style?, text?, attr?, remove?, insertBefore?,
 *  insertAfter?}], outOfScope?, follow?: [ids also to follow into ids]}. → {file, sha, before, version, changed, summary, diff, ids: {old id: new id | null},
 *  outOfScope?}. agent: the locked scope applies. */
export function edit(c, b, { agent }) {
  const edits = Array.isArray(b.edits) ? b.edits : fail(400, 'edits must be a list of {id, style?, text?, attr?, remove?, insertBefore?, insertAfter?}');
  if (!edits.length || edits.length > MAX_EDITS) fail(400, `edits must hold 1-${MAX_EDITS} edits`);
  const ids = edits.map((e) => (e && typeof e === 'object' ? parseId(e.id) : null) || fail(400, 'each edit needs an element id File.dc.html#<tid>:<path>'));
  const file = ids[0].file;
  if (ids.some((p) => p.file !== file)) fail(400, 'one board per call: every id must be on the same file');
  if (typeof b.expectSha !== 'string') fail(400, 'expectSha is required: the sha atelier_resolve or atelier_tree gave');
  const f = c.file(file);
  let buf; try { buf = fs.readFileSync(f); } catch { fail(404, 'no such board file'); }
  const map = tidmap(buf);
  if (map.sha !== b.expectSha) fail(409, 'stale: the file changed since you read it; resolve again and use the new sha', { sha: map.sha });
  if (!map.found) fail(404, 'the board has no <x-dc> template');
  const ext = extents(map, buf);
  const splices = [], summary = [];
  // The edits of one element (its id, or any repeat of it) merge first: style keys into one style, attributes by
  // name, the last text; each element's changes then come out as one splice per attribute.
  const byTid = new Map();
  edits.forEach((e, i) => {
    const p = ids[i], n = map.nodes[p.tid] || fail(404, `no element with tid ${p.tid}`);
    if (p.path !== null && n.path !== p.path) fail(409, `tid ${p.tid} is at ${n.path} in this file, not ${p.path}: the id comes from another version`);
    const ops = ['style', 'text', 'attr', 'remove', 'insertBefore', 'insertAfter'].filter((k) => e[k] !== undefined && e[k] !== false);
    if (!ops.length) fail(400, `edit ${i + 1} changes nothing: give style, text, attr, remove, insertBefore or insertAfter`);
    if (ops.filter((k) => ['remove', 'insertBefore', 'insertAfter'].includes(k)).length > 1) fail(400, 'one of remove, insertBefore, insertAfter per edit');
    if (e.style !== undefined && !isObj(e.style)) fail(400, `style must be an object of CSS properties, e.g. {"gap": "10px"}`);
    if (e.attr !== undefined && !isObj(e.attr)) fail(400, 'attr must be an object of attribute names to values (null removes one)');
    if (!byTid.has(n.tid)) byTid.set(n.tid, { n, repeat: false, style: null, attr: null, text: undefined, moves: [] });
    const m = byTid.get(n.tid);
    m.repeat ||= p.repeat !== null;
    if (e.style !== undefined) m.style = into(m.style || {}, e.style);
    if (e.attr !== undefined) m.attr = into(m.attr || {}, e.attr);
    if (e.text !== undefined) m.text = e.text;
    if (e.remove === true || e.insertBefore !== undefined || e.insertAfter !== undefined) m.moves.push(e);
  });
  for (const { n, repeat, style, attr, text, moves } of byTid.values()) {
    const attrs = attrSpans(buf, n);
    const parts = [
      style && styleSplice(buf, n, attrs, style),
      attr && attrSplices(buf, n, attrs, attr),
      text !== undefined && textSplice(buf, map, ext, n, text),
      ...moves.map((e) => (e.remove === true ? removeSplice(buf, ext, n) : moveSplices(buf, map, ext, n, e.insertBefore ?? e.insertAfter, e.insertAfter !== undefined))),
    ].filter(Boolean);
    splices.push(...newAttrs(buf, n, parts.flatMap((r) => r.splices)));
    for (const r of parts) if (r.summary) summary.push(r.summary + (repeat ? ' (every repeat)' : ''));
  }
  const base = { file, before: map.sha };
  if (!splices.length) return { ...base, sha: map.sha, changed: 0, summary: ['nothing to change: the values are already there'], ids: Object.fromEntries(edits.map((e) => [e.id, e.id])) };

  let outOfScope;
  if (agent) {
    const r = checkScope(c, file, { ranges: splices.map((s) => [s.from, s.to]) }, { src: buf });
    if (!r.ok) {
      const why = typeof b.outOfScope === 'string' ? b.outOfScope.trim().slice(0, 300) : '';
      if (!why) fail(403, `Refused: outside the locked part (${r.scope.label || r.scope.kind}). Ask the user, or pass outOfScope with a reason.`, { outside: r.outside });
      outOfScope = { reason: why, outside: r.outside };
    }
  }
  const after = apply(buf, splices);
  const sha = writeBoard(c, file, after, b.expectSha);
  const now = tidmap(after);
  // Where each edited element is now, and each id in b.follow (a caller's selection) on that board.
  const removed = new Set(edits.filter((e) => e.remove === true).map((e) => e.id));
  const extra = (Array.isArray(b.follow) ? b.follow.slice(0, 20) : []).map((id) => [id, parseId(id)]).filter(([, p]) => p?.file === file && map.nodes[p.tid]);
  const newIds = Object.fromEntries([...edits.map((e, i) => [e.id, ids[i]]), ...extra].map(([id, p]) => {
    if (removed.has(id)) return [id, null];
    const n = map.nodes[p.tid], m = follow({ id, tag: n.tag, text60: src60(n) }, map, now);
    return [id, m ? idOf(file, m, p.repeat) : null];
  }));
  return { ...base, sha, version: versions(c.dir, file).at(-1) ?? null, changed: summary.length, summary, diff: lineDiff(buf, after), ids: newIds,
    ...(outOfScope ? { outOfScope } : {}),
    note: 'The board reloads by itself. Ids after a moved, removed or inserted element shift: take fresh ones from ids or atelier_tree.' };
}

/** What the inspector shows for an element, from the source: its style declarations, own text and what can be edited. */
export function element(c, id) {
  const p = parseId(id) || fail(400, 'id must look like File.dc.html#<tid>:<path>[@k]');
  let buf; try { buf = fs.readFileSync(c.file(p.file)); } catch (e) { if (e.status) throw e; fail(404, 'no such board file'); }
  const map = tidmap(buf), n = map.nodes[p.tid] || fail(404, `no element with tid ${p.tid}`, { sha: map.sha });
  if (p.path !== null && n.path !== p.path) fail(409, `tid ${p.tid} is at ${n.path} in this file, not ${p.path}`, { sha: map.sha });
  const ext = extents(map, buf), attrs = attrSpans(buf, n), st = attrs.find((a) => a.name === 'style');
  const own = ownText(buf, map, ext, n);
  const style = st && !hole(st.value) ? Object.fromEntries(declarations(st.value).map((d) => [d.name, decode(st.value.slice(d.vStart, d.vEnd))])) : st ? null : {};
  return {
    id, file: p.file, tid: n.tid, tag: n.tag, line: n.line, sha: map.sha, style, ...(style === null ? { styleWhy: 'built with {{ }} holes: edit it by hand' } : {}),
    text: own.why || hole(own.text) ? null : decode(own.text), ...(own.why ? { textWhy: own.why } : hole(own.text ?? '') ? { textWhy: 'holds a {{ }} hole' } : {}),
    attrs: attrs.filter((a) => a.name !== 'style').map((a) => ({ name: a.name, value: cut(a.value, 200) })),
  };
}

/** Routes for api.mjs, after its token check, as mountComments: POST /__agent/edit (an agent's, scope-checked),
 *  POST /__atelier/edit (the user's, from the shell) and GET /__atelier/element?canvas&id. ctx: {registry}. */
export function mountEdit({ registry }) {
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');
  const route = (req, url) => {
    if (req.method === 'GET' && url.pathname === '/__atelier/element') return async () => element(canvasOf(url.searchParams.get('canvas')), url.searchParams.get('id'));
    if (req.method !== 'POST' || (url.pathname !== '/__agent/edit' && url.pathname !== '/__atelier/edit')) return null;
    const agent = url.pathname === '/__agent/edit';
    return async () => { const b = await readJson(req), c = canvasOf(b.canvas); return c.locked(() => edit(c, b, { agent })); };
  };
  return (req, res, url) => {
    const run = route(req, url);
    if (!run) return false;
    run().then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  };
}
