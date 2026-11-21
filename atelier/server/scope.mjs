// Where an element is in a board file across versions, and whether a change stays inside the scope the user locked.
// The scope is view-state's scope {kind: "board"|"element"|"region", ids, rect?, label?, sha?}, non-null only while
// locked. board: ids are board files, the whole file is inside. element and region: ids are element ids (a region's are
// the elements inside its rect, taken when it was locked); an element's extent is its source from its start tag to the
// end of its own close tag. sha {file: sha256} names the file version the ids were taken from, so they are followed
// (as comment anchors are) to the version being checked.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, FILE_RE } from './canvas.mjs';
import { versions, versionPath } from './versions.mjs';
import { tidmap, parseId, idFor } from './tidmap.mjs';

// ---------- following an element through edits (comment anchors, scope ids) ----------

export const src60 = (n) => n.text.slice(0, 60);
const sig = (n) => `${n.tag}\0${n.attrs.list.map((a) => `${a.name}=${a.value}`).join('\u0001')}\0${n.own}`;
// Same slot, same tag and attributes: a text edit of that element (Save → Save changes), whatever its text.
const attrs = (n) => n.attrs.list.map((a) => `${a.name}=${a.value}`).join('\u0001');
const commonPrefix = (p, q) => { let i = 0; while (i < p.length && i < q.length && p[i] === q[i]) i++; return i; };

// The one node of list with tag and source text text60 nearest the path want (an id's path), or null when two are as near.
function nearest(list, tag, text60, want) {
  const w = (want ?? '').split('/'), near = (x) => commonPrefix(x.path.split('/'), w);
  const same = list.filter((x) => x.tag === tag && src60(x) === text60).sort((a, b) => near(b) - near(a));
  return same.length && (same.length === 1 || near(same[0]) > near(same[1])) ? same[0] : null;
}
// Text that is still mostly the same: equal, or sharing a start or an end at least half as long as the longer one.
const alike = (p, q) => p === q || Math.max(commonPrefix(p, q), commonPrefix([...p].reverse(), [...q].reverse())) * 2 >= Math.max(p.length, q.length);

/** The node of map that anchor's element ({id, tag, text60}, taken from oldMap) is now, or null. oldMap null: that
 *  version is gone. Nodes are aligned by their common prefix and suffix (tag, attributes and own text alike). An element
 *  in the changed part between them is followed when exactly one element there is identical to it (moved); when the
 *  part kept its elements' tags in order and the one in its place has its tag and mostly its text or all its attributes, and is not another
 *  old element unchanged (edited in place); else to the one element there with its tag and text nearest its path.
 *  Without the old version: the same tid with the same tag, path and text, else the one element with the same tag and
 *  text nearest the old path. */
export function follow(anchor, oldMap, map) {
  const p = parseId(anchor.id);
  const B = map.nodes;
  if (oldMap && oldMap.nodes[p.tid] && (p.path === null || oldMap.nodes[p.tid].path === p.path)) {
    const A = oldMap.nodes, was = A[p.tid];
    let pre = 0; while (pre < A.length && pre < B.length && sig(A[pre]) === sig(B[pre])) pre++;
    let suf = 0; while (suf < A.length - pre && suf < B.length - pre && sig(A[A.length - 1 - suf]) === sig(B[B.length - 1 - suf])) suf++;
    if (p.tid < pre) return B[p.tid];
    if (p.tid >= A.length - suf) return B[p.tid + B.length - A.length];
    const ra = A.slice(pre, A.length - suf), rb = B.slice(pre, B.length - suf);
    const moved = rb.filter((n) => sig(n) === sig(was));
    if (moved.length === 1) return moved[0];
    const now = B[p.tid];
    if (ra.length === rb.length && ra.every((n, i) => n.tag === rb[i].tag) && now.tag === was.tag && (alike(src60(now), src60(was)) || attrs(now) === attrs(was))
      && !ra.some((n) => n !== was && sig(n) === sig(now))) return now;
    return src60(was) ? nearest(rb, was.tag, src60(was), p.path) : null;
  }
  const n = B[p.tid];
  if (n && n.tag === anchor.tag && (p.path === null || n.path === p.path) && (!anchor.text60 || src60(n) === anchor.text60)) return n;
  return anchor.text60 ? nearest(B, anchor.tag, anchor.text60, p.path) : null;
}
export const idOf = (file, n, repeat) => idFor(file, n.tid, n.path) + (repeat != null ? `@${repeat}` : '');

const versionSha = new Map(); // version path → sha (a version file never changes)
// The kept versions of file (paths, oldest first) from the one whose sha256 is sha; none when that one is not kept.
function versionsFrom(dir, file, sha) {
  const list = versions(dir, file);
  for (let i = list.length - 1; i >= 0; i--) {
    const v = versionPath(dir, file, list[i]);
    let s = versionSha.get(v);
    if (!s) { try { s = sha256(fs.readFileSync(v)); } catch { continue; } versionSha.set(v, s); }
    if (s === sha) return list.slice(i).map((ts) => versionPath(dir, file, ts));
  }
  return [];
}
const followed = new Map(); // "<dir>|<file>|<id>|<from sha>|<to sha>" → the anchor that came out, or null
/** anchor {id, tag, text60, fileSha} followed to map (a later version of the same file), one step per version kept
 *  since fileSha: each step is one edit, small enough to align. Its own version gone: one step from what it says.
 *  → the anchor as it is in map {id, tag, text60, fileSha}, or null when the element was lost on the way. */
export function followThrough(dir, file, anchor, map) {
  if (anchor.fileSha === map.sha) return anchor;
  const key = [dir, file, anchor.id, anchor.fileSha, map.sha].join('|');
  if (followed.has(key)) return followed.get(key);
  const steps = versionsFrom(dir, file, anchor.fileSha);
  const p = parseId(anchor.id);
  let a = anchor, prev = null;
  for (const v of [...steps.map((f) => tidmap(fs.readFileSync(f))), map]) {
    if (v.sha === a.fileSha) { prev = v; continue; }
    const n = follow(a, prev, v);
    if (!n) { a = null; break; }
    a = { ...a, id: idOf(file, n, p.repeat), tag: n.tag, text60: src60(n), fileSha: v.sha };
    prev = v;
  }
  if (followed.size > 500) followed.clear();
  followed.set(key, a);
  return a;
}

// ---------- extents ----------

export const VOID = new Set('area base br col embed hr img input link meta param source track wbr keygen basefont bgsound frame'.split(' '));
export const RAW = new Set('script style xmp iframe noembed noframes noscript textarea title'.split(' '));
// [start, end) byte extent of every node: from its start tag to the end of its own close tag. Between its last
// descendant and the next element outside it there is only text, comments and close tags, so the first </tag> there
// (with as many <tag> opened as closed: a nested <template>'s unnumbered elements) is its own. A void or self-closed
// element ends with its start tag. closeAt: where its close tag starts (its end when it has none).
// implied: the extent is a guess, the element being closed only by what follows (</p>, </li> left out): no own close
// tag before the next element outside it, another element's close tag before its own, or its last child implied.
// shortcut: such an element's end (and its parent's) runs to the next element outside them; edit.mjs refuses to cut
// one (implied), the scope check takes it as it is; no fixture board has one (scratch probe over 30 boards).
export function extents(map, buf) {
  const N = map.nodes.length, size = new Array(N).fill(1), last = new Array(N).fill(-1);
  for (let t = N - 1; t >= 0; t--) { const up = map.nodes[t].parent; if (up >= 0) { size[up] += size[t]; if (last[up] < 0) last[up] = t; } }
  const s = buf.toString('latin1'); // one char per byte, so indices are the nodes' byte offsets
  const close = s.lastIndexOf('</x-dc>'), out = new Array(N);
  for (let t = N - 1; t >= 0; t--) {
    const n = map.nodes[t], bound = map.nodes[t + size[t]]?.start ?? close;
    const html = n.ns === 'html', raw = html && RAW.has(n.tag);
    let end = bound, closeAt = bound, implied = false;
    if (n.end === n.start || (html && VOID.has(n.tag)) || (s[n.end - 2] === '/' && (!html || n.tag === 'dc-import' || n.tag === 'x-import'))) end = closeAt = n.end;
    else {
      implied = true; // until its own close tag is found
      const re = raw ? new RegExp(`</${n.tag}(?=[\\t\\n\\f\\r />])[^>]*>?`, 'gi') : /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][^\t\n\f\r />]*)[^>]*>?/g;
      re.lastIndex = last[t] >= 0 ? out[last[t]].end : n.end;
      const open = []; // other tags opened in the scan (unnumbered elements), so their close tags are not another element's
      let foreign = false;
      for (let m, depth = 0; (m = re.exec(s)) && m.index < bound;) {
        if (raw) { closeAt = m.index; end = m.index + m[0].length; implied = false; break; }
        if (!m[2]) continue;
        const tag = m[2].toLowerCase();
        if (tag !== n.tag) {
          if (!m[1]) { if (!VOID.has(tag) && !m[0].endsWith('/>')) open.push(tag); } else if (open.includes(tag)) open.length = open.lastIndexOf(tag); else foreign = true;
          continue;
        }
        if (!m[1]) depth++;
        else if (depth) depth--;
        else { closeAt = m.index; end = m.index + m[0].length; implied = foreign; break; }
      }
      if (last[t] >= 0 && out[last[t]].implied) implied = true;
    }
    out[t] = { tid: t, start: n.start, end, closeAt, size: size[t], implied };
  }
  return out;
}
// Byte offsets where each line starts (line l at starts[l - 1]).
const lineStarts = (buf) => { const out = [0]; for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) out.push(i + 1); return out; };
const lineAt = (starts, off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };
// Lines [a, b] (1-based, inclusive) → their bytes without the leading and trailing whitespace.
function lineBytes(buf, starts, a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || a > starts.length) return null;
  let s = starts[a - 1], e = b < starts.length ? starts[b] : buf.length;
  const ws = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  while (s < e && ws(buf[s])) s++;
  while (e > s && ws(buf[e - 1])) e--;
  return [s, e];
}

/** The changed bytes between two versions of a file: [from, to) in before (from === to for a pure insertion). */
// shortcut: one span from the first to the last changed byte, so two edits inside the scope with an untouched part
// outside it between them are flagged; a line diff (Myers) would split them if that shows up.
export function changed(before, after) {
  const n = Math.min(before.length, after.length);
  let p = 0; while (p < n && before[p] === after[p]) p++;
  if (p === before.length && p === after.length) return null;
  let s = 0; while (s < n - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return [p, before.length - s];
}

// ---------- the check ----------

/** checkScope(c, file, target, {scope?, src?}) → {ok, outside, scope}. c: a Canvas, or {dir} with view-state on disk.
 *  target: {ids:[element ids]} (each must lie inside the scope), {lines:[[a, b]]} or {ranges:[[from, to]]} (byte ranges)
 *  of file as src has it (default: the file now). scope: default view-state's. outside lists what is not inside: the
 *  ids, or {lines:[a, b], near: the innermost element at the change}. */
export function checkScope(c, file, target = {}, opts = {}) {
  const scope = opts.scope !== undefined ? opts.scope : readScope(c.dir);
  if (!scope || typeof scope !== 'object') return { ok: true, outside: [], scope: null };
  if (typeof file !== 'string' || !FILE_RE.test(file)) throw Object.assign(new Error('bad file name'), { status: 400 });
  const ids = Array.isArray(scope.ids) ? scope.ids.filter((x) => typeof x === 'string') : [];
  const src = opts.src || fs.readFileSync(path.join(c.dir, file));
  const map = tidmap(src), ext = map.found ? extents(map, src) : [];
  // The scoped elements in src: the whole file for a board scope, else each id followed to this version.
  let inside;
  if (scope.kind === 'board') inside = ids.includes(file) ? [{ tid: 0, start: 0, end: src.length, size: Infinity }] : [];
  else {
    const from = typeof scope.sha?.[file] === 'string' ? scope.sha[file] : null;
    inside = ids.map((id) => [id, parseId(id)]).filter(([, p]) => p && p.file === file).map(([id, p]) => {
      if (from && from !== map.sha) { // the ids are from an earlier version: follow them here, as comment anchors
        const a = followThrough(c.dir, file, { id, fileSha: from }, map); // that version gone: not followed, so outside
        return a ? ext[parseId(a.id).tid] : null;
      }
      const n = map.nodes[p.tid];
      return n && (p.path === null || n.path === p.path) ? ext[p.tid] : null;
    }).filter(Boolean);
  }
  const within = (from, to) => inside.some((e) => (from < to ? from >= e.start && to <= e.end : from > e.start && from < e.end));
  const outside = [];
  if (Array.isArray(target.ids)) {
    for (const id of target.ids) {
      const p = parseId(id), e = p && p.file === file && (p.path === null || map.nodes[p.tid]?.path === p.path) ? ext[p.tid] : null; // a stale id is outside
      if (scope.kind === 'board' ? !(p && ids.includes(p.file)) : !e || !inside.some((s) => e.tid >= s.tid && e.tid < s.tid + s.size)) outside.push(id);
    }
  }
  const starts = lineStarts(src);
  const ranges = [
    ...(Array.isArray(target.ranges) ? target.ranges : []),
    ...(Array.isArray(target.lines) ? target.lines.map((r) => (Array.isArray(r) ? lineBytes(src, starts, Number(r[0]), Number(r[1] ?? r[0])) : null)).filter(Boolean) : []),
  ];
  for (const [from, to] of ranges) {
    if (within(from, to)) continue;
    const at = ext.filter((e) => e.start <= from && from < e.end).at(-1); // the innermost element there
    outside.push({ lines: [lineAt(starts, from), lineAt(starts, Math.max(from, to - 1))], ...(at ? { near: idFor(file, at.tid, map.nodes[at.tid].path), tag: map.nodes[at.tid].tag } : {}) });
  }
  return { ok: outside.length === 0, outside, scope };
}

/** An agent's whole-board write (/__agent/write) under the locked scope, as /__agent/edit: null when nothing is locked
 *  or the change lies inside it; outside it, a 403 unless outOfScope gives a reason, then {reason, outside}. */
export function writeScope(c, file, content, outOfScope) {
  const scope = readScope(c.dir);
  if (!scope || typeof scope !== 'object') return null;
  if (typeof file !== 'string' || !FILE_RE.test(file)) throw Object.assign(new Error('bad file name'), { status: 400 });
  let before; try { before = fs.readFileSync(path.join(c.dir, file)); } catch { return null; } // a new board: nothing was there to keep
  const r = changed(before, Buffer.from(content));
  if (!r) return null;
  const res = checkScope(c, file, { ranges: [r] }, { scope, src: before });
  if (res.ok) return null;
  const why = typeof outOfScope === 'string' ? outOfScope.trim().slice(0, 300) : '';
  if (!why) throw Object.assign(new Error(`Refused: outside the locked part (${scope.label || scope.kind}). Ask the user, or pass outOfScope with a reason.`), { status: 403, extra: { outside: res.outside } });
  return { reason: why, outside: res.outside };
}

const readScope = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.atelier', 'view-state.json'), 'utf8')).scope ?? null; } catch { return null; } };

/** After a raw write of the board at file path p (an agent's Write or Edit): was it outside the locked scope?
 *  → {locked:false} (not a board of an open canvas, or no scope), or {locked:true, canvas, file, shellAlive, ok,
 *  outside, before (the version from before the write), sha (the file now)}. Only canvases already open are looked at. */
export function written(registry, p, shellAlive) {
  let real; try { real = fs.realpathSync(String(p)); } catch { return { locked: false }; }
  const file = path.basename(real);
  const c = [...registry.open.values()].find((x) => x.dir === path.dirname(real));
  if (!c || !FILE_RE.test(file)) return { locked: false };
  const scope = readScope(c.dir);
  if (!scope) return { locked: false };
  const now = fs.readFileSync(real);
  // The newest version that differs from the file now: the watcher snapshots a write ~150 ms after it lands.
  let before = null;
  const kept = versions(c.dir, file);
  for (const ts of kept.reverse()) {
    const buf = fs.readFileSync(versionPath(c.dir, file, ts));
    if (!buf.equals(now)) { before = { ts, buf }; break; }
  }
  const base = { locked: true, canvas: c.id, file, shellAlive: shellAlive ? shellAlive(c.id) : null, sha: sha256(now), scope };
  // Every kept version is this content: nothing changed. None kept: nothing to compare with (ok null).
  if (!before) return { ...base, ok: kept.length ? true : null, outside: [], before: null };
  const r = changed(before.buf, now);
  if (!r) return { ...base, ok: true, outside: [], before: before.ts };
  const res = checkScope(c, file, { ranges: [r] }, { scope, src: before.buf });
  return { ...base, ok: res.ok, outside: res.outside, before: before.ts };
}
