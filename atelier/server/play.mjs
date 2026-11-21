// Play: agents click through a running board the way the user does, wait until it is still, read its logic state and
// logs, and take screenshots only once it settled. Every op runs in the board's bridge (server/bridge.js):
//   live      through the shell (agent cmd → the board's frame), on the board the user sees, its state kept;
//   headless  on a fresh page of thumbs.mjs's Chrome at the board's canvas size, where the bridge answers
//             window.__atelierBridgeOp over CDP; it starts from the board's start state, so steps replay a path first.
// A live shot goes shell → mod → atelier-web's native snapshot, written as <helper shots>/<ref>.png; atelierd moves it
// into the canvas. Shots live in <canvas>/.atelier/shots/<ts>-<board>.png, the last KEEP of them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, writeNew } from './canvas.mjs';
import { ownDir } from './versions.mjs';

const KEEP = 100;
const BUDGET = 40000; // per call, waits included: with a last step's own timeouts it stays under the MCP's 65 s; later steps come back as not run
const NOT_OPEN = 'Atelier is not open, so there is no live board. Open the canvas in the Atelier panel, or use atelier_shot runner "headless" (with steps) without it.';
const ACTS = ['click', 'tap', 'type', 'key', 'scroll', 'hover'];
const clamp = (v, lo, hi, d) => Math.min(Math.max(Number.isFinite(v) ? v : d, lo), hi);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function checkSteps(steps, { optional = false } = {}) {
  if (steps === undefined && optional) return [];
  if (!Array.isArray(steps) || !steps.length || steps.length > 50) fail(400, 'steps must be a list of 1-50 steps');
  for (const s of steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || !ACTS.includes(s.do)) fail(400, `each step needs do: one of ${ACTS.join(', ')}`);
    for (const k of ['id', 'selector', 'text', 'value', 'key']) if (s[k] !== undefined && (typeof s[k] !== 'string' || s[k].length > 500)) fail(400, `step ${k} must be a short string`);
    for (const k of ['dx', 'dy']) if (s[k] !== undefined && !Number.isFinite(s[k])) fail(400, `step ${k} must be a number`);
  }
  return steps;
}

/** ask(cmd) → {status, body} from the shell (api.mjs); shellAlive(id); thumbs: createThumbs(); helperShots: the folder
 *  atelier-web writes live snapshots into (beside atelierd's home). */
export function createPlay({ ask, shellAlive, thumbs, helperShots }) {
  // The live bridge of one board, through the shell. The shell adds its runner to each result.
  const live = (c, board) => {
    let runner = null;
    const exec = async (op, args = {}, ms = 15000) => {
      const r = await ask({ canvas: c.id, op, args: { board, ...args }, timeoutMs: ms });
      if (r.status === 409) fail(409, NOT_OPEN);
      if (r.status !== 200) fail(r.status === 502 ? 400 : r.status, r.body?.error || 'the shell did not answer');
      const { runner: who, ...out } = r.body.result && typeof r.body.result === 'object' ? r.body.result : {};
      runner ||= who || 'live';
      return out;
    };
    return { exec, runner: () => runner };
  };
  const board = (c, b) => { c.file(b.board); if (!c.read().obj.boards[b.board]) fail(404, 'no such board in canvas.json'); return b.board; };

  // Each step, then a wait until the board is still: the next step never lands mid-transition. Stops at the first
  // failure, at a board that does not settle, or when the call's time runs out; the rest come back as not run.
  async function steps(exec, list, waitMs) {
    const t0 = Date.now(), out = [];
    const skip = (from, why) => { for (const s of list.slice(from)) out.push({ do: s.do, ok: false, run: false, error: `not run: ${why}` }); };
    for (let i = 0; i < list.length; i++) {
      const left = BUDGET - (Date.now() - t0);
      if (left < 300) { skip(i, 'the call ran out of time; send the rest in another call'); break; }
      const r = (await exec('play', { steps: [list[i]] })).steps[0];
      if (r.ok) {
        const ms = Math.max(300, Math.min(waitMs, left)), w = await exec('wait', { timeoutMs: ms }, ms + 5000);
        Object.assign(r, { settled: w.settled, ms: w.ms }, w.running.length ? { running: w.running } : {}, w.busy ? { busy: w.busy } : {});
      }
      out.push(r);
      if (!r.ok) { skip(i + 1, 'a step before it failed'); break; }
      if (!r.settled) { skip(i + 1, `the board was still moving ${r.ms} ms after the step before; atelier_wait, then go on`); break; }
    }
    return out;
  }

  async function play(c, b) {
    const file = board(c, b), list = checkSteps(b.steps), waitMs = clamp(b.waitMs, 300, 20000, 5000);
    const t0 = Date.now(), L = live(c, file);
    const out = await steps(L.exec, list, waitMs);
    const digest = await L.exec('digest'), { now, ...errors } = await L.exec('logs', { since: t0 - 1 });
    return { board: file, runner: L.runner(), ok: out.every((r) => r.ok), steps: out, digest, errors };
  }
  async function wait(c, b) {
    const ms = clamp(b.timeoutMs, 300, 30000, 5000), L = live(c, board(c, b));
    const w = await L.exec('wait', { timeoutMs: ms }, ms + 5000);
    return { board: b.board, runner: L.runner(), ...w };
  }
  async function state(c, b) {
    if (b.action !== undefined && b.action !== 'get' && b.action !== 'reset') fail(400, 'action must be get or reset');
    const L = live(c, board(c, b));
    if (b.action !== 'reset') { const s = await L.exec('state', { action: 'get' }); return { board: b.board, runner: L.runner(), ...s }; }
    await L.exec('state', { action: 'reset' });
    const w = await L.exec('wait', { timeoutMs: 5000 }, 10000);
    return { board: b.board, runner: L.runner(), reset: true, settled: w.settled, digest: await L.exec('digest') };
  }
  // Live when the shell is open; else a fresh headless load (the errors a board shows on opening).
  async function logs(c, b) {
    const file = board(c, b), since = clamp(b.since, 0, 1e15, 0);
    if (shellAlive(c.id)) { const L = live(c, file); const l = await L.exec('logs', { since }); return { board: file, runner: L.runner(), ...l }; }
    return thumbs.session(c, file, async ({ evaluate }) => {
      const exec = headlessExec(evaluate);
      await exec('wait', { timeoutMs: 3000 });
      return { board: file, runner: 'headless-chrome', ...(await exec('logs', { since })) };
    });
  }

  const headlessExec = (evaluate) => async (op, args = {}) => {
    try { return await evaluate(`window.__atelierBridgeOp ? window.__atelierBridgeOp(${JSON.stringify(op)}, ${JSON.stringify(args)}) : Promise.reject(new Error('the board has no bridge'))`); } catch (e) { fail(400, String(e.message || e).replace(/^Error: /, '').slice(0, 500)); }
  };

  // A PNG of the board, an element (id) or a region, once it settled (unless force). Headless replays steps first.
  async function shot(c, b) {
    const file = board(c, b), list = checkSteps(b.steps, { optional: true }), force = b.force === true;
    const waitMs = clamp(b.waitMs, 300, 20000, 5000);
    let region = null;
    if (b.region !== undefined) {
      const r = b.region;
      if (!r || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) || r.w < 1 || r.h < 1) fail(400, 'region must be {x, y, w, h} in board px');
      region = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    if (b.id !== undefined && typeof b.id !== 'string') fail(400, 'id must be an element id');
    const runner = b.runner ?? (shellAlive(c.id) ? 'live' : 'headless');
    if (runner !== 'live' && runner !== 'headless') fail(400, 'runner must be live or headless');
    const notStill = (w) => fail(409, `the board is not still after ${w.ms} ms (${JSON.stringify(w.busy || {})}); atelier_wait and try again, or pass force: true`, { settled: false, running: w.running });

    if (runner === 'headless') {
      return thumbs.session(c, file, async ({ evaluate, capture, w: W, h: H }) => {
        const exec = headlessExec(evaluate);
        const played = list.length ? await steps(exec, list, waitMs) : [];
        if (played.some((r) => !r.ok)) return { board: file, runner: 'headless-chrome', ok: false, steps: played, path: null };
        const w = await exec('wait', { timeoutMs: waitMs });
        if (!w.settled && !force) notStill(w);
        let clip = region || { x: 0, y: 0, w: W, h: H };
        if (b.id) { const bb = await exec('bbox', { id: b.id }); if (!bb) fail(404, 'no rendered element with that id'); const [x, y, ww, hh] = bb.bbox; clip = { x, y, w: Math.max(ww, 1), h: Math.max(hh, 1) }; }
        const png = await capture({ x: clip.x, y: clip.y, width: clip.w, height: clip.h });
        return { board: file, runner: 'headless-chrome', settled: w.settled, ms: w.ms, running: w.running, ...(played.length ? { steps: played } : {}), ...save(c, file, png), clip };
      });
    }
    const L = live(c, file);
    const played = list.length ? await steps(L.exec, list, waitMs) : [];
    if (played.some((r) => !r.ok)) return { board: file, runner: L.runner(), ok: false, steps: played, path: null };
    const ref = crypto.randomUUID();
    const r = await L.exec('shot', { ref, id: b.id, region, force, timeoutMs: waitMs }, waitMs + 20000);
    if (!r.settled && !force) notStill(r);
    const tmp = path.join(helperShots, `${ref}.png`);
    let png;
    try {
      const fd = fs.openSync(tmp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { png = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    } catch { fail(502, 'the native snapshot did not arrive'); } finally { fs.rmSync(tmp, { force: true }); }
    return { board: file, runner: L.runner(), settled: r.settled, ms: r.ms, running: r.running, scale: r.scale, ...(played.length ? { steps: played } : {}), ...save(c, file, png) };
  }

  // <canvas>/.atelier/shots/<ts>-<board>.png, never through a link; only the newest KEEP stay.
  function save(c, file, png) {
    const dir = ownDir(c.dir, path.join(c.side, 'shots')), stem = file.replace(/\.dc\.html$/, '');
    let name = `${stamp()}-${stem}.png`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp()}-${i}-${stem}.png`;
    writeNew(path.join(dir, name), png);
    const all = fs.readdirSync(dir).filter((n) => /^\d{4}-\d\d-\d\dT.*\.png$/.test(n)).sort();
    for (const old of all.slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true });
    return { path: path.join(dir, name), bytes: png.length, ...pngSize(png) };
  }
  const pngSize = (buf) => (buf.length > 24 && buf.subarray(1, 4).toString() === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : {});

  return { play, wait, state, logs, shot };
}
