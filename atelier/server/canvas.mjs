// Canvases: the registry (canvasId ↔ folder), canvas.json (atelierd is its only writer) and the .atelier/ sidecar.
// Opening a canvas writes nothing into its folder; .atelier/ appears on the first write or board change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { snap, ownDir } from './versions.mjs';

export const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html$/;
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const fail = (status, error, extra) => { throw Object.assign(new Error(error), { status, extra }); };
const DEBOUNCE = 150;

// Creates a file that must not exist yet, refusing links (O_EXCL | O_NOFOLLOW).
export function writeNew(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}

export function atomicWrite(file, data) {
  // Random name, created fresh, never through a link: a planted .x.tmp link cannot redirect the write.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  writeNew(tmp, data);
  fs.renameSync(tmp, file);
}

// Same layout as the file had: indented by its first indent (or compact), trailing newline kept.
export function serialize(obj, raw) {
  const m = /^\{\r?\n([ \t]+)\S/.exec(raw);
  return JSON.stringify(obj, null, m ? m[1] : 0) + (raw.endsWith('\n') ? '\n' : '');
}

export class Canvas extends EventEmitter {
  constructor(dir, id) {
    super();
    this.dir = dir;
    this.id = id;
    this.cj = path.join(dir, 'canvas.json');
    this.side = path.join(dir, '.atelier');
    this.chain = Promise.resolve();
    this.timers = new Map();
    try {
      this.watcher = fs.watch(dir, { recursive: true }, (_ev, name) => name && this.noteChange(String(name).split(path.sep).join('/')));
      this.watcher.on('error', () => this.watcher.close());
    } catch { this.watcher = null; } // shortcut: no polling fallback, add one if a filesystem without fs.watch shows up
  }

  // One write at a time per canvas, across canvas.json, sidecars and board files.
  locked(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  read() {
    const raw = fs.readFileSync(this.cj, 'utf8');
    let obj; try { obj = JSON.parse(raw); } catch { fail(500, 'canvas.json is not valid JSON'); }
    if (!obj || typeof obj !== 'object' || !obj.boards || typeof obj.boards !== 'object') fail(500, 'canvas.json has no boards');
    return { raw, obj };
  }

  // Applies mutate(obj) to the version on disk right now, never to a cached copy, so another writer's keys survive:
  // the merge is per key because only the keys mutate touches change. No write when the bytes come out the same.
  updateCanvas(mutate) {
    for (let tries = 0; ; tries++) {
      const { raw, obj } = this.read();
      const result = mutate(obj);
      const out = serialize(obj, raw);
      if (out === raw) return result;
      if (fs.readFileSync(this.cj, 'utf8') !== raw && tries < 3) continue; // changed under us: apply again on the newer file
      atomicWrite(this.cj, out);
      return result;
    }
  }

  sideRead(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.side, name), 'utf8')); } catch { return fallback; }
  }
  sideWrite(name, value) {
    ownDir(this.dir, this.side);
    atomicWrite(path.join(this.side, name), JSON.stringify(value, null, 2) + '\n');
  }

  file(name) {
    if (typeof name !== 'string' || !FILE_RE.test(name)) fail(400, 'bad file name');
    return path.join(this.dir, name);
  }

  noteChange(rel) {
    if (rel.split('/').some((s) => s.startsWith('.'))) return; // .atelier/, temp files of atomic writes
    clearTimeout(this.timers.get(rel));
    this.timers.set(rel, setTimeout(() => {
      this.timers.delete(rel);
      let buf = null;
      try { buf = fs.readFileSync(path.join(this.dir, rel)); } catch { /* deleted, or a folder */ }
      // shortcut: an outside edit is snapshotted after it lands, so its first one has no pre-edit version; snapshot on open if that is missed (it writes into every opened canvas).
      if (buf && FILE_RE.test(rel)) try { snap(this.dir, rel, buf); } catch (e) { this.emit('file', { type: 'error', canvas: this.id, file: rel, error: String(e.message) }); }
      this.emit('file', { type: 'file', canvas: this.id, file: rel, sha: buf ? sha256(buf) : null });
    }, DEBOUNCE));
  }

  close() {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
  }
}

// canvasId = the first 12 hex chars of sha256(real folder path): stable across restarts.
export class Registry extends EventEmitter {
  constructor(home) {
    super();
    this.file = path.join(home, 'canvases.json');
    this.known = {};
    try { this.known = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none yet */ }
    this.open = new Map();
  }

  // dir: absolute path of the folder that holds canvas.json.
  add(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.length > 4096) fail(400, 'path must be an absolute folder path');
    let real; try { real = fs.realpathSync(dir); } catch { fail(404, 'no such folder'); }
    if (!fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, 'canvas.json'))) fail(404, 'no canvas.json in that folder');
    const id = sha256(real).slice(0, 12);
    if (this.known[id] !== real) {
      this.known[id] = real;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWrite(this.file, JSON.stringify(this.known, null, 2) + '\n');
    }
    return this.get(id);
  }

  // By canvasId, or by absolute path (opened on the fly). Null when unknown.
  get(ref) {
    if (typeof ref !== 'string') return null;
    if (path.isAbsolute(ref)) return this.add(ref);
    let c = this.open.get(ref);
    if (c) return c;
    const dir = Object.hasOwn(this.known, ref) ? this.known[ref] : null;
    if (!dir || !fs.existsSync(path.join(dir, 'canvas.json'))) return null;
    c = new Canvas(dir, ref);
    c.on('file', (ev) => this.emit('event', ev));
    this.open.set(ref, c);
    return c;
  }

  close() { for (const c of this.open.values()) c.close(); }
}
