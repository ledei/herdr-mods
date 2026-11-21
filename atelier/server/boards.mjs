// The boards origin: /c/<canvasId>/<path> from the canvas folder, the runtime for any */support.js,
// ds/<ns>/* from the canvas else the fallback dirs, /_blob/<id> from <canvas>/assets/<id>.*, and the bridge.
// Read-only and static: the API is never answered here.
import fs from 'node:fs';
import path from 'node:path';
import { send, sendFile, inside, TYPES } from './http.mjs';
import { withVersion } from './versions.mjs';

export const BRIDGE_PATH = '/_atelier/bridge.js';
// data-ui: the only origin whose messages the bridge answers (and the one it replies to).
const bridgeTag = (ui) => `<script src="${BRIDGE_PATH}"${ui ? ` data-ui="${ui}"` : ''}></script>`;

// Before the runtime's own <script src="…support.js">, so the bridge sees its errors; else first thing in <head>.
export function injectBridge(src, ui) {
  const tag = bridgeTag(ui);
  const at = /<script\b[^>]*\bsrc\s*=\s*["']?[^"'>]*support\.js\b/i.exec(src);
  if (at) return src.slice(0, at.index) + tag + src.slice(at.index);
  const head = /<head\b[^>]*>/i.exec(src);
  return head ? src.slice(0, head.index + head[0].length) + tag + src.slice(head.index + head[0].length) : tag + src;
}

function blob(c, id) {
  if (!c || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const dir = path.join(c.dir, 'assets');
  let hit; try { hit = fs.readdirSync(dir).find((f) => f.startsWith(id + '.') || f === id); } catch { return null; }
  return hit ? inside(c.dir, 'assets/' + hit) : null;
}

export function serveBoards(req, res, { registry, cfg }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === BRIDGE_PATH) return sendFile(res, cfg.bridge);
  // Boards use origin-absolute /_blob/<id>; the canvas comes from the board that asked (Referer), never from another open canvas.
  const b = /^\/_blob\/([^/]+)$/.exec(rel);
  if (b) {
    let ref = null;
    try { ref = /^\/c\/([0-9a-f]{12})\//.exec(new URL(req.headers.referer).pathname)?.[1]; } catch { /* no referer */ }
    const file = blob(ref && registry.get(ref), b[1]);
    return file ? sendFile(res, file) : send(res, 404, 'Not found');
  }
  const m = /^\/c\/([0-9a-f]{12})\/(.+)$/.exec(rel);
  const c = m && registry.get(m[1]);
  if (!c) return send(res, 404, 'Not found');
  const p = m[2];
  let file = null;
  if (p === 'support.js' || p.endsWith('/support.js')) file = cfg.runtime;
  else if (p.startsWith('_blob/')) file = blob(c, p.slice(6));
  else {
    file = inside(c.dir, p);
    const ds = /^ds\/([^/]+)\/(.+)$/.exec(p);
    if (!file && ds) for (const d of cfg.dsDirs) { try { file = inside(fs.realpathSync(d), ds[1] + '/' + ds[2]); } catch { /* missing dir */ } if (file) break; }
  }
  file = withVersion(c.dir, file, req.url); // ?v=<ts>: an old version, for compare
  if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found');
  if (file.endsWith('.dc.html')) {
    // Only the shell may frame a board: another page cannot embed it and talk to its bridge.
    const port = cfg.ui;
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'content-security-policy': port ? `frame-ancestors ${cfg.ui}` : "frame-ancestors 'none'" });
    return res.end(req.method === 'HEAD' ? '' : injectBridge(fs.readFileSync(file, 'utf8'), cfg.ui));
  }
  sendFile(res, file);
}
