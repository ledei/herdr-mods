// Comments: the one store, <canvas>/.atelier/comments.json (imported from nova-atelier's older stores until the first
// write), and the anchors that tie a comment to an element of a board.
// An anchor is {id: "File.dc.html#tid:path[@k]", tag, text60, label, bbox, fileSha}: tag and text60 come from the source
// (tidmap), so they compare with later versions of the file; label and bbox are what the board showed. When the file
// changes, each anchor is followed to its element in the new version (see follow()); one that cannot be followed is
// marked drifted and left as it was, never moved silently.
// mountComments(ctx) serves the routes that are not in api.mjs: delete own, bbox refresh, repin, revert, scope lock and
// the scope checks (server/scope.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, fail, sha256, FILE_RE } from './canvas.mjs';
import { snap, versions, versionFile, TS_RE } from './versions.mjs';
import { tidmap, parseId } from './tidmap.mjs';
import { sendJson, readJson } from './http.mjs';
import { checkScope, written, followThrough, src60, idOf } from './scope.mjs';

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const rect = (v) => (Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(Number(n))) ? v.map((n) => Math.round(Number(n) * 10) / 10) : null);
const KINDS = ['pin', 'area', 'arrow', 'text'];
const USER = (() => { try { return os.userInfo().username; } catch { return 'You'; } })();

// ---------- older stores, read only ----------

// nova-atelier Studio's <canvas>/.studio/comments.json and its feedback/<canvas>.json beside the canvas folder.
function legacyComments(c) {
  const out = [];
  let studio = [];
  try { studio = JSON.parse(fs.readFileSync(path.join(c.dir, '.studio', 'comments.json'), 'utf8')); } catch { /* none */ }
  for (const s of Array.isArray(studio) ? studio : []) {
    if (!s || typeof s !== 'object' || !s.id) continue;
    out.push({
      id: String(s.id), kind: 'pin', board: s.file ?? null,
      anchor: { id: s.file ? `${s.file}${s.tid != null ? `#${s.tid}${s.path ? ':' + s.path : ''}` : ''}` : null, tag: s.tag ?? null, text60: s.hint ?? null, bbox: null, fileSha: null },
      author: s.author || 'Anonym', text: String(s.text || ''), status: s.resolved ? 'resolved' : 'open', drifted: false,
      replies: Array.isArray(s.replies) ? s.replies : [], shots: [], ts: s.ts || null,
      importedFrom: '.studio/comments.json', legacy: { file: s.file, x: s.x, y: s.y, ox: s.ox, oy: s.oy },
    });
  }
  let fb = null;
  try { fb = JSON.parse(fs.readFileSync(path.join(c.dir, '..', 'feedback', path.basename(c.dir) + '.json'), 'utf8')); } catch { /* none */ }
  for (const m of Array.isArray(fb?.markers) ? fb.markers : []) {
    if (!m || typeof m !== 'object') continue;
    out.push({
      id: String(m.id ?? `fb-${m.n}`), kind: m.kind === 'arrow' ? 'arrow' : m.kind === 'label' ? 'text' : 'pin', board: m.board ?? null,
      anchor: { id: m.board ? `${m.board}${m.tid != null ? `#${m.tid}` : ''}` : null, tag: m.tag ?? null, text60: m.snippet ?? null, bbox: null, fileSha: null },
      author: m.author || 'Anonym', text: String(m.text ?? m.note ?? ''), status: m.status === 'resolved' ? 'resolved' : 'open', drifted: false,
      replies: Array.isArray(m.replies) ? m.replies : [], shots: [], ts: m.ts || null,
      importedFrom: `feedback/${path.basename(c.dir)}.json`, legacy: m,
    });
  }
  return out;
}

// ---------- anchors ----------

const current = new Map(); // board path → {mtimeMs, size, map}: re-read only when the file changed
function boardMap(c, file) {
  const f = path.join(c.dir, file);
  let st; try { st = fs.statSync(f); } catch { return null; }
  const hit = current.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.map;
  const map = tidmap(fs.readFileSync(f));
  current.set(f, { mtimeMs: st.mtimeMs, size: st.size, map });
  return map;
}
/** k with its anchor followed to the file as it is now: the same object when nothing changed, else a copy. */
function reanchor(c, k) {
  const p = parseId(k.anchor?.id);
  if (!p || !k.anchor.fileSha) return k; // an imported id in an older grammar, or not an element: shown as stored
  const map = boardMap(c, p.file);
  if (!map?.found) return k.drifted ? k : { ...k, drifted: true };
  if (map.sha === k.anchor.fileSha) return k.drifted ? { ...k, drifted: false } : k; // back as it was (a revert)
  const a = followThrough(c.dir, p.file, k.anchor, map);
  if (!a) return k.drifted ? k : { ...k, drifted: true };
  return { ...k, drifted: false, anchor: { ...k.anchor, ...a } };
}

const stored = (c) => c.sideRead('comments.json', null) ?? legacyComments(c);
/** Every comment, anchors followed to the files as they are now (nothing is written; edits and file events write). */
export const listComments = (c) => stored(c).map((k) => reanchor(c, k));

// Every write: the list as listComments shows it, changed by fn, then stored, and the open shells told (through the
// canvas's events, which the registry forwards to the SSE stream) so a thread shows an agent's reply as it lands.
// tell false: a bbox refresh, which the shell itself sent.
function editComments(c, fn, tell = true) {
  const list = listComments(c);
  const r = fn(list);
  c.sideWrite('comments.json', list);
  if (tell) c.emit('file', { type: 'comments', canvas: c.id });
  return r;
}
const find = (list, id) => list.find((x) => x.id === id) || fail(404, 'no comment with that id');

/** The anchor of an element id, from the source: 400 bad id, 404 no such element, 409 tid and path disagree.
 *  Snapshots the file, so this version can be found again by its sha when the file changes. */
function anchorFor(c, a) {
  const p = parseId(a.id);
  if (!p) return { id: str(a.id, 300) || null, tag: str(a.tag, 40) || null, text60: str(a.text60, 60) || null, bbox: rect(a.bbox), fileSha: str(a.fileSha, 64) || null };
  let buf; try { buf = fs.readFileSync(c.file(p.file)); } catch (e) { if (e.status) throw e; fail(404, 'no such board file'); }
  const map = tidmap(buf);
  const n = map.nodes[p.tid] || fail(404, `no element with tid ${p.tid}`);
  if (p.path !== null && n.path !== p.path) fail(409, `tid ${p.tid} is at ${n.path} in this file, not ${p.path}`);
  snap(c.dir, p.file, buf);
  return { id: idOf(p.file, n, p.repeat), tag: n.tag, text60: src60(n), label: str(a.label, 60) || null, bbox: rect(a.bbox), fileSha: map.sha };
}

/** b: {kind, text, author?, from?, anchor?: {id, label?, bbox?}, board?, rect?, scope?}. from "shell": the user's own
 *  (author defaults to the login name; only these can be deleted). area: rect [x,y,w,h] in board px on board. */
export function createComment(c, b) {
  const text = str(b.text, 4000);
  if (!text) fail(400, 'text is required');
  const kind = b.kind ?? 'pin';
  if (!KINDS.includes(kind)) fail(400, `kind must be one of ${KINDS.join(', ')}`);
  const anchor = anchorFor(c, b.anchor && typeof b.anchor === 'object' ? b.anchor : {});
  const board = parseId(anchor.id)?.file ?? (b.board == null ? null : FILE_RE.test(b.board) ? b.board : fail(400, 'bad board file name'));
  const own = b.from === 'shell';
  const comment = {
    id: newId(), kind, board, anchor, ...(kind === 'area' ? { rect: rect(b.rect) || fail(400, 'an area needs rect [x, y, w, h]') } : {}),
    ...(b.scope && typeof b.scope === 'object' ? { scope: b.scope } : {}),
    author: str(b.author, 40) || (own ? USER : 'Anonym'), ...(own ? { own: true } : {}), text, status: 'open', drifted: false, replies: [], shots: [], ts: new Date().toISOString(),
  };
  return editComments(c, (list) => { list.push(comment); return comment; });
}

export function replyComment(c, b) {
  const text = str(b.text, 4000);
  if (!text) fail(400, 'text is required');
  return editComments(c, (list) => {
    const k = find(list, b.id);
    const user = b.kind === 'user';
    const reply = { id: newId(), author: str(b.author, 40) || (user ? USER : 'Agent'), kind: user ? 'user' : 'agent', ts: new Date().toISOString(), text };
    if (b.resolve === true) k.status = 'resolved';
    // An agent repeating the thread's last reply word for word within 10 minutes (a small model answering twice): not added.
    const last = (k.replies ||= []).at(-1);
    if (!user && last?.kind === 'agent' && last.author === reply.author && last.text === text && Date.now() - Date.parse(last.ts) < 600000) return { comment: k, reply: last, duplicate: true };
    k.replies.push(reply);
    return { comment: k, reply };
  });
}

export function resolveComment(c, b) {
  return editComments(c, (list) => {
    const k = find(list, b.id);
    k.status = b.open === true ? 'open' : 'resolved';
    return k;
  });
}

function deleteComment(c, b) {
  return editComments(c, (list) => {
    const k = find(list, b.id);
    if (!k.own) fail(403, 'only your own comments can be deleted');
    list.splice(list.indexOf(k), 1);
    return { deleted: k.id };
  });
}

// The live boards' bboxes for anchors (after a hot swap the element may have moved), so snapshots draw pins right too.
function setBboxes(c, b) {
  if (!Array.isArray(b.items)) fail(400, 'items must be [{id, bbox}]');
  return editComments(c, (list) => {
    let n = 0;
    for (const it of b.items.slice(0, 200)) {
      const k = list.find((x) => x.id === it?.id), r = rect(it?.bbox);
      if (k && r && k.anchor) { k.anchor = { ...k.anchor, bbox: r }; n++; }
    }
    return { updated: n };
  }, false);
}

function repin(c, b) {
  const anchor = anchorFor(c, b.anchor && typeof b.anchor === 'object' ? b.anchor : {});
  if (!parseId(anchor.id)) fail(400, 'anchor.id must be an element id');
  return editComments(c, (list) => {
    const k = find(list, b.id);
    Object.assign(k, { anchor, board: parseId(anchor.id).file, drifted: false });
    return k;
  });
}

/** Puts version ts of file back, snapshotting the current content first (so the revert can be undone). */
export function revert(c, b) {
  if (typeof b.ts !== 'string' || !TS_RE.test(b.ts)) fail(400, 'bad ts');
  const f = c.file(b.file);
  const v = versionFile(c.dir, b.file, b.ts); // refuses a version that is a link leading out of the canvas
  let old; try { old = fs.readFileSync(v); } catch { fail(404, 'no such version'); }
  let cur; try { cur = fs.readFileSync(f); } catch { fail(404, 'no such board file'); }
  const saved = snap(c.dir, b.file, cur);
  atomicWrite(f, old);
  return { file: b.file, ts: b.ts, sha: sha256(old), saved: saved ?? versions(c.dir, b.file).at(-1) };
}

// A scope is being locked: every board's current content becomes a version, so whatever an agent writes next can be
// reverted to what was there (an outside edit is snapshotted only after it lands). Also returns the scoped files' shas,
// which the shell keeps in view-state scope.sha so the scope's ids can be followed through later edits.
function lockScope(c, b) {
  const { obj } = c.read();
  for (const f of Object.keys(obj.boards)) if (FILE_RE.test(f)) try { snap(c.dir, f); } catch { /* a link or a folder: not ours to snapshot */ }
  const files = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((id) => parseId(id)?.file ?? (FILE_RE.test(id) ? id : null)).filter(Boolean))];
  return { sha: Object.fromEntries(files.map((f) => [f, boardMap(c, f)?.sha]).filter(([, s]) => s)) };
}

/** Routes for api.mjs, after its token check: returns false for a request that is not one of them, else true and
 *  answers it (async). ctx: {registry, shellAlive(canvasId)?, broadcast(ev)?}. */
export function mountComments(ctx) {
  const { registry } = ctx;
  const emit = ctx.broadcast || ((ev) => registry.emit('event', ev));
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');

  // A board changed on disk: its comments are re-anchored and stored, and the shell told.
  const onEvent = (ev) => {
    if (ev?.type !== 'file' || typeof ev.file !== 'string' || !FILE_RE.test(ev.file)) return;
    const c = registry.open.get(ev.canvas);
    if (!c) return;
    c.locked(() => {
      const list = stored(c);
      if (!list.some((k) => k.board === ev.file || parseId(k.anchor?.id)?.file === ev.file)) return;
      const next = list.map((k) => reanchor(c, k));
      if (next.some((k, i) => k !== list[i])) c.sideWrite('comments.json', next);
      emit({ type: 'comments', canvas: c.id, file: ev.file });
    }).catch(() => {});
  };
  registry.on('event', onEvent);

  const posts = {
    '/__atelier/comments/delete': (c, b) => c.locked(() => deleteComment(c, b)),
    '/__atelier/comments/bbox': (c, b) => c.locked(() => setBboxes(c, b)),
    '/__atelier/comments/repin': (c, b) => c.locked(() => repin(c, b)),
    '/__atelier/revert': (c, b) => c.locked(() => revert(c, b)),
    '/__atelier/scope/lock': (c, b) => c.locked(() => lockScope(c, b)),
    // For atelier_edit (T10): would these ids, or these lines of file, stay inside the locked scope?
    '/__agent/scope/check': (c, b) => checkScope(c, b.file, b),
  };
  const routes = (req, url) => {
    if (req.method !== 'POST') return null;
    if (url.pathname === '/__agent/scope/written') return async (b) => written(registry, b.path, ctx.shellAlive);
    const fn = Object.hasOwn(posts, url.pathname) ? posts[url.pathname] : null;
    return fn && (async (b) => fn(canvasOf(b.canvas), b));
  };

  function handle(req, res, url) {
    const run = routes(req, url);
    if (!run) return false;
    readJson(req).then(run).then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  }
  handle.close = () => registry.off('event', onEvent);
  return handle;
}
