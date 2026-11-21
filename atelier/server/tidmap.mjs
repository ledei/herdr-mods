// tid ↔ source map for .dc.html boards. A tid is the number the dc-runtime gives each template element (data-dc-tpl).
// The runtime (vendor/runtime/support.js: tt, Yt, _e) takes the text between the first /<x-dc(\s[^>]*)?>/ and the last
// </x-dc>, rewrites it (self-closed <dc-import/>/<x-import/> get a close tag; helmet → sc-helmet; table, tbody, thead,
// tfoot, tr, td, th, caption, select → sc-raw-*, so they parse as plain unknown elements), sets it as a <template>'s
// innerHTML and numbers every element of the parsed content depth-first from 0 (elements inside a nested <template>
// are not numbered: the walk follows childNodes, which a template element does not have).
// This file mirrors that with a small HTML tokenizer and tree builder instead of a DOM; scripts/check-tids.mjs proves
// it against the runtime on every board. The path is Claude's (view-state.md): index among the fragment's top-level
// elements, then the index among each parent's element children.
import fs from 'node:fs';
import { sha256, fail } from './canvas.mjs';

const set = (s) => new Set(s.split(' '));
const VOID = set('area base br col embed hr img input link meta param source track wbr keygen basefont bgsound frame');
const RAW = set('script style xmp iframe noembed noframes noscript textarea title'); // raw text / RCDATA: no tags inside
const IGNORED = set('html head body frameset frame col colgroup'); // start tags the parser drops in a template
// Start tags that close an open <p> first. table is not here: the runtime renames it.
const CLOSES_P = set('address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p search section summary ul h1 h2 h3 h4 h5 h6 pre listing form plaintext xmp hr');
const HEADINGS = set('h1 h2 h3 h4 h5 h6');
// "Special" elements (HTML spec) minus the renamed table/select family.
const SPECIAL = set('address applet area article aside base basefont bgsound blockquote body br button center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section source style summary template textarea title track ul wbr xmp');
const SCOPE = set('applet marquee object template');
const FOREIGN_SCOPE = set('foreignobject desc title mi mo mn ms mtext annotation-xml');
const INTEGRATION = set('foreignobject desc title'); // svg elements whose children parse as HTML
const MATH_TEXT = set('mi mo mn ms mtext');
const BREAKOUT = set('b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var');
const FORMATTING = set('a b big code em font i nobr s small strike strong tt u');
const WS = /[\t\n\f\r ]/;
const lower = (s) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

function special(n) { return n.ns === 'html' ? SPECIAL.has(n.tag) : FOREIGN_SCOPE.has(n.tag); }
function boundary(n, extra) { return n.ns === 'html' ? SCOPE.has(n.tag) || (extra && extra.has(n.tag)) : FOREIGN_SCOPE.has(n.tag); }

// Attributes from i (just after the tag name) to the end of the tag. Returns {attrs, end (index after '>'), selfClosing,
// attrEnd} or null when the file ends inside the tag (the HTML tokenizer then drops the tag).
function scanAttrs(s, i, limit) {
  const attrs = [];
  for (;;) {
    while (i < limit && WS.test(s[i])) i++;
    if (i >= limit) return null;
    const ch = s[i];
    if (ch === '>') return { attrs, attrEnd: i, end: i + 1, selfClosing: false };
    if (ch === '/') {
      if (s[i + 1] === '>') return { attrs, attrEnd: i, end: i + 2, selfClosing: true };
      i++; continue;
    }
    const n0 = i;
    i++; // the first character may be '=' (spec: attribute name state)
    while (i < limit && !WS.test(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++;
    const name = lower(s.slice(n0, i));
    let j = i;
    while (j < limit && WS.test(s[j])) j++;
    let value = '';
    if (s[j] === '=') {
      j++;
      while (j < limit && WS.test(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0 || e >= limit) return null;
        value = s.slice(j + 1, e); i = e + 1;
      } else {
        let e = j;
        while (e < limit && !WS.test(s[e]) && s[e] !== '>') e++;
        value = s.slice(j, e); i = e;
      }
    }
    if (!attrs.some((a) => a.name === name)) attrs.push({ name, value }); // a repeated attribute is dropped
  }
}

// Parses the template part of a board. Returns {found, nodes}; nodes[tid] = {tid, tag, ns, path, parent, start, end,
// attrStart, attrEnd, attrs, text, own} with string indices (locate() converts them to bytes and lines).
function parseTemplate(src) {
  const open = /<x-dc(?:\s[^>]*)?>/.exec(src);
  const close = src.lastIndexOf('</x-dc>');
  if (!open || close < open.index) return { found: false, nodes: [] };
  const from = open.index + open[0].length, limit = close;
  const nodes = [], root = { tag: '#root', ns: 'html', kids: 0, root: true };
  const stack = [root];
  let hidden = 0; // depth inside a nested <template>: its elements are not numbered
  const cur = () => stack[stack.length - 1];

  function insert(tag, ns, at, tok, selfClose) {
    const parent = cur();
    const n = { tag, ns, kids: 0 };
    if (!hidden) {
      n.tid = nodes.length;
      n.parent = parent.root ? -1 : parent.tid;
      n.path = parent.root ? String(parent.kids) : `${parent.path}/${parent.kids}`;
      parent.kids++;
      Object.assign(n, { start: at, end: tok ? tok.end : at, attrStart: tok ? tok.attrStart : at, attrEnd: tok ? tok.attrEnd : at, attrs: tok ? tok.attrs : [], text: '', own: '' });
      nodes.push(n);
    }
    if (!selfClose) { stack.push(n); if (tag === 'template' && ns === 'html') hidden++; }
    return n;
  }
  function popTo(i) { // pops stack[i] and everything above it
    while (stack.length > i) { const n = stack.pop(); if (n.tag === 'template' && n.ns === 'html' && hidden) hidden--; }
  }
  const find = (pred, stop) => { // index of the nearest open element matching pred, or -1 when a stop element comes first
    for (let i = stack.length - 1; i > 0; i--) { if (pred(stack[i])) return i; if (stop(stack[i])) return -1; }
    return -1;
  };
  const inScope = (tag, extra) => find((n) => n.ns === 'html' && n.tag === tag, (n) => boundary(n, extra));
  const BUTTON = set('button'), LIST = set('ol ul');
  function closeP() { const i = inScope('p', BUTTON); if (i > 0) popTo(i); }
  function text(t) {
    if (hidden || !t) return;
    const c = cur();
    if (!c.root && c.own.length < 60) c.own += (c.own ? ' ' : '') + t.slice(0, 60);
    for (let i = stack.length - 1; i > 0; i--) { const n = stack[i]; if (n.text.length < 60) n.text += (n.text ? ' ' : '') + t.slice(0, 60); }
  }
  const foreignCurrent = () => { const c = cur(); return !c.root && c.ns !== 'html' && !(c.ns === 'svg' && INTEGRATION.has(c.tag)) && !(c.ns === 'math' && MATH_TEXT.has(c.tag)); };

  function startTag(tag, at, tok) {
    // Foreign content: everything is an element of the current namespace, unless it breaks out to HTML.
    if (foreignCurrent()) {
      const out = BREAKOUT.has(tag) || (tag === 'font' && tok.attrs.some((a) => a.name === 'color' || a.name === 'face' || a.name === 'size'));
      if (!out) return insert(tag, cur().ns, at, tok, tok.selfClosing);
      while (foreignCurrent()) popTo(stack.length - 1);
    }
    if (tag === 'svg' || tag === 'math') return insert(tag, tag, at, tok, tok.selfClosing);
    if (tag === 'image') tag = 'img';
    if (IGNORED.has(tag)) return null;
    if (CLOSES_P.has(tag)) closeP();
    if (HEADINGS.has(tag) && HEADINGS.has(cur().tag) && cur().ns === 'html') popTo(stack.length - 1);
    if (tag === 'li' || tag === 'dd' || tag === 'dt') {
      const same = tag === 'li' ? (n) => n.tag === 'li' : (n) => n.tag === 'dd' || n.tag === 'dt';
      const i = find((n) => n.ns === 'html' && same(n), (n) => special(n) && !['address', 'div', 'p'].includes(n.tag));
      if (i > 0) popTo(i);
      closeP();
    }
    if (tag === 'button') { const i = inScope('button'); if (i > 0) popTo(i); }
    if ((tag === 'option' || tag === 'optgroup') && cur().tag === 'option') popTo(stack.length - 1);
    // shortcut: a second <a> (or <nobr>) while one is open just closes it; the spec's adoption agency, and the
    // reconstruction of formatting elements it can clone, are not mirrored. check-tids reports it if a board needs it.
    if (tag === 'a' || tag === 'nobr') { const i = find((n) => n.ns === 'html' && n.tag === tag, (n) => boundary(n)); if (i > 0) popTo(i); }
    const selfClose = VOID.has(tag) || (tok.selfClosing && (tag === 'dc-import' || tag === 'x-import'));
    return insert(tag, 'html', at, tok, selfClose);
  }

  function endTag(tag, at) {
    if (!cur().root && cur().ns !== 'html') { // end tags use the foreign rules even at an integration point (</title>, </foreignObject>)
      for (let i = stack.length - 1; i > 0; i--) {
        const n = stack[i];
        if (n.ns === 'html') break; // falls through to the HTML rules below
        if (n.tag === tag) return popTo(i);
      }
    }
    if (tag === 'p') { if (inScope('p', BUTTON) < 0) insert('p', 'html', at, null, true); else closeP(); return; }
    if (tag === 'br') { insert('br', 'html', at, null, true); return; }
    if (tag === 'body' || tag === 'html') return;
    if (HEADINGS.has(tag)) { const i = find((n) => n.ns === 'html' && HEADINGS.has(n.tag), (n) => boundary(n)); if (i > 0) popTo(i); return; }
    if (tag === 'li') { const i = inScope('li', LIST); if (i > 0) popTo(i); return; }
    if (SPECIAL.has(tag) || FORMATTING.has(tag)) { const i = inScope(tag); if (i > 0) popTo(i); return; }
    for (let i = stack.length - 1; i > 0; i--) { // any other end tag
      const n = stack[i];
      if (n.ns === 'html' && n.tag === tag) return popTo(i);
      if (special(n)) return;
    }
  }

  let i = from;
  const isAlpha = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
  const pastGt = (k) => { const e = src.indexOf('>', k); return e < 0 || e >= limit ? limit : e + 1; };
  const nameEnd = (k) => { while (k < limit && !WS.test(src[k]) && src[k] !== '/' && src[k] !== '>') k++; return k; };
  while (i < limit) {
    const c = cur();
    if (c.ns === 'html' && !c.root && RAW.has(c.tag)) { // raw text: runs to </tag followed by space, / or >
      const re = new RegExp(`</${c.tag}[\\t\\n\\f\\r />]`, 'gi');
      re.lastIndex = i;
      const m = re.exec(src);
      const e = m && m.index < limit ? m.index : limit;
      text(src.slice(i, e).trim());
      if (e >= limit) break;
      const t = scanAttrs(src, e + 2 + c.tag.length, limit);
      popTo(stack.length - 1);
      if (!t) break;
      i = t.end; continue;
    }
    if (c.ns === 'html' && c.tag === 'plaintext') break;
    const lt = src.indexOf('<', i);
    const stop = lt < 0 || lt >= limit ? limit : lt;
    if (stop > i) text(src.slice(i, stop).replace(/\s+/g, ' ').trim());
    if (stop >= limit) break;
    i = stop;
    const n1 = src[i + 1];
    if (src.startsWith('<!--', i)) {
      if (src[i + 4] === '>') { i += 5; continue; }
      if (src.startsWith('->', i + 4)) { i += 6; continue; }
      const ends = [['-->', 3], ['--!>', 4]].map(([t, n]) => { const e = src.indexOf(t, i + 4); return e < 0 || e >= limit ? limit : e + n; });
      i = Math.min(...ends);
      continue;
    }
    if (n1 === '!' || n1 === '?') {
      if (src.startsWith('<![CDATA[', i) && cur().ns !== 'html') { const e = src.indexOf(']]>', i); i = e < 0 ? limit : e + 3; continue; }
      i = pastGt(i); continue; // bogus comment
    }
    if (n1 === '/') {
      if (src[i + 2] === '>') { i += 3; continue; }
      if (!isAlpha(src[i + 2])) { i = pastGt(i); continue; }
      const j = nameEnd(i + 2);
      const t = scanAttrs(src, j, limit);
      if (!t) break;
      endTag(lower(src.slice(i + 2, j)), i);
      i = t.end; continue;
    }
    if (isAlpha(n1)) {
      const j = nameEnd(i + 1);
      const t = scanAttrs(src, j, limit);
      if (!t) break;
      startTag(lower(src.slice(i + 1, j)), i, { ...t, attrStart: j });
      i = t.end; continue;
    }
    text('<'); i++;
  }
  for (const n of nodes) delete n.kids;
  return { found: true, nodes };
}

// Adds byte offsets and 1-based line/col to each node (one pass, since nodes are in source order).
function locate(src, nodes) {
  let ci = 0, bi = 0, line = 1, lineStart = 0;
  const to = (k) => {
    const part = src.slice(ci, k);
    bi += Buffer.byteLength(part);
    for (let p = part.indexOf('\n'); p >= 0; p = part.indexOf('\n', p + 1)) { line++; lineStart = ci + p + 1; }
    ci = k;
    return bi;
  };
  // Nodes are in tid order, which is source order except for the empty elements a stray </p> or </br> inserts.
  const order = [...nodes].sort((a, b) => a.start - b.start || a.tid - b.tid);
  for (const n of order) {
    const sChar = n.start, eChar = n.end;
    n.start = to(sChar); n.line = line; n.col = sChar - lineStart + 1;
    const as = to(n.attrStart), ae = to(n.attrEnd);
    n.end = to(eChar);
    n.attrs = { span: [as, ae], list: n.attrs };
    n.snippet = src.slice(sChar, Math.min(eChar, sChar + 160)).replace(/\s+/g, ' ');
    delete n.attrStart; delete n.attrEnd;
  }
  return nodes;
}

const cache = new Map(); // sha → map
const CACHE_MAX = 64;

/** tidmap(buf|string) → {sha, found, nodes}. nodes[tid] = {tid, tag, ns, path, parent, start, end (byte offsets of the start
 * tag), line, col, attrs:{span:[s,e] (bytes), list:[{name,value}]}, text (first words inside), own (its own text), snippet (≤160 chars)}. Cached by sha. */
export function tidmap(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const sha = sha256(buf);
  const hit = cache.get(sha);
  if (hit) { cache.delete(sha); cache.set(sha, hit); return hit; }
  const src = buf.toString('utf8');
  const p = parseTemplate(src);
  const map = { sha, found: p.found, nodes: locate(src, p.nodes) };
  cache.set(sha, map);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return map;
}

// Claude's selection id grammar (view-state.md), with the path optional for older anchors ("File.dc.html#12").
const ID_RE = /^((?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2}){1,200}\.dc\.html)#(\d{1,4})(?::(\d{1,2}(?:\/\d{1,2}){0,8}))?(?:@(\d{1,3}))?$/;

// The id of a template element. A path the grammar cannot carry (more than 8 levels below a top-level element, or an
// index past 99) is left out, as Claude leaves such elements out; the tid alone still resolves.
const PATH_RE = /^\d{1,2}(?:\/\d{1,2}){0,8}$/;
export const idFor = (file, tid, p) => `${file}#${tid}${PATH_RE.test(p) ? ':' + p : ''}`;

export function parseId(id) {
  const m = typeof id === 'string' && id.length <= 220 ? ID_RE.exec(id) : null;
  if (!m) return null;
  return { file: m[1], tid: Number(m[2]), path: m[3] ?? null, repeat: m[4] != null ? Number(m[4]) : null };
}

/** resolve(canvas, id) → {id, file, tid, tag, path, repeat, line, col, start, end, snippet, sha}. Throws 400 on a bad id,
 * 404 when the file or tid is missing, 409 when tid and path disagree (the id was taken from another copy of the file). */
export function resolve(c, id) {
  const p = parseId(id) || fail(400, 'id must look like File.dc.html#<tid>:<path>[@k]');
  // Board names are limited to [A-Za-z0-9_.-] (canvas.mjs FILE_RE), which percent-encoding leaves as they are.
  let buf; try { buf = fs.readFileSync(c.file(p.file)); } catch (e) { if (e.status) throw e; fail(404, 'no such board file'); }
  const map = tidmap(buf);
  if (!map.found) fail(404, 'the board has no <x-dc> template', { sha: map.sha });
  const n = map.nodes[p.tid] || fail(404, `no element with tid ${p.tid}`, { sha: map.sha });
  if (p.path !== null && p.path !== n.path) fail(409, `tid ${p.tid} is at ${n.path} in this file, not ${p.path}: the id comes from another version`, { sha: map.sha });
  return { id, file: p.file, tid: n.tid, tag: n.tag, path: n.path, repeat: p.repeat, line: n.line, col: n.col, start: n.start, end: n.end, snippet: n.snippet, sha: map.sha };
}

const LABEL_ATTRS = ['aria-label', 'data-screen-label'];
const NOT_RENDERED = set('helmet script style template link meta title');
const attr = (n, name) => n.attrs.list.find((a) => a.name === name)?.value;

/** The board's layers from source only (no shell open): rendered elements as {id, tid, tag, label, bbox:null, text60, children},
 * sc-for/sc-if unwrapped, helmet/script/style left out, wrappers collapsed, svg as a leaf. */
export function sourceTree(file, map, { depth = 8, root = null } = {}) {
  const kids = new Map();
  for (const n of map.nodes) { const k = kids.get(n.parent) || []; k.push(n); kids.set(n.parent, k); }
  const label = (n) => (LABEL_ATTRS.map((a) => attr(n, a)).find(Boolean) || n.text || n.tag).slice(0, 60);
  const shown = (parentTid) => (kids.get(parentTid) || []).flatMap((n) => (n.tag === 'sc-for' || n.tag === 'sc-if' ? shown(n.tid) : NOT_RENDERED.has(n.tag) ? [] : [n]));
  const wrapper = (n, ch) => n.tag === 'div' && ch.length === 1 && !n.own && !LABEL_ATTRS.some((a) => attr(n, a)) && !attr(n, 'style') && !attr(n, 'class');
  function build(n, d) {
    let ch = n.tag === 'svg' ? [] : shown(n.tid);
    while (wrapper(n, ch)) { n = ch[0]; ch = n.tag === 'svg' ? [] : shown(n.tid); }
    return { id: idFor(file, n.tid, n.path), tid: n.tid, tag: n.tag, label: label(n), bbox: null, text60: n.text.slice(0, 60), children: d < depth ? ch.map((k) => build(k, d + 1)) : [], ...(d >= depth && ch.length ? { more: ch.length } : {}) };
  }
  const top = root === null ? shown(-1) : [map.nodes[root]].filter(Boolean);
  return top.map((n) => build(n, 1));
}
