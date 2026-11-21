// The API on the UI origin: /__atelier/* for the shell, /__agent/* for agents (MCP, hook).
// Every route needs Authorization: Bearer <token>, except GET /__atelier/ping; the SSE stream takes ?t=<token> instead,
// since EventSource cannot send headers.
import crypto from 'node:crypto';
import { sendJson, readJson } from './http.mjs';
import { fail } from './canvas.mjs';
import { ops, kopia, summary } from './layout.mjs';
import * as side from './sidecar.mjs';
import { versions } from './versions.mjs';
import fs from 'node:fs';
import { tidmap, resolve as resolveId, sourceTree, parseId } from './tidmap.mjs';
import { writeReference } from './reference.mjs';
import { createThumbs } from './thumbs.mjs';
import { createPlay } from './play.mjs';
import { mountComments } from './comments.mjs';
import { mountGroups } from './groups.mjs';
import { mountEdit } from './edit.mjs';
import { mountProps } from './props.mjs';
import { mountRecord } from './record.mjs';
import { mountMarkup } from './markup.mjs';
import path from 'node:path';

const SHELL_GRACE = 3000; // a shell that dropped its stream this recently counts as open (it is reconnecting)
const tokenOk = (got, token) => typeof got === 'string' && got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));

export function createApi({ registry, token, origins }) {
  const clients = new Set(); // {res, role, canvas}
  const pending = new Map(); // cmd id → {res, timer}
  let lastView = null, shellGone = 0;
  // Home is where the registry lives (<home>/canvases.json); the boards origin is known once both listeners are up.
  const thumbs = createThumbs({ home: path.dirname(registry.file), boards: () => origins.boards, emit: (ev) => registry.emit('event', ev) });
  // Play, wait, state, logs and shots (T7). atelier-web, the native view, writes live snapshots under its own folder,
  // <HERDR_APP_HOME>/data/atelier-web, beside this home (<…>/data/atelier).
  const helperShots = path.join(path.dirname(path.dirname(registry.file)), 'atelier-web', 'shots');
  const player = createPlay({ ask: (b) => ask(b), shellAlive: (id) => shellAlive(id), thumbs, helperShots });
  const PLAY = { '/__agent/play': 'play', '/__agent/wait': 'wait', '/__agent/state': 'state', '/__agent/logs': 'logs', '/__agent/shot': 'shot' };

  const broadcast = (ev) => {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const k of clients) if ((ev.type !== 'cmd' || k.role === 'shell') && (!k.canvas || !ev.canvas || k.canvas === ev.canvas)) k.res.write(msg);
  };
  registry.on('event', broadcast);
  const heartbeat = setInterval(() => { for (const k of clients) k.res.write(': ping\n\n'); }, 15000);
  heartbeat.unref();

  const shells = (id) => [...clients].filter((k) => k.role === 'shell' && (!id || !k.canvas || k.canvas === id));
  const shellAlive = (id) => shells(id).length > 0;
  const comments = mountComments({ registry, broadcast, shellAlive });
  // T9 variant groups and versions, T10 element edits, T11 Tweaks: each answers its own routes, as comments does.
  const mounted = [comments, mountGroups({ registry, broadcast, shellAlive }), mountEdit({ registry }), mountProps({ registry, ask: (b) => ask(b), shellAlive, broadcast }),
    mountRecord({ registry, ask: (b) => ask(b), shellAlive, thumbs, helperShots }), mountMarkup({ registry, ask: (b) => ask(b), shellAlive, thumbs, player })]; // T12

  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');

  function events(req, res, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const k = { res, role: url.searchParams.get('role') === 'shell' ? 'shell' : 'viewer', canvas: url.searchParams.get('canvas') || null };
    clients.add(k);
    req.on('close', () => { clients.delete(k); if (k.role === 'shell') shellGone = Date.now(); });
  }

  // Agent → shell: queued as an SSE event; resolves with the shell's POST /__agent/result, 504 on timeout.
  async function cmd(req, res, b) {
    const c = b.canvas ? canvasOf(b.canvas) : null;
    if (typeof b.op !== 'string' || !/^[A-Za-z][\w.-]{0,63}$/.test(b.op)) fail(400, 'op must be a short name');
    if (!shellAlive(c?.id)) {
      // shortcut: the 3 s grace only covers a shell that was connected and dropped; a shell opening for the first time must already be connected.
      while (Date.now() - shellGone < SHELL_GRACE && !shellAlive(c?.id)) await new Promise((r) => setTimeout(r, 100));
      if (!shellAlive(c?.id)) return sendJson(res, 409, { error: 'Atelier is not open' });
    }
    const id = crypto.randomUUID();
    const ms = Math.min(Math.max(Number.isFinite(b.timeoutMs) ? b.timeoutMs : 15000, 1), 60000);
    const timer = setTimeout(() => { pending.delete(id); sendJson(res, 504, { error: 'timeout', id }); }, ms);
    pending.set(id, { res, timer });
    res.on('close', () => { if (pending.get(id)?.res === res && !res.writableEnded) { clearTimeout(timer); pending.delete(id); } });
    broadcast({ type: 'cmd', id, canvas: c?.id ?? null, op: b.op, args: b.args ?? null, ms });
  }

  // cmd() for routes that need the answer: resolves {status, body} with what cmd() would have sent (409 no shell, 504 timeout).
  const ask = (b) => new Promise((ok, no) => {
    const sink = { writeHead(status) { this.status = status; }, end(text) { this.writableEnded = true; ok({ status: this.status, body: JSON.parse(text) }); }, on() {} };
    cmd(null, sink, b).catch(no);
  });

  // A board's layers. Live from the shell (it forwards op "tree" to the board's bridge and names its runner);
  // with no shell, from source: tags and template text, no bbox, runner "source".
  async function tree(url) {
    const q = (k) => url.searchParams.get(k);
    const c = canvasOf(q('canvas')), board = q('board'), file = c.file(board);
    const depth = Math.min(Math.max(Number(q('depth')) || 8, 1), 12), root = q('root') || null;
    if (root && parseId(root)?.file !== board) fail(400, 'root must be an id on that board');
    if (shellAlive(c.id)) {
      const r = await ask({ canvas: c.id, op: 'tree', args: { board, root, depth }, timeoutMs: 10000 });
      if (r.status === 200) return { board, runner: 'live', ...r.body.result };
      if (r.status !== 409) fail(r.status, r.body.error || 'the shell did not answer');
    }
    let buf; try { buf = fs.readFileSync(file); } catch { fail(404, 'no such board file'); }
    const map = tidmap(buf);
    if (!map.found) fail(404, 'the board has no <x-dc> template');
    return { board, runner: 'source', sha: map.sha, tree: sourceTree(board, map, { depth, root: root ? parseId(root).tid : null }) };
  }

  // An id → source location. ?selector= or ?text= (with board) asks the live board which elements match first
  // (needs the shell), then resolves each match.
  async function locate(url) {
    const q = (k) => url.searchParams.get(k);
    const c = canvasOf(q('canvas'));
    if (q('id')) return resolveId(c, q('id'));
    const selector = q('selector'), text = q('text'), board = q('board');
    if (!selector && !text) fail(400, 'id, selector or text is required');
    c.file(board);
    const r = await ask({ canvas: c.id, op: 'find', args: { board, ...(selector ? { selector } : { text }) }, timeoutMs: 10000 });
    if (r.status === 409) fail(409, 'resolving by selector or text needs the board open in Atelier; use an id');
    if (r.status !== 200) fail(r.status, r.body.error || 'the shell did not answer');
    const found = Array.isArray(r.body.result) ? r.body.result : [];
    return { board, runner: 'live', matches: found.slice(0, 5).map((m) => { try { return { ...resolveId(c, m.id), label: m.label, bbox: m.bbox }; } catch (e) { return { id: m.id, error: e.message }; } }) };
  }

  function result(res, b) {
    const p = pending.get(b.id);
    if (!p) return sendJson(res, 404, { error: 'no pending command with that id' });
    clearTimeout(p.timer);
    pending.delete(b.id);
    if (b.error !== undefined) sendJson(p.res, 502, { id: b.id, error: String(b.error).slice(0, 2000) });
    else sendJson(p.res, 200, { id: b.id, result: b.result ?? null });
    sendJson(res, 200, { ok: true });
  }

  function view(url) {
    const ref = url.searchParams.get('canvas') || lastView;
    const c = ref ? registry.get(ref) : null;
    if (!c) return { canvas: null, shellAlive: shellAlive(null) };
    const v = c.sideRead('view-state.json', {});
    return { ...v, canvas: { id: c.id, path: c.dir }, openComments: side.listComments(c).filter((k) => k.status !== 'resolved').length, shellAlive: shellAlive(c.id) };
  }

  async function route(req, res, url) {
    const p = url.pathname, m = req.method;
    const q = (k) => url.searchParams.get(k);
    const body = () => readJson(req);

    if (p === '/__atelier/open' && m === 'POST') {
      const c = registry.add((await body()).path);
      return { id: c.id, path: c.dir, boards: `${origins.boards}/c/${c.id}/` };
    }
    if (p === '/__atelier/canvases' && m === 'GET') return { canvases: Object.entries(registry.known).map(([id, dir]) => ({ id, path: dir })) };
    if (p === '/__atelier/view' && m === 'PUT') {
      const b = await body(), c = canvasOf(b.canvas);
      lastView = c.id;
      return c.locked(() => side.writeView(c, b));
    }
    if (p === '/__agent/view' && m === 'GET') return view(url);
    if (p === '/__atelier/canvas' && m === 'GET') return summary(canvasOf(q('canvas'))); // the shell's: no reference pages written
    if (p === '/__atelier/thumb' && m === 'GET') { // a board's PNG, or 202 while it renders (SSE {type:"thumb"} when done)
      const t = thumbs.get(canvasOf(q('canvas')), q('board'));
      if (!t.png) { sendJson(res, 202, { pending: true, sha: t.sha }); return null; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-sha': t.sha });
      res.end(t.png);
      return null;
    }
    if (p === '/__agent/canvas' && m === 'GET') { // with readFirst: the reference pages, refreshed
      const c = canvasOf(q('canvas'));
      return { ...summary(c), readFirst: await c.locked(() => writeReference(c)) };
    }
    if (p === '/__agent/reference' && m === 'GET') { const c = canvasOf(q('canvas')); return { files: await c.locked(() => writeReference(c)) }; }
    if (p === '/__agent/tree' && m === 'GET') return tree(url);
    if (p === '/__agent/resolve' && m === 'GET') return locate(url); // POST /__agent/resolve is the comment one
    if (p === '/__agent/comments' && m === 'GET') return { comments: side.listComments(canvasOf(q('canvas'))) };
    if (p === '/__agent/versions' && m === 'GET') {
      const c = canvasOf(q('canvas')), file = q('file');
      if (file) c.file(file);
      return { file, versions: file ? versions(c.dir, file) : undefined, checkpoints: c.sideRead('checkpoints.json', []) };
    }
    if (m !== 'POST') return undefined;

    const b = await body();
    if (p === '/__agent/cmd') return cmd(req, res, b).then(() => null);
    if (p === '/__agent/result') { result(res, b); return null; }
    const c = canvasOf(b.canvas);
    if (Object.hasOwn(PLAY, p)) return player[PLAY[p]](c, b); // not under the canvas lock: they write nothing it guards, and take seconds
    const posts = {
      '/__agent/comments': () => side.createComment(c, b),
      '/__agent/reply': () => side.replyComment(c, b),
      '/__agent/resolve': () => side.resolveComment(c, b),
      '/__agent/write': () => {
        if (typeof b.content !== 'string') fail(400, 'content must be a string');
        return { file: b.file, sha: side.writeBoard(c, b.file, b.content, b.expectSha) };
      },
      '/__agent/restore': () => side.restore(c, b),
      '/__agent/checkpoint': () => side.checkpoint(c, b),
      '/__agent/asset': () => side.addAsset(c, b.path),
      '/__agent/board': () => {
        if (b.op === 'kopia') { const n = registry.add(kopia(c)); return { id: n.id, path: n.dir }; }
        if (!Object.hasOwn(ops, b.op)) fail(400, `op must be one of ${[...Object.keys(ops), 'kopia'].join(', ')}`);
        return ops[b.op](c, b);
      },
    };
    return Object.hasOwn(posts, p) ? c.locked(posts[p]) : undefined; // writes run one at a time per canvas
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/__atelier/') && !p.startsWith('/__agent/')) return sendJson(res, 404, { error: 'not found' });
    if (p === '/__atelier/ping' && req.method === 'GET') return sendJson(res, 200, { ok: true, app: 'atelierd' });
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (p === '/__atelier/events' && req.method === 'GET') return tokenOk(bearer ?? url.searchParams.get('t'), token) ? events(req, res, url) : sendJson(res, 401, { error: 'token required' });
    if (!tokenOk(bearer, token)) return sendJson(res, 401, { error: 'token required' });
    if (mounted.some((m) => m(req, res, url))) return;
    try {
      const out = await route(req, res, url);
      if (out === undefined) sendJson(res, 404, { error: 'no such route' });
      else if (out !== null) sendJson(res, 200, out);
    } catch (e) {
      if (!e.status) throw e;
      sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    }
  }

  handle.close = () => {
    comments.close();
    thumbs.close();
    clearInterval(heartbeat);
    registry.off('event', broadcast);
    for (const k of clients) k.res.end();
    for (const { res, timer } of pending.values()) { clearTimeout(timer); sendJson(res, 503, { error: 'atelierd stopped' }); }
    pending.clear();
  };
  return handle;
}
