// HTTP helpers shared by both origins.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BODY = 2 * 1024 * 1024;

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
export const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), TYPES['.json']);

// Resolve a URL path inside root, following symlinks; null if it escapes root or is not a file.
export function inside(root, rel) {
  if (rel.includes('\0') || rel.split('/').some((s) => s.startsWith('.'))) return null; // no .., no .atelier, no dotfiles
  try {
    const p = fs.realpathSync(path.resolve(root, '.' + path.sep + rel));
    return p.startsWith(root + path.sep) && fs.statSync(p).isFile() ? p : null;
  } catch { return null; }
}

export function sendFile(res, file) {
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}


// JSON body, at most MAX_BODY bytes (413 beyond).
export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body over 2 MB'), { status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); v && typeof v === 'object' && !Array.isArray(v) ? resolve(v) : reject(Object.assign(new Error('body must be a JSON object'), { status: 400 })); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
