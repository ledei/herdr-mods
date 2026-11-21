// Marked screenshot (T12). The shell asks for a board's (or a region's) PNG, the user draws on it (pen, arrow, label),
// and the composited PNG comes back to be kept with the anchors: the element ids under the marks.
//   POST /__atelier/markup/snap {canvas, board, region?: {x,y,w,h} board px, runner?}
//        → {png (base64), w, h, region: [x,y,w,h], scale (PNG px per board px), runner, state}. Through play.mjs's shot
//        path (live native snapshot, else headless); the unmarked file is not kept. state: the live board's digest
//        then (null headless).
//   POST /__atelier/markup/save {canvas, board, png (base64), marks: [{kind: pen|arrow|label, pts: [[x,y]…] board px, text?}],
//        runner, state (the snap's)} → {path, board, anchors: [{id, tag, line, label, marks: [i…], note?}], runner, stale?}.
//        The PNG goes to <canvas>/.atelier/shots/<ts>-<board>-marked.png (a new file, never through a link; the newest
//        100 shots stay). Each mark names the element at its point (an arrow's tip, a label's spot, a pen stroke's
//        centre), found by the bridge's hit test ("at", the Select tool's) on the snap's runner: a headless picture on a
//        fresh headless load; a live one on the live board while its digest is the snap's, else on a fresh load with
//        stale saying so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, writeNew } from './canvas.mjs';
import { ownDir } from './versions.mjs';
import { resolve as resolveId } from './tidmap.mjs';
import { sendJson } from './http.mjs';

const MAX_BODY = 16 * 1024 * 1024, KEEP = 100, MAX_MARKS = 50;
const KINDS = ['pen', 'arrow', 'label'];
const RUNNERS = ['headless-chrome', 'live-webkit', 'live-chrome', 'live']; // what a snap's runner can be
const STALE = 'The board changed since the snapshot (or Atelier closed): anchors are from its start state';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readBody(req) {
  return new Promise((ok, no) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) no(Object.assign(new Error('body over 16 MB'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); v && typeof v === 'object' && !Array.isArray(v) ? ok(v) : no(Object.assign(new Error('body must be a JSON object'), { status: 400 })); }
      catch { no(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', no);
  });
}

function boardOf(c, file) {
  c.file(file);
  const e = c.read().obj.boards[file];
  if (!e) fail(404, 'no such board in canvas.json');
  return { w: Math.round(Number(e.w) || 390), h: Math.round(Number(e.h) || 844) };
}

// The point a mark is about: an arrow's tip, a label's spot, the middle of a pen stroke.
const pointOf = (m) => (m.kind === 'arrow' ? m.pts.at(-1) : m.kind === 'label' ? m.pts[0]
  : [m.pts.reduce((s, p) => s + p[0], 0) / m.pts.length, m.pts.reduce((s, p) => s + p[1], 0) / m.pts.length]).map((v) => Math.round(v));

function checkMarks(marks) {
  if (!Array.isArray(marks) || marks.length > MAX_MARKS) fail(400, `marks must be a list of at most ${MAX_MARKS}`);
  for (const m of marks) {
    if (!m || !KINDS.includes(m.kind) || !Array.isArray(m.pts) || !m.pts.length || m.pts.length > 2000
      || !m.pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) fail(400, `each mark needs kind (${KINDS.join(', ')}) and pts [[x, y], …] in board px`);
    if (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 200)) fail(400, 'a label\'s text is a short string');
  }
  return marks;
}

/** ctx: {registry, ask(cmd) → {status, body}, shellAlive(id), thumbs (createThumbs), player (createPlay)}. */
export function createMarkup({ ask, shellAlive, thumbs, player }) {
  // The live board's state now (the bridge's digest: logic state sha and what is on screen), null when it does not answer.
  async function stateOf(c, file) {
    try {
      const r = await ask({ canvas: c.id, op: 'digest', args: { board: file }, timeoutMs: 5000 });
      return r.status === 200 ? crypto.createHash('sha256').update(JSON.stringify(r.body.result)).digest('hex').slice(0, 32) : null;
    } catch { return null; }
  }

  async function snap(c, b) {
    const file = b.board, size = boardOf(c, file);
    const r0 = b.region;
    const region = r0 === undefined ? [0, 0, size.w, size.h]
      : r0 && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r0[k])) && r0.w >= 1 && r0.h >= 1 ? [r0.x, r0.y, r0.w, r0.h].map(Math.round) : fail(400, 'region must be {x, y, w, h} in board px');
    const want = b.runner === 'headless' || !shellAlive(c.id) ? 'headless' : 'live';
    const args = { board: file, force: true, waitMs: 1500, ...(r0 === undefined ? {} : { region: { x: region[0], y: region[1], w: region[2], h: region[3] } }) };
    let r;
    try { r = await player.shot(c, { ...args, runner: want }); } catch (e) { if (want !== 'live' || b.runner === 'live') throw e; r = await player.shot(c, { ...args, runner: 'headless' }); }
    if (!r.path) fail(502, 'no snapshot was taken');
    const png = fs.readFileSync(r.path);
    fs.rmSync(r.path, { force: true });
    const state = r.runner === 'headless-chrome' ? null : await stateOf(c, file); // save hit-tests the live board only while it is as it was
    return { png: png.toString('base64'), w: r.w, h: r.h, region, scale: Math.round((r.w / region[2]) * 1000) / 1000, runner: r.runner, state };
  }

  // One at() per point on the live board; null when it does not answer (closed, not loaded).
  async function liveHits(c, file, pts) {
    try {
      const out = [];
      for (const [x, y] of pts) {
        const r = await ask({ canvas: c.id, op: 'at', args: { board: file, x, y }, timeoutMs: 5000 });
        if (r.status !== 200) return null;
        out.push(r.body.result);
      }
      return out;
    } catch { return null; }
  }
  // Each point → the layer there, on the runner the picture came from: a live picture on the live board while it is in
  // the state the snap saw, else (and a headless picture always) all points on one headless load, the start state; a
  // live picture's anchors are then stale, which the answer says.
  async function hits(c, file, pts, from) {
    const live = from.runner !== 'headless-chrome';
    if (live && shellAlive(c.id) && typeof from.state === 'string' && await stateOf(c, file) === from.state) {
      const found = await liveHits(c, file, pts);
      if (found) return { runner: 'live', found };
    }
    return thumbs.session(c, file, async ({ evaluate }) => {
      const found = await evaluate(`Promise.all(${JSON.stringify(pts)}.map(([x, y]) => window.__atelierBridgeOp ? window.__atelierBridgeOp('at', { x, y }) : null))`);
      return { runner: 'headless-chrome', found, ...(live ? { stale: STALE } : {}) };
    });
  }

  async function save(c, b) {
    const file = b.board;
    boardOf(c, file);
    const marks = checkMarks(b.marks ?? []);
    if (marks.length && !RUNNERS.includes(b.runner)) fail(400, `runner must be the snap's runner: ${RUNNERS.join(', ')}`);
    const png = typeof b.png === 'string' ? Buffer.from(b.png, 'base64') : null;
    if (!png || !png.subarray(0, 8).equals(SIG) || png.length < 33) fail(400, 'png must be a base64 PNG');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (!w || !h || w > 8000 || h > 8000) fail(400, 'the PNG is over 8000 px');

    const dir = ownDir(c.dir, path.join(c.side, 'shots')), stem = file.replace(/\.dc\.html$/, '');
    let name = `${stamp()}-${stem}-marked.png`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp()}-${i}-${stem}-marked.png`;
    writeNew(path.join(dir, name), png);
    const all = fs.readdirSync(dir).filter((n) => /^\d{4}-\d\d-\d\dT.*\.png$/.test(n)).sort();
    for (const old of all.slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true });

    const anchors = new Map();
    const { runner, found, stale } = marks.length ? await hits(c, file, marks.map(pointOf), b) : { runner: null, found: [] };
    found.forEach((hit, i) => {
      if (!hit?.id || typeof hit.id !== 'string') return;
      let a = anchors.get(hit.id);
      if (!a) {
        let src = null; try { src = resolveId(c, hit.id); } catch { /* an id from another version of the file: kept without a line */ }
        a = { id: hit.id, tag: src?.tag ?? (typeof hit.tag === 'string' ? hit.tag.slice(0, 40) : null), line: src?.line ?? null,
          label: typeof hit.label === 'string' ? hit.label.slice(0, 60) : null, marks: [] };
        anchors.set(hit.id, a);
      }
      a.marks.push(i);
      if (marks[i].kind === 'label' && marks[i].text && !a.note) a.note = marks[i].text.trim().slice(0, 200);
    });
    return { path: path.join(dir, name), board: file, w, h, anchors: [...anchors.values()].slice(0, 20), runner, ...(stale ? { stale } : {}) };
  }
  return { snap, save };
}

/** Routes for api.mjs, after its token check, as comments.mjs: /__atelier/markup/snap and /__atelier/markup/save. */
export function mountMarkup(ctx) {
  const { registry } = ctx, m = createMarkup(ctx);
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');
  const ROUTES = { '/__atelier/markup/snap': m.snap, '/__atelier/markup/save': m.save }; // no canvas lock: a new file of its own, and the hit test takes seconds
  function handle(req, res, url) {
    const fn = req.method === 'POST' && Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
    if (!fn) return false;
    readBody(req).then((b) => fn(canvasOf(b.canvas), b)).then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  }
  return handle;
}
