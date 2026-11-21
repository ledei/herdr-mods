// Board ops on canvas.json and groups.json: add, duplicate, variant, move, remove, kopia; and the canvas summary for agents.
// canvas.json only ever gets entries under boards/order changed: no new top-level or per-board keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, fail, FILE_RE, sha256, serialize } from './canvas.mjs';
import { snap, ownDir } from './versions.mjs';

const BOARD_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(dc\.html|code)$/; // .code boards have no file but can move
const GAP = 80, ROW = 120;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const box = (e) => ({ x: num(e.x, 0), y: num(e.y, 0), w: num(e.w, 390), h: num(e.h, 844) });
const pageOf = (cj, e) => e.page ?? cj.pages?.[0]?.id ?? null;
const stemOf = (f) => f.replace(/\.dc\.html$/, '');

// First free spot for a w×h board next to src on its page: right of it, end of its row, below it, else a new row under all.
export function place(cj, src, page) {
  const all = Object.values(cj.boards).filter((e) => e && pageOf(cj, e) === page).map(box);
  const s = box(src);
  const free = (x, y) => all.every((o) => x >= o.x + o.w + GAP || x + s.w + GAP <= o.x || y >= o.y + o.h + GAP || y + s.h + GAP <= o.y);
  const rowEnd = Math.max(s.x + s.w, ...all.filter((o) => o.y < s.y + s.h && o.y + o.h > s.y).map((o) => o.x + o.w));
  const spots = [[s.x + s.w + GAP, s.y], [rowEnd + GAP, s.y], [s.x, s.y + s.h + ROW],
    [Math.min(s.x, ...all.map((o) => o.x)), Math.max(s.y + s.h, ...all.map((o) => o.y + o.h)) + ROW]];
  const [x, y] = spots.find(([x, y]) => free(x, y)) ?? spots.at(-1);
  return { x: Math.round(x), y: Math.round(y) };
}

function freeName(c, cj, stem, suffix) {
  for (let n = 1; ; n++) {
    const name = `${stem}${suffix}${n > 1 ? n : ''}.dc.html`;
    if (!Object.hasOwn(cj.boards, name) && !fs.existsSync(path.join(c.dir, name))) return name;
  }
}

// A copy of file's entry under name, with the same keys (no new ones), placed beside it, right after it in order.
function addCopy(cj, file, name, title) {
  const srcEntry = cj.boards[file];
  const at = place(cj, srcEntry, pageOf(cj, srcEntry));
  const entry = { ...srcEntry, x: at.x, y: at.y };
  if ('title' in srcEntry) entry.title = title(srcEntry.title || stemOf(file));
  cj.boards[name] = entry;
  if (Array.isArray(cj.order)) { const i = cj.order.indexOf(file); cj.order.splice(i < 0 ? cj.order.length : i + 1, 0, name); }
  return entry;
}

// Copies the board file first (so canvas.json never names a missing file), then adds the entry to the canvas.json on disk.
function copyBoard(c, b, title) {
  const { obj } = c.read();
  const file = existing(c, known(obj, b.file));
  const name = freeName(c, obj, stemOf(file).replace(/-kopia\d*$/, ''), '-kopia');
  fs.copyFileSync(c.file(file), c.file(name));
  const e = c.updateCanvas((cj) => addCopy(cj, known(cj, file), name, title));
  return { file: name, x: e.x, y: e.y, source: file };
}

const known = (cj, file) => (typeof file === 'string' && BOARD_KEY_RE.test(file) && Object.hasOwn(cj.boards, file) ? file : fail(404, 'no such board in canvas.json'));
const existing = (c, file) => (fs.existsSync(c.file(file)) ? file : fail(404, 'board file missing'));

export const ops = {
  // {file, content?, title?, w?, h?, page?, x?, y?}: a new board (or a file already on disk that canvas.json lacks).
  add(c, b) {
    const f = c.file(b.file);
    if (Object.hasOwn(c.read().obj.boards, b.file)) fail(409, 'board already in canvas.json');
    if (!fs.existsSync(f)) {
      if (typeof b.content !== 'string') fail(400, 'content is required for a new file');
      atomicWrite(f, b.content);
    }
    const at = c.updateCanvas((cj) => {
      if (Object.hasOwn(cj.boards, b.file)) fail(409, 'board already in canvas.json');
      const page = Array.isArray(cj.pages) && cj.pages.some((p) => p.id === b.page) ? b.page : undefined;
      const size = { w: num(b.w, 390), h: num(b.h, 844) };
      const last = [...(cj.order || Object.keys(cj.boards))].reverse().map((k) => cj.boards[k]).find((e) => e && pageOf(cj, e) === (page ?? pageOf(cj, {})));
      const pos = Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: Math.round(b.x), y: Math.round(b.y) } : last ? place(cj, { ...last, ...size }, pageOf(cj, last)) : { x: 0, y: 0 };
      // Same key set and order the canvas's own entries use (alphabetical in Claude Design files).
      cj.boards[b.file] = { h: size.h, ...(page ? { page } : {}), title: typeof b.title === 'string' ? b.title.slice(0, 200) : stemOf(b.file), w: size.w, ...pos };
      if (Array.isArray(cj.order)) cj.order.push(b.file);
      return pos;
    });
    return { file: b.file, ...at, sha: sha256(fs.readFileSync(f)) };
  },

  duplicate(c, b) {
    return copyBoard(c, b, (t) => `${t} (kopia)`);
  },

  // A copy labelled B, C, … in the variants group whose base is the source (made on first use).
  variant(c, b) {
    const groups = c.sideRead('groups.json', []);
    let g = groups.find((x) => x.kind === 'variants' && x.boards?.includes(b.file));
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 20) : String.fromCharCode(65 + (g ? Object.keys(g.labels || {}).length : 1));
    const r = copyBoard(c, b, (t) => `${t} · ${label}`);
    if (!g) {
      const e = c.read().obj.boards[r.source];
      g = { id: 'v-' + crypto.randomBytes(4).toString('hex'), name: e.title || stemOf(r.source), page: e.page ?? null, kind: 'variants', boards: [r.source], labels: { [r.source]: 'A' }, base: r.source };
      groups.push(g);
    }
    g.boards.push(r.file);
    (g.labels ||= {})[r.file] = label;
    c.sideWrite('groups.json', groups);
    return { ...r, label, group: g.id };
  },

  // {file, x, y, title?}
  move(c, b) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || Math.abs(b.x) > 1e6 || Math.abs(b.y) > 1e6) fail(400, 'x and y must be numbers');
    return c.updateCanvas((cj) => {
      const e = cj.boards[known(cj, b.file)];
      e.x = Math.round(b.x);
      e.y = Math.round(b.y);
      if (typeof b.title === 'string' && 'title' in e) e.title = b.title.slice(0, 200);
      return { file: b.file, x: e.x, y: e.y };
    });
  },

  // Drops the entry and moves the file to .atelier/versions/deleted/<ts>/; checks expectSha when given.
  remove(c, b) {
    const file = known(c.read().obj, b.file);
    const f = path.join(c.dir, file);
    let trash = null;
    if (FILE_RE.test(file) && fs.existsSync(f)) {
      const now = sha256(fs.readFileSync(f));
      if (b.expectSha !== undefined && b.expectSha !== now) fail(409, 'stale', { sha: now });
      snap(c.dir, file);
      const dir = path.join(c.side, 'versions', 'deleted', new Date().toISOString().replace(/[:.]/g, '-'));
      ownDir(c.dir, dir);
      fs.renameSync(f, (trash = path.join(dir, file)));
    }
    c.updateCanvas((cj) => {
      delete cj.boards[file];
      if (Array.isArray(cj.order)) cj.order = cj.order.filter((k) => k !== file);
    });
    const r = { file, trash: trash && path.relative(c.dir, trash) };
    const groups = c.sideRead('groups.json', null);
    if (groups?.some((g) => g.boards?.includes(b.file))) {
      for (const g of groups) { g.boards = (g.boards || []).filter((k) => k !== b.file); if (g.labels) delete g.labels[b.file]; }
      c.sideWrite('groups.json', groups);
    }
    return r;
  },
};

// Copies the canvas folder to "<name> (kopia)" beside it, without .atelier/versions, and marks it as a fork.
// Reads the original only. Returns the new folder; the caller registers it.
export function kopia(c) {
  let dest = c.dir + ' (kopia)';
  for (let n = 2; fs.existsSync(dest); n++) dest = `${c.dir} (kopia ${n})`;
  const skip = new Set(['versions', 'view-state.json', 'checkpoints.json', 'thumbs', 'shots'].map((s) => path.join(c.side, s)));
  fs.cpSync(c.dir, dest, { recursive: true, filter: (src) => !skip.has(src) && !path.basename(src).endsWith('.tmp') });
  const cjFile = path.join(dest, 'canvas.json');
  const raw = fs.readFileSync(cjFile, 'utf8');
  const cj = JSON.parse(raw);
  if (typeof cj.title === 'string') { cj.title += ' (kopia)'; atomicWrite(cjFile, serialize(cj, raw)); }
  const meta = c.sideRead('meta.json', {});
  fs.mkdirSync(path.join(dest, '.atelier'), { recursive: true });
  atomicWrite(path.join(dest, '.atelier', 'meta.json'), JSON.stringify({ ...meta, forkOf: c.dir }, null, 2) + '\n');
  return dest;
}

// What an agent needs to find its way: pages, boards (size, page, group, variant label), notes, files missing either way.
export function summary(c) {
  const { obj: cj } = c.read();
  const groups = c.sideRead('groups.json', []);
  const onDisk = fs.readdirSync(c.dir).filter((f) => FILE_RE.test(f));
  const boards = (cj.order || Object.keys(cj.boards)).filter((k) => Object.hasOwn(cj.boards, k)).map((file) => {
    const e = cj.boards[file], g = groups.find((x) => x.boards?.includes(file));
    return {
      file, title: e.title ?? null, ...box(e), page: pageOf(cj, e),
      group: g ? { id: g.id, name: g.name, kind: g.kind } : null, variant: g?.labels?.[file] ?? null,
      missing: FILE_RE.test(file) && !onDisk.includes(file),
    };
  });
  return {
    id: c.id, path: c.dir, title: cj.title ?? null, pages: cj.pages ?? [], designSystems: cj.designSystems ?? [],
    boards, notes: cj.notes ?? {}, notInCanvas: onDisk.filter((f) => !Object.hasOwn(cj.boards, f)),
  };
}
