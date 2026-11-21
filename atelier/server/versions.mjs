// Board snapshots: <canvas>/.atelier/versions/<file>/<time>.dc.html, one per distinct content, the last 50 per file.
// Adapted from nova-atelier's scripts/versions.mjs (same naming, dedupe and pruning; the folder moved into .atelier/).
import fs from 'node:fs';
import path from 'node:path';
import { writeNew, atomicWrite, fail, FILE_RE } from './canvas.mjs';

const KEEP = 50;

// Creates dir under root and refuses when any part of it is a link that leads elsewhere (a planted .atelier -> ~/x).
export function ownDir(root, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const want = path.join(fs.realpathSync(root), path.relative(root, dir));
  if (fs.realpathSync(dir) !== want) throw Object.assign(new Error('refusing to write through a link: ' + path.relative(root, dir)), { status: 403 });
  return dir;
}
export const TS_RE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?$/;
const dirOf = (dir, file) => path.join(dir, '.atelier', 'versions', file);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export const versions = (dir, file) => {
  try { return fs.readdirSync(dirOf(dir, file)).filter((f) => f.endsWith('.dc.html')).sort().map((f) => f.slice(0, -'.dc.html'.length)); } catch { return []; }
};
export const versionPath = (dir, file, ts) => path.join(dirOf(dir, file), ts + '.dc.html');

// Snapshot buf (default: the file's current content) unless the newest snapshot already matches. Returns the new ts or null.
export function snap(dir, file, buf) {
  if (!buf) { try { buf = fs.readFileSync(path.join(dir, file)); } catch { return null; } }
  const vd = dirOf(dir, file), list = versions(dir, file);
  if (list.length && fs.readFileSync(versionPath(dir, file, list.at(-1))).equals(buf)) return null;
  ownDir(dir, vd);
  let ts = stamp();
  for (let i = 2; fs.existsSync(versionPath(dir, file, ts)); i++) ts = `${stamp()}-${i}`;
  writeNew(versionPath(dir, file, ts), buf);
  for (const old of [...list, ts].slice(0, -KEEP)) fs.rmSync(versionPath(dir, file, old), { force: true });
  return ts;
}

// The version file of file at ts, or null: ts and file well formed, and the real path the one inside
// <dir>/.atelier/versions (no link at the version, at its folder or at .atelier leads elsewhere).
export function versionFile(dir, file, ts) {
  if (typeof ts !== 'string' || !TS_RE.test(ts) || typeof file !== 'string' || !FILE_RE.test(file)) return null;
  const v = versionPath(dir, file, ts);
  try { return fs.realpathSync(v) === versionPath(fs.realpathSync(dir), file, ts) ? v : null; } catch { return null; }
}

// ---------- T9: whole checkpoints and compare ----------

const CP_ID = /^[a-z0-9]{1,40}$/;
// Every board of checkpoint cp back to its version: all versions are read before anything is written (a snapshot
// can prune an old one), then before() runs (its result is out.before), then each board's current content is
// snapshotted and the version written. A board removed since (its file gone) is written again and its canvas.json
// entry put back from the checkpoint's copy of canvas.json (out.added); entries still there stay as they are. A board
// whose version is gone, or that has no entry to put back, is out.missing. A malformed entry refuses the whole restore.
// before(adding) gets the files about to be added back.
export function restoreCheckpoint(c, cp, before = () => null) {
  const files = cp.files && typeof cp.files === 'object' ? Object.entries(cp.files) : [];
  const bad = !CP_ID.test(String(cp.id)) ? 'id' : files.find(([f, ts]) => !FILE_RE.test(f) || typeof ts !== 'string' || !TS_RE.test(ts))?.[0];
  if (bad !== undefined) fail(400, `checkpoint ${String(cp.label ?? cp.id).slice(0, 60)} has a bad entry (${String(bad).slice(0, 60)}): it was changed by hand; nothing was restored`);
  let then = {}; // the checkpoint's copy of canvas.json
  try { then = JSON.parse(fs.readFileSync(path.join(c.side, 'versions', 'canvas.json', cp.id + '.json'), 'utf8')) || {}; } catch { /* an older checkpoint: no copy */ }
  const entries = then.boards && typeof then.boards === 'object' ? then.boards : {};
  const out = { id: cp.id, label: cp.label, restored: [], added: [], unchanged: [], missing: [] };
  const back = files.map(([file, ts]) => {
    const v = versionFile(c.dir, file, ts);
    try { if (v) return [file, fs.readFileSync(v)]; } catch { /* pruned since */ }
    out.missing.push(file);
    return null;
  }).filter(Boolean);
  const now = c.read().obj.boards;
  // Boards this restore brings back: the safety checkpoint lists them, so restoring it takes them away again.
  const adding = back.map(([file]) => file).filter((file) => !Object.hasOwn(now, file) && Object.hasOwn(entries, file) && !fs.existsSync(c.file(file)));
  out.before = before(adding);
  for (const [file, buf] of back) {
    const f = c.file(file);
    let cur = null; try { cur = fs.readFileSync(f); } catch { /* removed since */ }
    if (cur === null && !Object.hasOwn(now, file) && !Object.hasOwn(entries, file)) { out.missing.push(file); continue; }
    if (cur?.equals(buf)) out.unchanged.push(file);
    else {
      if (cur) snap(c.dir, file, cur);
      atomicWrite(f, buf);
      out.restored.push(file);
    }
    if (!Object.hasOwn(now, file) && Object.hasOwn(entries, file)) out.added.push(file);
  }
  if (out.added.length) c.updateCanvas((cj) => {
    for (const file of out.added) {
      if (Object.hasOwn(cj.boards, file)) continue;
      cj.boards[file] = entries[file];
      // Its page back too when it went (as the checkpoint had it), and its place in order when the canvas keeps one.
      const page = Array.isArray(then.pages) && then.pages.find((p) => p?.id === entries[file]?.page);
      if (page && Array.isArray(cj.pages) && !cj.pages.some((p) => p.id === page.id)) cj.pages.push(page);
      if (Array.isArray(cj.order) && !cj.order.includes(file)) cj.order.push(file);
    }
  });
  return out;
}

// The boards origin's file for a board URL with ?v=<ts> (compare: an old version, read-only, from the same folder so
// ./support.js and ds/ still resolve): the version, or null when there is none. Without ?v the file itself.
export function withVersion(dir, file, reqUrl) {
  const ts = new URL(reqUrl, 'http://x').searchParams.get('v');
  if (ts === null || !file?.endsWith('.dc.html')) return file;
  return versionFile(dir, path.relative(dir, file), ts);
}
