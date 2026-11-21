// Record (T12): a board filmed for 2-10 s, for atelier_record and the shell's Record button.
//   <canvas>/.atelier/shots/rec-<ts>/frame-NNN.png   a frame every ~200 ms
//                                   events.json     {board, runner, seconds, startedAt, frames:[{file,t}], events:[{t,type,…}], steps?}
//                                   filmstrip.png   the frames as one contact sheet
//                                   video.mp4, video.gif   when ffmpeg is there (never needed)
// Live (the panel open): the shell films the board's rect on screen with native snapshots (its op "frames", which the
// mod hands to atelier-web; the PNGs land in the helper's shots folder by ref and are moved in here), and the bridge
// keeps the event log (op "events"), so what the user does in Play is in it. Headless: thumbs.mjs's Chrome at the
// board's canvas size from its start state; CDP screenshots are the frames. Steps (as in atelier_play) run during the
// recording either way. t is ms since the recording started.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fail, writeNew } from './canvas.mjs';
import { ownDir } from './versions.mjs';
import { sendJson, readJson } from './http.mjs';

const EVERY = 200, KEEP = 10; // shortcut: only the newest KEEP recordings stay (live retina frames are large); older rec-* folders go
const ACTS = ['click', 'tap', 'type', 'key', 'scroll', 'hover'];
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['type', 'phase', 'name', 'transition', 'id', 'tag', 'text60', 'label', 'keys', 'text', 'url', 'trusted'];
const FFMPEG = [process.env.FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((f) => f && path.isAbsolute(f) && fs.existsSync(f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The answer's timeline (the tray shows it): up to n events, in time order. Taps and keys first, then state changes
// and errors (a ticking state samples one every 100 ms), then animations (one tap can start a dozen). events.json keeps them all.
const rank = (e) => (ACTS.includes(e.type) ? 0 : e.type === 'animation' ? 2 : 1);
const timeline = (events, n = 12) => [...events].sort((x, y) => rank(x) - rank(y)).slice(0, n).sort((x, y) => x.t - y.t);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---------- PNG, with no dependencies: 8-bit grey, RGB, palette, grey+alpha and RGBA, not interlaced ----------

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** RGBA pixels (w*h*4) → a PNG. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); // filter 0 per row
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A PNG → {w, h, rgba}. Throws on what it does not read (16-bit, interlaced). */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let w, h, depth, type, inter, plte = null, trns = null;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), t = buf.toString('latin1', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
    else if (t === 'PLTE') plte = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    i += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || inter !== 0) throw new Error(`PNG kind not read here (depth ${depth}, type ${type}, interlace ${inter})`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[o + x - ch] : 0, b = y ? px[o - stride + x] : 0, c = x >= ch && y ? px[o - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[o + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, o = i * 4;
    if (type === 6) px.copy(rgba, o, s, s + 4);
    else if (type === 2) { rgba[o] = px[s]; rgba[o + 1] = px[s + 1]; rgba[o + 2] = px[s + 2]; rgba[o + 3] = 255; }
    else if (type === 3) { const k = px[s] * 3; rgba[o] = plte[k]; rgba[o + 1] = plte[k + 1]; rgba[o + 2] = plte[k + 2]; rgba[o + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[s]; rgba[o + 3] = type === 4 ? px[s + 1] : 255; }
  }
  return { w, h, rgba };
}

// The frames as one sheet: at most 30 (evenly picked), 10 a row, each 120 px wide (averaged over at most 4×4 samples
// per cell pixel), on the page colour. Async: it yields between frames, so atelierd keeps answering while large live
// frames are decoded (30 frames of 2600×2120 take seconds).
export async function filmstrip(pngs) {
  const pick = pngs.length <= 30 ? pngs : Array.from({ length: 30 }, (_, i) => pngs[Math.round((i * (pngs.length - 1)) / 29)]);
  const first = decodePng(pick[0]), CW = Math.min(120, first.w), CH = Math.max(1, Math.round((first.h * CW) / first.w)), GAP = 4;
  const cols = Math.min(10, pick.length), rows = Math.ceil(pick.length / cols);
  const W = cols * CW + (cols + 1) * GAP, H = rows * CH + (rows + 1) * GAP, out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) out.writeUInt32BE(0x1e1e1eff, i * 4);
  for (let n = 0; n < pick.length; n++) {
    if (n) await new Promise((r) => setImmediate(r));
    const img = n ? decodePng(pick[n]) : first;
    const ox = GAP + (n % cols) * (CW + GAP), oy = GAP + Math.floor(n / cols) * (CH + GAP), sx = img.w / CW, sy = img.h / CH;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      const sum = [0, 0, 0];
      const dx = Math.max(1, Math.floor((x1 - x0) / 4)), dy = Math.max(1, Math.floor((y1 - y0) / 4));
      let n2 = 0;
      for (let yy = y0; yy < Math.min(y1, img.h); yy += dy) for (let xx = x0; xx < Math.min(x1, img.w); xx += dx) { const s = (yy * img.w + xx) * 4; for (let k = 0; k < 3; k++) sum[k] += img.rgba[s + k]; n2++; }
      n2 ||= 1;
      const o = ((oy + y) * W + ox + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(sum[k] / n2); // on an opaque sheet: alpha is dropped
      out[o + 3] = 255;
    }
  }
  return encodePng(W, H, out);
}

// ---------- ffmpeg (optional) ----------

function run(bin, args, ms) {
  return new Promise((ok) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', (code) => { clearTimeout(t); ok(code === 0); }).on('error', () => { clearTimeout(t); ok(false); });
  });
}
/** {video?, gif?} in dir from frame-NNN.png at fps; whatever ffmpeg did not make is left out. */
async function encode(dir, fps, w, h) {
  if (!FFMPEG) return {};
  const even = (v) => Math.max(2, v - (v % 2)), input = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'frame-%03d.png')];
  const out = {}, mp4 = path.join(dir, 'video.mp4'), gif = path.join(dir, 'video.gif');
  const size = `scale=${even(w)}:${even(h)}`, end = Date.now() + 20000; // one deadline for all: the MCP call has 65 s
  const go = (args) => (end - Date.now() > 1000 ? run(FFMPEG, [...input, ...args], end - Date.now()) : false);
  if (await go(['-vf', `${size},format=yuv420p`, '-c:v', 'libx264', '-movflags', '+faststart', mp4])
    || await go(['-vf', `${size},format=yuv420p`, '-c:v', 'mpeg4', mp4])) out.video = mp4;
  const gw = Math.min(480, even(w));
  if (await go(['-vf', `scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, gif])) out.gif = gif;
  return out;
}

// ---------- recording ----------

function checkSteps(steps) {
  if (steps === undefined) return [];
  if (!Array.isArray(steps) || !steps.length || steps.length > 50) fail(400, 'steps must be a list of 1-50 steps');
  for (const s of steps) if (!s || typeof s !== 'object' || Array.isArray(s) || !ACTS.includes(s.do)) fail(400, `each step needs do: one of ${ACTS.join(', ')}`);
  return steps;
}
// Each step, then a wait until the board is still (as atelier_play), while the frames are taken. Stops at the first
// failure or at the end of the recording; the rest come back as not run.
async function runSteps(exec, list, end) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (end - Date.now() < 300) { for (const s of list.slice(i)) out.push({ do: s.do, ok: false, run: false, error: 'not run: the recording ended first' }); break; }
    let r;
    try { r = (await exec('play', { steps: [list[i]] })).steps[0]; } catch (e) { r = { do: list[i].do, ok: false, error: String(e.message || e) }; }
    if (r.ok) { try { const w = await exec('wait', { timeoutMs: Math.min(Math.max(end - Date.now(), 300), 5000) }); r.settled = w.settled; } catch { /* the step ran */ } }
    out.push(r);
    if (!r.ok) { for (const s of list.slice(i + 1)) out.push({ do: s.do, ok: false, run: false, error: 'not run: a step before it failed' }); break; }
  }
  return out;
}
const clean = (e, t0) => {
  const o = { t: Math.round(e.t - t0) };
  for (const k of FIELDS) if (e[k] !== undefined) o[k] = typeof e[k] === 'string' ? e[k].slice(0, 300) : k === 'keys' && Array.isArray(e.keys) ? e.keys.slice(0, 10).map((x) => String(x).slice(0, 60)) : e[k];
  return o;
};

/** ctx: {registry, thumbs (createThumbs), ask(cmd) → {status, body} (api.mjs), shellAlive(id), helperShots: the folder
 *  atelier-web writes live snapshots into}. */
export function createRecord({ thumbs, ask, shellAlive, helperShots }) {
  const lost = (why) => fail(502, why);
  const liveExec = (c, file) => async (op, args = {}, timeoutMs = 15000) => {
    const r = await ask({ canvas: c.id, op, args: { board: file, ...args }, timeoutMs });
    if (r.status !== 200) fail(r.status === 409 ? 409 : 502, r.body?.error || 'the shell did not answer');
    return r.body.result;
  };
  // Live is decided before any step runs: the shell can film the board (frames with check: its checks, no filming) and
  // the event log answers. A failure here films headless instead; after it, a live failure is an error, never a
  // headless rerun, so the steps run once, on the runner the result names.
  async function liveReady(c, file, ms) {
    const exec = liveExec(c, file);
    await exec('frames', { ms, every: EVERY, check: true });
    const { now: t0 } = await exec('events', { since: 9e15, watchMs: ms + 1000 });
    return { exec, t0 };
  }
  async function live({ exec, t0 }, ms, steps) {
    const [filmed, played] = await Promise.allSettled([exec('frames', { ms, every: EVERY }, ms + 20000), runSteps(exec, steps, t0 + ms)]);
    if (filmed.status === 'rejected') throw filmed.reason;
    const shot = filmed.value;
    // Every frame the shell names leaves the helper's folder, read in or not.
    const list = Array.isArray(shot?.frames) ? shot.frames.slice(0, 100) : [];
    let pngs;
    try { pngs = list.map((f) => read(f, t0)); } finally { for (const f of list) if (REF.test(f?.ref ?? '')) fs.rmSync(path.join(helperShots, `${f.ref}.png`), { force: true }); }
    const { events } = await exec('events', { since: t0 - 1 });
    return { runner: typeof shot?.runner === 'string' ? shot.runner.slice(0, 40) : 'live', t0, pngs, events, steps: played.value };
  }
  function read(f, t0) {
    if (!REF.test(f?.ref ?? '')) lost('a native frame came back without its ref');
    try {
      const fd = fs.openSync(path.join(helperShots, `${f.ref}.png`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { return { t: Number(f.t) || t0, png: fs.readFileSync(fd) }; } finally { fs.closeSync(fd); }
    } catch { lost('a native frame did not arrive'); }
  }

  function headless(c, file, ms, steps) {
    return thumbs.session(c, file, async ({ evaluate, capture, w, h }) => {
      const exec = async (op, args = {}) => {
        try { return await evaluate(`window.__atelierBridgeOp ? window.__atelierBridgeOp(${JSON.stringify(op)}, ${JSON.stringify(args)}) : Promise.reject(new Error('the board has no bridge'))`); } catch (e) { fail(400, String(e.message || e).replace(/^Error: /, '').slice(0, 500)); }
      };
      const { now: t0 } = await exec('events', { since: 9e15, watchMs: ms + 1000 });
      const pngs = [];
      const film = async () => {
        for (let i = 0; t0 + i * EVERY < t0 + ms; i++) {
          const due = t0 + i * EVERY, wait = due - Date.now();
          if (wait > 0) await sleep(wait); else if (wait < -EVERY) continue; // a slow capture: skip, do not bunch
          const t = Date.now();
          pngs.push({ t, png: await capture({ x: 0, y: 0, width: w, height: h }) });
        }
      };
      const [, played] = await Promise.all([film(), runSteps(exec, steps, t0 + ms)]);
      const { events } = await exec('events', { since: t0 - 1 });
      return { runner: 'headless-chrome', t0, pngs, events, steps: played };
    });
  }

  /** b: {board, seconds? 2-10 (default 5), steps?, runner? "live"|"headless"}. Live when the panel is open, falling back
   *  to headless when the shell cannot film it (not the native view, the board not on screen) unless runner is "live". */
  async function record(c, b, { preview = false } = {}) {
    const file = b.board;
    c.file(file);
    if (!c.read().obj.boards[file]) fail(404, 'no such board in canvas.json');
    const seconds = b.seconds === undefined ? 5 : b.seconds;
    if (typeof seconds !== 'number' || !(seconds >= 2 && seconds <= 10)) fail(400, 'seconds must be a number from 2 to 10');
    const steps = checkSteps(b.steps), ms = Math.round(seconds * 1000);
    if (b.runner !== undefined && b.runner !== 'live' && b.runner !== 'headless') fail(400, 'runner must be live or headless');
    let r = null, why = null;
    if (b.runner !== 'headless' && shellAlive(c.id)) {
      let ready = null;
      try { ready = await liveReady(c, file, ms); } catch (e) { if (b.runner === 'live') throw e; why = String(e.message || e).slice(0, 200); }
      if (ready) r = await live(ready, ms, steps);
    } else if (b.runner === 'live') fail(409, 'Atelier is not open, so there is no live board; use runner "headless"');
    r ||= await headless(c, file, ms, steps);
    if (!r.pngs.length) fail(502, 'no frame was taken');

    const shots = ownDir(c.dir, path.join(c.side, 'shots'));
    let dir = path.join(shots, `rec-${stamp()}`);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(shots, `rec-${stamp()}-${i}`);
    fs.mkdirSync(dir);
    ownDir(c.dir, dir);
    const t0 = r.t0, frames = r.pngs.map((f, i) => {
      const name = `frame-${String(i).padStart(3, '0')}.png`;
      writeNew(path.join(dir, name), f.png);
      return { file: name, t: Math.round(f.t - t0) };
    });
    const events = (Array.isArray(r.events) ? r.events : []).filter((e) => e && Number.isFinite(e.t) && typeof e.type === 'string')
      .map((e) => clean(e, t0)).filter((e) => e.t >= 0 && e.t <= ms + 2000).sort((x, y) => x.t - y.t).slice(0, 300);
    const log = { board: file, runner: r.runner, seconds, startedAt: new Date(t0).toISOString(), frames, events, ...(steps.length ? { steps: r.steps } : {}), ...(why ? { notLive: why } : {}) };
    const eventsPath = path.join(dir, 'events.json');
    writeNew(eventsPath, JSON.stringify(log, null, 1));
    const sheet = await filmstrip(r.pngs.map((f) => f.png)), filmPath = path.join(dir, 'filmstrip.png');
    writeNew(filmPath, sheet);
    const { w, h } = decodePng(r.pngs[0].png), span = (frames.at(-1).t + EVERY) / 1000;
    const media = await encode(dir, Math.max(1, Math.round((frames.length / span) * 10) / 10), w, h);
    const recs = fs.readdirSync(shots).filter((n) => /^rec-\d{4}-\d\d-\d\dT/.test(n)).sort();
    for (const old of recs.slice(0, -KEEP)) fs.rmSync(path.join(shots, old), { recursive: true, force: true });
    const seen = new Map();
    for (const e of events) if (e.type === 'click' && e.id && !seen.has(e.id) && seen.size < 10) seen.set(e.id, { id: e.id, tag: e.tag ?? null, label: e.text60 ?? null });
    return {
      board: file, runner: r.runner, dir, frames: frames.length, seconds, filmstrip: filmPath, events: eventsPath, ...media,
      anchors: [...seen.values()], timeline: timeline(events), ...(steps.length ? { steps: r.steps } : {}), ...(why ? { notLive: why } : {}),
      ...(preview ? { preview: sheet.toString('base64') } : {}),
    };
  }
  return { record };
}

/** Routes for api.mjs, after its token check, as comments.mjs: POST /__agent/record (atelier_record) and
 *  /__atelier/record (the shell's Record button; its answer carries the filmstrip as base64 preview). */
export function mountRecord(ctx) {
  const { registry } = ctx, rec = createRecord(ctx);
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');
  function handle(req, res, url) {
    const p = url.pathname;
    if (req.method !== 'POST' || (p !== '/__agent/record' && p !== '/__atelier/record')) return false;
    readJson(req).then((b) => rec.record(canvasOf(b.canvas), b, { preview: p === '/__atelier/record' })).then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  }
  return handle;
}
