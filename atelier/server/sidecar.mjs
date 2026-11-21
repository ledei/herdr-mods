// .atelier/ stores: view-state.json, checkpoints.json (comments.json lives in comments.mjs),
// and file writes that need expectSha. Every function takes a Canvas and runs inside its lock (see api.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, writeNew, fail, sha256, FILE_RE } from './canvas.mjs';
import { snap, versions, versionFile, TS_RE, ownDir } from './versions.mjs';

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- comments: server/comments.mjs ----------
export { listComments, createComment, replyComment, resolveComment } from './comments.mjs';

// ---------- view state ----------
const CAPS = { visibleArtboards: 20, selectedArtboards: 20, erroredArtboards: 10, selected: 20, selection: 5 };
export function writeView(c, b) {
  const { canvas, ...view } = b;
  for (const [k, n] of Object.entries(CAPS)) if (Array.isArray(view[k])) view[k] = view[k].slice(0, n);
  view.updated = Date.now();
  c.sideWrite('view-state.json', view);
  return view;
}

// ---------- board files: writes, versions, checkpoints ----------

// The only way a .dc.html is changed through the API: refuses unless expectSha is the sha256 of what is on disk now.
// Snapshots the current content first, so the version before the write always exists.
export function writeBoard(c, file, content, expectSha) {
  const f = c.file(file);
  let cur; try { cur = fs.readFileSync(f); } catch { fail(404, 'no such board file'); }
  const now = sha256(cur);
  if (typeof expectSha !== 'string' || expectSha !== now) fail(409, 'stale', { sha: now });
  snap(c.dir, file, cur);
  atomicWrite(f, content);
  return sha256(content);
}

export function restore(c, b) {
  if (typeof b.ts !== 'string' || !TS_RE.test(b.ts)) fail(400, 'bad ts');
  c.file(b.file);
  const v = versionFile(c.dir, b.file, b.ts) || fail(404, 'no such version');
  let old; try { old = fs.readFileSync(v); } catch { fail(404, 'no such version'); }
  return { file: b.file, ts: b.ts, sha: writeBoard(c, b.file, old, b.expectSha) };
}

export function checkpoint(c, b) {
  const label = str(b.label, 120) || 'Checkpoint';
  const { raw, obj } = c.read();
  const files = {};
  for (const f of Object.keys(obj.boards)) {
    if (!FILE_RE.test(f) || !fs.existsSync(path.join(c.dir, f))) continue;
    files[f] = snap(c.dir, f) || versions(c.dir, f).at(-1);
  }
  const cp = { id: newId(), label, ts: new Date().toISOString(), files };
  // remove: boards a restore is about to add back; restoring this checkpoint moves them to trash again.
  if (Array.isArray(b.remove) && b.remove.length) cp.remove = b.remove.filter((f) => typeof f === 'string' && FILE_RE.test(f));
  const cjDir = path.join(c.side, 'versions', 'canvas.json');
  ownDir(c.dir, cjDir);
  fs.writeFileSync(path.join(cjDir, cp.id + '.json'), raw);
  const list = c.sideRead('checkpoints.json', []);
  list.push(cp);
  c.sideWrite('checkpoints.json', list);
  return cp;
}

// Copies a file into <canvas>/assets/ (same content → same name) and returns its URL relative to the boards.
export function addAsset(c, src) {
  if (typeof src !== 'string' || !path.isAbsolute(src)) fail(400, 'path must be an absolute file path');
  let st; try { st = fs.statSync(src); } catch { fail(404, 'no such file'); }
  if (!st.isFile() || st.size > 50 * 1024 * 1024) fail(400, 'not a file, or over 50 MB');
  const buf = fs.readFileSync(src);
  const dir = path.join(c.dir, 'assets');
  const ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = path.basename(src, path.extname(src)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'asset';
  ownDir(c.dir, dir);
  for (let i = 1; ; i++) {
    const name = `${stem}${i > 1 ? '-' + i : ''}${ext}`, f = path.join(dir, name);
    if (fs.existsSync(f) && !fs.readFileSync(f).equals(buf)) continue;
    if (fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    if (!fs.existsSync(f)) writeNew(f, buf);
    return { url: 'assets/' + name, sha: sha256(buf) };
  }
}
