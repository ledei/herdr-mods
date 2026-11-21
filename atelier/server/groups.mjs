// Variants and versions (T9), the routes api.mjs does not have: groups.json for the shell and agents (pick, archive,
// prop variants), whole-checkpoint restore and compare. Variants themselves are made by layout.mjs ops.variant.
// groups.json: [{id, name, page, kind:"group"|"variants", boards:[file], labels:{file:"B"}, base?, picked?,
//   propVariants?:[{label, file, props}]}]. A prop variant is one file shown as one more board with other Tweaks;
//   its place beside the base is worked out on every read (never stored), so it follows the boards.
// mountGroups(ctx) → (req, res, url) => boolean, as mountComments.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fail, sha256, FILE_RE } from './canvas.mjs';
import { place, ops } from './layout.mjs';
import { versions, versionFile, TS_RE, restoreCheckpoint } from './versions.mjs';
import { checkpoint } from './sidecar.mjs';
import { sendJson, readJson } from './http.mjs';

const ARCHIVE = { id: 'archive', name: 'Archive' };
const pageOf = (cj, e) => e.page ?? cj.pages?.[0]?.id ?? null;

// The groups, each prop variant with {x, y, w, h, page}: in a row right of the base, clear of every board.
export function listGroups(c) {
  const groups = c.sideRead('groups.json', []);
  const { obj: cj } = c.read();
  const tmp = { ...cj, boards: { ...cj.boards } };
  const last = {}; // file → its latest virtual board, so the next one goes beside that
  for (const g of groups) {
    for (const [i, pv] of (g.propVariants || []).entries()) {
      const src = cj.boards[pv.file];
      if (!src) continue;
      const page = pageOf(cj, src);
      const at = place(tmp, last[pv.file] || src, page);
      last[pv.file] = tmp.boards[`~${g.id}~${i}`] = { ...src, ...at, page };
      Object.assign(pv, at, { w: src.w, h: src.h, page });
    }
  }
  return groups;
}

// The variants group a board is in, or a new one with it as the base (A), as ops.variant makes them.
function groupOf(c, groups, file, make) {
  let g = groups.find((x) => x.kind === 'variants' && x.boards?.includes(file));
  if (g || !make) return g || fail(404, 'that board is in no variants group');
  const e = c.read().obj.boards[file];
  g = { id: 'v-' + crypto.randomBytes(4).toString('hex'), name: e.title || file.replace(/\.dc\.html$/, ''), page: e.page ?? null, kind: 'variants', boards: [file], labels: { [file]: 'A' }, base: file };
  groups.push(g);
  return g;
}

const known = (c, file) => (typeof file === 'string' && FILE_RE.test(file) && Object.hasOwn(c.read().obj.boards, file) ? file : fail(404, 'no such board in canvas.json'));

const actions = {
  list: (c) => ({ groups: listGroups(c) }),

  // {file}: the chosen variant of its group (one per group).
  pick(c, b, groups) {
    const g = groupOf(c, groups, known(c, b.file));
    g.picked = b.file;
    return { group: g.id, picked: b.file };
  },

  // {file}: moves the board to the Archive page (made on first use), placed without overlap. Its file, group and
  // label stay, so ops.variant never hands out its letter again.
  archive(c, b) {
    known(c, b.file);
    return c.updateCanvas((cj) => {
      // A canvas without pages gets Claude's own pages key: its boards stay on the first page, the archive is the second.
      if (!Array.isArray(cj.pages)) cj.pages = [{ id: 'page-1', name: 'Page 1' }];
      if (!cj.pages.some((p) => p.id === ARCHIVE.id)) cj.pages.push({ ...ARCHIVE });
      const e = cj.boards[b.file];
      if (e.page === ARCHIVE.id) return { file: b.file, page: ARCHIVE.id, x: e.x, y: e.y };
      const archived = Object.values(cj.boards).filter((o) => o.page === ARCHIVE.id);
      const last = archived.reduce((a, o) => (!a || o.x > a.x ? o : a), null);
      const at = last ? place(cj, { ...last, w: e.w, h: e.h }, ARCHIVE.id) : { x: 0, y: 0 }; // e's size, as ops.add does
      Object.assign(e, { page: ARCHIVE.id }, at);
      return { file: b.file, page: ARCHIVE.id, ...at };
    });
  },

  // {file, props, label?}: one more view of file with these Tweaks, labelled A1, A2, … after its own label.
  prop(c, b, groups) {
    known(c, b.file);
    if (!b.props || typeof b.props !== 'object' || Array.isArray(b.props) || JSON.stringify(b.props).length > 4096) fail(400, 'props must be an object of at most 4 KB');
    const g = groupOf(c, groups, b.file, true);
    const list = (g.propVariants ||= []);
    const own = g.labels?.[b.file] || 'A';
    let label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 20) : null;
    for (let n = list.length + 1; !label || list.some((p) => p.label === label); n++) label = `${own}${n}`;
    list.push({ label, file: b.file, props: b.props });
    return { group: g.id, label, file: b.file, props: b.props };
  },

  // {group, label}
  unprop(c, b, groups) {
    const g = groups.find((x) => x.id === b.group) || fail(404, 'no such group');
    const i = (g.propVariants || []).findIndex((p) => p.label === b.label);
    if (i < 0) fail(404, 'no prop variant with that label');
    g.propVariants.splice(i, 1);
    return { group: g.id, removed: b.label };
  },
};
const WRITES = new Set(['pick', 'prop', 'unprop']); // archive writes canvas.json, which the watcher reports

export function mountGroups(ctx) {
  const { registry, broadcast: emit, shellAlive } = ctx;
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');

  const gets = {
    '/__atelier/groups': (c) => ({ groups: listGroups(c) }),
    // A board's snapshots with its current sha (for restore's expectSha), and the checkpoints.
    '/__atelier/versions': (c, q) => {
      const file = q.get('file'), f = c.file(file);
      let sha = null; try { sha = sha256(fs.readFileSync(f)); } catch { /* missing */ }
      return { file, sha, versions: versions(c.dir, file), checkpoints: c.sideRead('checkpoints.json', []) };
    },
  };
  const posts = {
    // {canvas, action, …}: see actions.
    '/__agent/variants': (c, b) => c.locked(() => {
      if (!Object.hasOwn(actions, b.action)) fail(400, `action must be one of ${Object.keys(actions).join(', ')}`);
      const groups = c.sideRead('groups.json', []);
      const out = actions[b.action](c, b, groups);
      if (WRITES.has(b.action)) { c.sideWrite('groups.json', groups); emit({ type: 'groups', canvas: c.id }); }
      return out;
    }),
    // {canvas, action:"restoreCheckpoint", id}: a checkpoint of how things are now first, then every board back.
    // {canvas, action:"compare", file, ts}: the shell shows that version beside the board, read-only.
    '/__agent/version': (c, b) => {
      if (b.action === 'compare') {
        c.file(b.file);
        if (typeof b.ts !== 'string' || !TS_RE.test(b.ts)) fail(400, 'bad ts');
        if (!versionFile(c.dir, b.file, b.ts)) fail(404, 'no such version');
        emit({ type: 'compare', canvas: c.id, file: b.file, ts: b.ts });
        return { file: b.file, ts: b.ts, shown: shellAlive(c.id) };
      }
      if (b.action !== 'restoreCheckpoint') fail(400, 'action must be restoreCheckpoint or compare');
      return c.locked(() => {
        const cp = c.sideRead('checkpoints.json', []).find((x) => x.id === b.id) || fail(404, 'no such checkpoint');
        const out = restoreCheckpoint(c, cp, (adding) => checkpoint(c, { label: `Before restoring ${cp.label}`, remove: adding }).id);
        // A "Before restoring" checkpoint undoes that restore: the boards it brought back go to trash (versions/deleted/).
        out.removed = [];
        const now = c.read().obj.boards;
        for (const file of Array.isArray(cp.remove) ? cp.remove : []) {
          if (!FILE_RE.test(file) || Object.hasOwn(cp.files || {}, file) || !Object.hasOwn(now, file)) continue;
          ops.remove(c, { file });
          out.removed.push(file);
        }
        return out;
      });
    },
  };

  function handle(req, res, url) {
    const table = req.method === 'GET' ? gets : req.method === 'POST' ? posts : {};
    if (!Object.hasOwn(table, url.pathname)) return false;
    const run = req.method === 'GET' ? Promise.resolve().then(() => table[url.pathname](canvasOf(url.searchParams.get('canvas')), url.searchParams))
      : readJson(req).then((b) => table[url.pathname](canvasOf(b.canvas), b));
    run.then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  }
  return handle;
}
