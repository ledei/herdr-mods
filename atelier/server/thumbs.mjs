// Board snapshots for the shell's boards that are not live: one headless Chrome over CDP (Node 22's global WebSocket),
// started on the first request, renders a board from the boards origin at its w×h. PNGs are cached in
// <canvas>/.atelier/thumbs/<file>.<sha12>.<w>x<h>.png, keyed by the file's sha and the board's size; a new one replaces
// the older ones of that file.
// get() answers from the cache, or starts a render and says pending; the render's end is emitted as
// {type:"thumb", canvas, file, sha, w, h} (or {…, error}) so the shell fetches it then.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { atomicWrite, fail, sha256 } from './canvas.mjs';
import { ownDir } from './versions.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORTS = [47950, 47999]; // never 9333
const PAGES = 6; // renders at once
const BOOT_MS = 8000, RENDER_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const free = (p) => new Promise((r) => { const s = net.createServer().once('error', () => r(false)).listen(p, '127.0.0.1', () => s.close(() => r(true))); });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const within = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
};

// Chrome with PAGES page sessions on one browser socket. Resolves {take(), give(page), close()}; a page is {send, go}.
async function launch(profile) {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  // A port that looked free can be taken by another launch before Chrome binds it: then Chrome says it listens
  // elsewhere (or not at all), is killed, and the next port is tried (as test/bridge/chrome.mjs does).
  let proc = null, ws = null;
  for (let p = PORTS[0]; p <= PORTS[1] && !proc; p++) {
    if (!(await free(p))) continue;
    const c = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${p}`, `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ws = await new Promise((r) => {
      const t = setTimeout(() => r(null), BOOT_MS * 2);
      c.stderr.on('data', (d) => {
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)\s/.exec(err);
        if (m || /Cannot start http server/.test(err)) { clearTimeout(t); r(m && m[1].startsWith(`ws://127.0.0.1:${p}/`) ? m[1] : null); }
      });
      c.once('exit', () => { clearTimeout(t); r(null); }).once('error', () => { clearTimeout(t); r(null); });
    });
    c.stderr.removeAllListeners('data').resume(); // keep draining it
    if (ws) proc = c;
    else { c.kill(); if (c.exitCode === null && c.signalCode === null) await new Promise((r) => c.once('exit', r)); }
  }
  if (!proc) throw new Error(`no free port in ${PORTS.join('-')}`);
  const exited = new Promise((r) => proc.once('exit', r).once('error', r));
  const kill = () => { try { proc.kill(); } catch { /* gone */ } };
  process.once('exit', kill);
  const stop = async () => { process.off('exit', kill); kill(); await exited; fs.rmSync(profile, { recursive: true, force: true }); };
  try {
    const sock = new WebSocket(ws);
    await new Promise((ok, no) => { sock.addEventListener('open', ok, { once: true }); sock.addEventListener('error', () => no(new Error('no CDP socket')), { once: true }); });
    let id = 0;
    const waiting = new Map(), loads = new Map(); // session → load callback
    sock.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.no(new Error(m.error.message)) : w.ok(m.result); }
      if (m.method === 'Page.loadEventFired') loads.get(m.sessionId)?.();
    });
    sock.addEventListener('close', () => { for (const w of waiting.values()) w.no(new Error('Chrome went away')); waiting.clear(); });
    const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
      if (sock.readyState !== WebSocket.OPEN) return no(new Error('Chrome went away'));
      const i = ++id; waiting.set(i, { ok, no }); sock.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const pages = [];
    for (let i = 0; i < PAGES; i++) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true }); // own window: stays visible, so frames run
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const s = (method, params) => send(method, params, sessionId);
      await s('Page.enable');
      pages.push({
        send: s,
        go: (url) => { const loaded = new Promise((r) => loads.set(sessionId, r)); return s('Page.navigate', { url }).then(() => within(loaded, BOOT_MS * 2, 'load')); },
      });
    }
    const idle = [...pages], queue = [];
    return {
      take: () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((r) => queue.push(r))),
      give: (p) => (queue.length ? queue.shift()(p) : idle.push(p)),
      dead: () => sock.readyState !== WebSocket.OPEN,
      close: async () => { try { sock.close(); } catch { /* gone */ } await stop(); },
    };
  } catch (e) { await stop(); throw e; }
}

// Until #dc-root has content (a legacy board never gets one: it is shot after BOOT_MS), then fonts (at most 2 s: a
// stalled font request never settles them) and two frames.
const SETTLE = `(async () => {
  for (let i = 0; i < ${BOOT_MS / 100} && !document.getElementById('dc-root')?.firstElementChild; i++) await new Promise((r) => setTimeout(r, 100));
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 300));
})()`;

/** home: ATELIER_HOME (the profile goes under run/); boards(): the boards origin; emit(ev): the SSE broadcast. */
export function createThumbs({ home, boards, emit }) {
  let chrome = null, closed = false, broken = null;
  const jobs = new Map(); // png path → render promise
  const profile = path.join(home, 'run', 'thumbs-chrome'); // one atelierd per home; wiped at each launch, so a killed one leaves nothing that grows
  const browser = () => {
    if (chrome) return chrome.then((b) => (b.dead() ? (chrome = null, browser()) : b));
    chrome = launch(profile).catch((e) => { chrome = null; broken = e; throw e; });
    return chrome;
  };

  async function render(c, file, w, h) {
    const b = await browser();
    const page = await b.take();
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.go(`${boards()}/c/${c.id}/${encodeURIComponent(file)}`);
      await within(page.send('Runtime.evaluate', { expression: SETTLE, awaitPromise: true }), RENDER_MS, 'render');
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      return Buffer.from(data, 'base64');
    } finally {
      page.go('about:blank').catch(() => {}).finally(() => b.give(page)); // the board stops running; its load event lands before the next go
    }
  }

  /** {png: Buffer, sha} from the cache, else {pending: true, sha} with a render started (one per file and sha). */
  function get(c, file) {
    const f = c.file(file);
    let buf; try { buf = fs.readFileSync(f); } catch { fail(404, 'no such board file'); }
    const e = c.read().obj.boards[file];
    if (!e) fail(404, 'no such board in canvas.json');
    const size = (v, d) => Math.min(Math.max(Math.round(Number.isFinite(+v) ? +v : d), 16), 4000), w = size(e.w, 390), h = size(e.h, 844);
    const sha = sha256(buf), dir = ownDir(c.dir, path.join(c.side, 'thumbs')), name = `${file}.${sha.slice(0, 12)}.${w}x${h}.png`, png = path.join(dir, name);
    try {
      const fd = fs.openSync(png, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { return { png: fs.readFileSync(fd), sha }; } finally { fs.closeSync(fd); }
    } catch { /* not rendered yet */ }
    if (closed) fail(503, 'atelierd is stopping');
    if (broken && !chrome) { const why = broken; broken = null; fail(503, `no Chrome for snapshots: ${why.message}`); } // the next request tries again
    if (!jobs.has(png)) {
      const job = render(c, file, w, h).then((out) => {
        let now = null; try { now = sha256(fs.readFileSync(f)); } catch { /* deleted */ }
        if (now !== sha || closed) return; // changed while it rendered: the shell asks again for the new sha
        atomicWrite(png, out);
        const old = new RegExp(`^${escape(file)}\\.[0-9a-f]{12}(\\.\\d+x\\d+)?\\.png$`); // older shas and sizes, and pre-size names
        for (const n of fs.readdirSync(dir)) if (n !== name && old.test(n)) fs.rmSync(path.join(dir, n), { force: true });
        emit({ type: 'thumb', canvas: c.id, file, sha, w, h });
      }).catch((err) => { if (!closed) emit({ type: 'thumb', canvas: c.id, file, sha, error: String(err.message || err).slice(0, 300) }); })
        .finally(() => jobs.delete(png));
      jobs.set(png, job);
    }
    return { pending: true, sha };
  }

  /** For the headless play runner (play.mjs): board `file` on a page of its own at its canvas size, booted and
   *  settled like a snapshot; fn({evaluate(expr), capture(clip), w, h}) runs on it, then the page is freed. */
  async function session(c, file, fn) {
    c.file(file);
    const e = c.read().obj.boards[file];
    if (!e) fail(404, 'no such board in canvas.json');
    if (closed) fail(503, 'atelierd is stopping');
    const size = (v, d) => Math.min(Math.max(Math.round(Number.isFinite(+v) ? +v : d), 16), 4000), w = size(e.w, 390), h = size(e.h, 844);
    let b; try { b = await browser(); } catch (err) { broken = null; fail(503, `no Chrome for headless play: ${err.message}`); }
    const page = await b.take();
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.go(`${boards()}/c/${c.id}/${encodeURIComponent(file)}`);
      await within(page.send('Runtime.evaluate', { expression: SETTLE, awaitPromise: true }), RENDER_MS, 'render');
      const evaluate = async (expression) => {
        const r = await within(page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), 40000, 'headless step');
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
        return r.result.value;
      };
      const capture = async (clip) => Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })).data, 'base64');
      return await fn({ evaluate, capture, w, h });
    } finally {
      page.go('about:blank').catch(() => {}).finally(() => b.give(page));
    }
  }

  async function close() {
    closed = true;
    const b = chrome; chrome = null;
    if (b) await b.then((x) => x.close(), () => {});
  }
  return { get, session, close };
}
