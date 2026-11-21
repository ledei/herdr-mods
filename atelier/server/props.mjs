// Tweaks (T11): a board's props as Claude Design declares them, data-props on its <script data-dc-script> (after the
// template, so outside every tidmap node): {"$preview":{…}, "<key>":{editor:"enum"|"boolean"|"range"|…, options?,
// min?, max?, step?, unit?, section?, default}}. Keys starting with $ are the runtime's own ($preview) or ours
// ($presets: {label: {key: value}}), never Tweaks.
//   get      the live values from the board's bridge (op "props"), or the file's defaults when Atelier is closed;
//   set      a live preview on the board in the panel, nothing written (the runtime's __dcSetProps);
//   reset    the live board back to the file's defaults;
//   persist  writes the given values as the file's defaults: only the data-props attribute changes, through
//            writeBoard (expectSha, a version snapshot first). Agents are held to the locked scope like other edits.
// mountProps(ctx) serves POST /__agent/props {canvas, board, action, values?, expectSha?, outOfScope?} and the shell's
// POST /__atelier/props/persist {canvas, board, values} (the user's own Save as default: no expectSha, no scope check).
import fs from 'node:fs';
import { fail, sha256 } from './canvas.mjs';
import { writeBoard } from './sidecar.mjs';
import { checkScope } from './scope.mjs';
import { sendJson, readJson } from './http.mjs';

const NOT_OPEN = 'Atelier is not open, so there is no live board to preview on. Open the canvas in the Atelier panel; get and persist work without it.';
const ACTIONS = ['get', 'set', 'reset', 'persist'];

// ---------- the attribute ----------

const ENT = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));

/** The data-props attribute of the first <script data-dc-script> after the template: {obj, quote, from, to} with
 *  [from, to) the byte range of its value, or null when the board has none. */
function locate(buf) {
  const s = buf.toString('latin1'); // one char per byte: indices are byte offsets
  const re = /<script(?=[\t\n\f\r />])/gi;
  re.lastIndex = Math.max(s.lastIndexOf('</x-dc>'), 0);
  for (let m; (m = re.exec(s));) {
    let i = m.index + m[0].length, dc = false, val = null;
    for (;;) { // the start tag's attributes, quotes respected (a value may hold ">")
      while (/[\t\n\f\r /]/.test(s[i] ?? '')) i++;
      if (i >= s.length || s[i] === '>') break;
      const n0 = i;
      while (i < s.length && !/[\t\n\f\r />=]/.test(s[i])) i++;
      const name = s.slice(n0, i).toLowerCase();
      let j = i; while (/[\t\n\f\r ]/.test(s[j] ?? '')) j++;
      let from = j, to = j, quote = '';
      if (s[j] === '=') {
        j++; while (/[\t\n\f\r ]/.test(s[j] ?? '')) j++;
        if (s[j] === '"' || s[j] === "'") { quote = s[j]; from = j + 1; to = s.indexOf(quote, from); if (to < 0) return null; i = to + 1; } else { from = j; while (j < s.length && !/[\t\n\f\r >]/.test(s[j])) j++; to = i = j; }
      }
      if (name === 'data-dc-script') dc = true;
      if (name === 'data-props') val = { quote, from, to };
    }
    if (!dc) continue;
    if (!val) return null;
    let obj; try { obj = JSON.parse(unescape(buf.subarray(val.from, val.to).toString('utf8'))); } catch { fail(400, 'the board\'s data-props is not valid JSON'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(400, 'the board\'s data-props is not a JSON object');
    return { obj, ...val };
  }
  return null;
}
// The value written back in the attribute's own style: compact JSON (as Claude Design writes it), & and the quote escaped.
const encode = (obj, quote) => {
  const t = JSON.stringify(obj).replace(/&/g, '&amp;');
  if (quote === '"') return t.replace(/"/g, '&quot;');
  const v = t.replace(/'/g, '&#39;');
  return quote ? v : `'${v}'`; // an unquoted value gets quotes
};

const tweaks = (obj) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => k[0] !== '$' && v && typeof v === 'object'));
const defaults = (meta) => Object.fromEntries(Object.entries(meta).filter(([, v]) => v.default !== undefined).map(([k, v]) => [k, v.default]));

/** Refuses a value the key's editor does not take (the same rules as the bridge's live preview). */
export function checkValue(meta, k, v) {
  const m = Object.hasOwn(meta, k) ? meta[k] : fail(400, `no Tweak ${k}; this board has ${Object.keys(meta).join(', ') || 'none'}`);
  if (m.editor === 'enum' && Array.isArray(m.options)) { if (!m.options.includes(v)) fail(400, `${k} must be one of ${m.options.join(', ')}`); return; }
  if (m.editor === 'boolean') { if (typeof v !== 'boolean') fail(400, `${k} must be true or false`); return; }
  if (m.editor === 'range' || m.editor === 'number') {
    const lo = Number.isFinite(m.min) ? m.min : -Infinity, hi = Number.isFinite(m.max) ? m.max : Infinity;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(400, `${k} must be a number${lo > -Infinity || hi < Infinity ? ` in ${lo}-${hi}` : ''}`);
    return;
  }
  if (typeof m.default === 'string' && typeof v !== 'string') fail(400, `${k} must be a string`);
  if (v === null || typeof v === 'object') fail(400, `${k} must be a string, number or boolean`);
}

function readBoard(c, board) {
  const f = c.file(board);
  try { return fs.readFileSync(f); } catch { fail(404, 'no such board file'); }
}

/** {meta, values, changed:{}, presets, sha} from the file itself. */
function fromSource(c, board) {
  const buf = readBoard(c, board), at = locate(buf), meta = at ? tweaks(at.obj) : {};
  const presets = at?.obj.$presets && typeof at.obj.$presets === 'object' ? at.obj.$presets : null;
  return { board, runner: 'source', meta, values: defaults(meta), changed: {}, ...(presets ? { presets } : {}), sha: sha256(buf) };
}

/** Writes values as the defaults. scope: true holds the write to view-state's locked scope (agents). */
function persist(c, b, { scope }) {
  const v = b.values;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) fail(400, 'values must be an object of Tweaks to save, e.g. {"start": "Steg 2 · vad"}');
  const buf = readBoard(c, b.board), at = locate(buf);
  if (!at) fail(400, 'this board has no data-props, so it has no Tweaks to save');
  const meta = tweaks(at.obj), changed = {};
  for (const [k, x] of Object.entries(v)) {
    checkValue(meta, k, x);
    if (at.obj[k].default !== x) changed[k] = { from: at.obj[k].default, to: x };
    at.obj[k] = { ...at.obj[k], default: x }; // the key keeps its place, and the rest of its fields
  }
  if (scope) {
    const s = checkScope(c, b.board, { ranges: [[at.from, at.to]] }, { src: buf });
    const why = typeof b.outOfScope === 'string' ? b.outOfScope.trim() : '';
    if (!s.ok && !why) fail(403, `Refused: outside the locked part (${s.scope.label || s.scope.kind}). Ask the user, or pass outOfScope with a reason.`, { outside: s.outside, scope: s.scope });
  }
  const out = Buffer.concat([buf.subarray(0, at.from), Buffer.from(encode(at.obj, at.quote)), buf.subarray(at.to)]);
  const sha = writeBoard(c, b.board, out, scope ? b.expectSha : sha256(buf));
  return { board: b.board, sha, changed, written: 'data-props' };
}

/** Routes for api.mjs, after its token check: false for a request that is not one of them, else true and answers it.
 *  ctx: {registry, ask(cmd) → {status, body} (api.mjs's), shellAlive(canvasId), broadcast(ev)?}. */
export function mountProps(ctx) {
  const { registry } = ctx;
  const emit = ctx.broadcast || ((ev) => registry.emit('event', ev));
  const canvasOf = (ref) => registry.get(ref) || fail(404, 'unknown canvas: open it first with POST /__atelier/open {path}');

  // The board's bridge, through the shell (which adds its runner).
  async function live(c, board, args) {
    const r = await ctx.ask({ canvas: c.id, op: 'props', args: { board, ...args }, timeoutMs: 10000 });
    if (r.status === 409) fail(409, NOT_OPEN);
    if (r.status !== 200) fail(r.status === 502 ? 400 : r.status, r.body?.error || 'the shell did not answer');
    return { board, ...r.body.result, sha: sha256(readBoard(c, board)) };
  }

  async function agent(b) {
    const c = canvasOf(b.canvas), action = b.action ?? 'get';
    if (!ACTIONS.includes(action)) fail(400, `action must be one of ${ACTIONS.join(', ')}`);
    c.file(b.board);
    if (action === 'persist') return c.locked(() => persist(c, b, { scope: true }));
    if (action === 'get') return ctx.shellAlive(c.id) ? live(c, b.board, { get: true }) : fromSource(c, b.board);
    if (action === 'set' && (!b.values || typeof b.values !== 'object' || Array.isArray(b.values))) fail(400, 'set needs values, e.g. {"start": "Steg 2 · vad"}');
    const out = await live(c, b.board, action === 'set' ? { set: b.values } : { reset: true });
    emit({ type: 'props', canvas: c.id, board: b.board });
    return out;
  }
  const routes = {
    '/__agent/props': agent,
    '/__atelier/props/persist': (b) => { const c = canvasOf(b.canvas); c.file(b.board); return c.locked(() => persist(c, b, { scope: false })); },
  };

  function handle(req, res, url) {
    if (req.method !== 'POST' || !Object.hasOwn(routes, url.pathname)) return false;
    readJson(req).then(routes[url.pathname]).then((out) => sendJson(res, 200, out), (e) => {
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: String(e.message || e), ...(e.extra || {}) });
    });
    return true;
  }
  return handle;
}
