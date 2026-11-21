#!/usr/bin/env node
// atelierd: the local Atelier server. Node built-ins only. Two listeners on 127.0.0.1:
//   UI origin:     the shell's static files (/__shell/*) and the API (/__atelier/*, /__agent/*), bearer token required
//   BOARDS origin: canvases at /c/<canvasId>/<path> with the bridge injected; never the API, so board code can't reach it
// Port file: $ATELIER_HOME/run/atelierd.json {ui, boards, token, pid}, mode 0600.
// Run: ATELIER_HOME=<dir> [ATELIER_RUNTIME=<support.js>] [ATELIER_DS=<dir>:<dir>] [ATELIER_SHELL=<dir>] node server/atelierd.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Registry } from './canvas.mjs';
import { createApi } from './api.mjs';
import { serveBoards } from './boards.mjs';
import { send, sendJson, inside, sendFile } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTS = [47900, 47999];
const defaultHome = () => path.join(process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app'), 'data', 'atelier');

function listen(handler, from) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', (e) => (e.code === 'EADDRINUSE' && from < PORTS[1] ? resolve(listen(handler, from + 1)) : reject(e)));
    server.listen(from, '127.0.0.1', () => resolve(server));
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function running(portFile) {
  let pf; try { pf = JSON.parse(fs.readFileSync(portFile, 'utf8')); } catch { return null; }
  if (!Number.isInteger(pf.pid) || !alive(pf.pid)) return null;
  try {
    const r = await fetch(pf.ui + '/__atelier/ping', { signal: AbortSignal.timeout(1000) });
    return (await r.json()).app === 'atelierd' ? pf : null;
  } catch { return null; }
}

// Host must name this listener on loopback (stops DNS rebinding).
const hostOk = (req, port) => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
// The boards listener also answers <key>.localhost: each board frame has its own origin (shell/boards.js boardUrl).
const boardHostOk = (req, port) => hostOk(req, port) || new RegExp(`^b[0-9a-z]{1,13}\\.localhost:${port}$`).test(req.headers.host ?? '');

/** Starts both listeners. opts: {home, runtime, dsDirs, shellDir, quiet}. Resolves {ui, boards, token, registry, close}. */
export async function start(opts = {}) {
  const home = path.resolve(opts.home || process.env.ATELIER_HOME || defaultHome());
  const portFile = path.join(home, 'run', 'atelierd.json');
  const other = await running(portFile);
  if (other) throw new Error(`atelierd is already running (pid ${other.pid}, ${other.ui})`);

  const cfg = {
    home,
    runtime: path.resolve(opts.runtime || process.env.ATELIER_RUNTIME || path.join(HERE, '..', 'vendor', 'runtime', 'support.js')),
    dsDirs: (opts.dsDirs || (process.env.ATELIER_DS || path.join(home, 'ds')).split(path.delimiter)).filter(Boolean).map((d) => path.resolve(d)),
    shellDir: path.resolve(opts.shellDir || process.env.ATELIER_SHELL || path.join(HERE, '..', 'shell')),
    bridge: path.join(HERE, 'bridge.js'),
  };
  const token = crypto.randomBytes(32).toString('hex');
  const registry = new Registry(home);
  let ui, boards;
  const origins = {};
  const api = createApi({ registry, token, origins });

  const uiServer = await listen((req, res) => {
    if (!hostOk(req, ui)) return send(res, 403, 'Forbidden host');
    const o = req.headers.origin;
    if (o !== undefined && o !== `http://127.0.0.1:${ui}` && o !== `http://localhost:${ui}`) return send(res, 403, 'Forbidden origin');
    let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
    if (url.pathname.startsWith('/__shell/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      let rel; try { rel = decodeURIComponent(url.pathname.slice('/__shell/'.length)) || 'index.html'; } catch { return send(res, 400, 'Bad request'); }
      if (rel.endsWith('/')) rel += 'index.html';
      let root; try { root = fs.realpathSync(cfg.shellDir); } catch { return send(res, 404, 'Not found'); }
      const file = inside(root, rel);
      return file ? sendFile(res, file) : send(res, 404, 'Not found');
    }
    api(req, res, url).catch((e) => { if (!res.headersSent) sendJson(res, e.status || 500, { error: String(e.message || e) }); else res.end(); });
  }, PORTS[0]);
  ui = uiServer.address().port;
  cfg.ui = `http://127.0.0.1:${ui}`; // boards.mjs: the bridge's data-ui and the boards' frame-ancestors
  const boardsServer = await listen((req, res) => {
    if (!boardHostOk(req, boards)) return send(res, 403, 'Forbidden host');
    serveBoards(req, res, { registry, cfg });
  }, ui + 1);
  boards = boardsServer.address().port;
  origins.ui = `http://127.0.0.1:${ui}`;
  origins.boards = `http://127.0.0.1:${boards}`;

  const info = { ui: origins.ui, boards: origins.boards, token, pid: process.pid };
  fs.mkdirSync(path.dirname(portFile), { recursive: true, mode: 0o700 });
  const tmp = portFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, portFile);
  if (!opts.quiet) console.log(JSON.stringify({ ui: info.ui, boards: info.boards, pid: info.pid }));

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    api.close();
    registry.close();
    for (const s of [uiServer, boardsServer]) s.closeAllConnections();
    await Promise.all([uiServer, boardsServer].map((s) => new Promise((r) => s.close(r))));
    try { if (JSON.parse(fs.readFileSync(portFile, 'utf8')).token === token) fs.rmSync(portFile); } catch { /* gone */ }
  }
  return { ...info, registry, close };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((d) => {
    const stop = () => d.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (e) => { console.error(String(e.message || e)); process.exit(/already running/.test(e.message) ? 0 : 1); });
}
