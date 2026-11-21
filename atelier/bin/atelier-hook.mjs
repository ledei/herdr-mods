#!/usr/bin/env node
// atelier-hook: Claude Code hook, by hook_event_name on stdin.
// PostToolUse (Write, Edit, MultiEdit): when the tool wrote a board of the canvas open in Atelier outside the scope the
// user locked, prints {hookSpecificOutput: {additionalContext}} with an <atelier-scope-warning> block: what changed outside
// it and the atelier_version restore call that puts the version from before back. Nothing otherwise (Atelier closed,
// panel closed, no scope locked, inside the scope), and nothing after 1.5 s.
// UserPromptSubmit: reads {prompt, cwd, session_id, …} on stdin and prints
// <atelier-view-context canvas="…">{json}</atelier-view-context> (what the user sees in Atelier, ≤2 KB) for Claude to read
// with the prompt. Prints nothing and exits 0 when: atelierd has no port file, its ping takes over 150 ms, the whole run
// takes over 200 ms, the panel (shell) is closed, or this session is not the target. The target is a session whose cwd is
// inside the open canvas folder or one of its .atelier/meta.json sourceRepos, or the session picked in the strip
// (view-state targetSession equal to this terminal's HC_TERMINAL_ID).
// New comment ids since this session's last prompt are remembered in $ATELIER_HOME/run/hook-<session>.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const T0 = Date.now(), PING_MS = 150, CAP = 2048;
let BUDGET = 200; // the prompt's; PostToolUse gets POST_BUDGET
const POST_BUDGET = 1500;
let timer = setTimeout(() => process.exit(0), BUDGET); // over budget: say nothing rather than hold up the prompt
const HOME = process.env.ATELIER_HOME || path.join(process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app'), 'data', 'atelier');
const quiet = () => process.exit(0);

const NAME = String.raw`(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2}){1,200}\.dc\.html`;
const FILE_RE = new RegExp(`^${NAME}$`);
const ID_RE = new RegExp(`^${NAME}#\\d{1,4}(?::\\d{1,2}(?:/\\d{1,2}){0,8})?(?:@\\d{1,3})?$`);
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const COMMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Screen- and board-written text: no controls, no < or >, one line, ≤max characters. */
const clean = (v, max = 60) => {
  if (typeof v !== 'string') return undefined;
  const t = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > max ? t.slice(0, max - 1).join('') + '…' : t.join('') || undefined;
};
const files = (v, n) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && FILE_RE.test(f)).slice(0, n) : []);
const ids = (v, n) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string' && ID_RE.test(f)).slice(-n) : []);
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (p, dir) => Boolean(p && dir) && (p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/'));

function get(pf, p, ms, body) {
  const u = new URL(pf.ui);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((ok) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: data ? 'POST' : 'GET', timeout: ms,
      headers: { authorization: `Bearer ${pf.token}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { ok(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks)) : null); } catch { ok(null); } });
    });
    req.on('timeout', () => { req.destroy(); ok(null); });
    req.on('error', () => ok(null));
    req.end(data);
  });
}
const left = () => BUDGET - 25 - (Date.now() - T0);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function isTarget(input, view, canvasDir) {
  // The strip's pick: view-state targetSession is the picked agent's herdr address ("t3", "machine/t3"), and herdr gives
  // every terminal its own as HC_TERMINAL_ID, which Claude Code passes on to this hook. (A targetSession equal to
  // Claude's own session_id counts too, as before T12.)
  const me = process.env.HC_TERMINAL_ID;
  if (typeof view.targetSession === 'string' && view.targetSession && (view.targetSession === me || view.targetSession === input.session_id)) return true;
  const cwd = real(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (inside(cwd, canvasDir)) return true;
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(canvasDir, '.atelier', 'meta.json'), 'utf8')); } catch { /* none */ }
  // meta.json is canvas content: a repo counts only when it is a git checkout below the home folder, never / or home itself.
  const home = real(os.homedir());
  const ok = (r) => typeof r === 'string' && path.isAbsolute(r) && fs.existsSync(path.join(r, '.git')) && real(r) !== home && inside(real(r), home);
  return (Array.isArray(meta.sourceRepos) ? meta.sourceRepos : []).some((r) => ok(r) && inside(cwd, real(r)));
}

/** The context object from whitelisted fields only, named as in view-state.md ("The prompt block"). */
function context(view, canvasDir, located, comments, seen) {
  const scope = view.scope && typeof view.scope === 'object' && typeof view.scope.kind === 'string'
    ? { kind: clean(view.scope.kind, 20), ids: ids(view.scope.ids, 5), ...(Array.isArray(view.scope.rect) ? { rect: view.scope.rect.slice(0, 4).map(Number).filter(Number.isFinite) } : {}) } : null;
  const labels = new Map((Array.isArray(view.selection) ? view.selection : []).filter((s) => s && ID_RE.test(s.id ?? '')).map((s) => [s.id, s]));
  const selected = ids(view.selected, 5).map((id) => {
    const at = located.get(id), s = labels.get(id);
    return { id, file: id.slice(0, id.indexOf('#')), ...(at ? { line: at.line, tag: clean(at.tag, 20), snippet: clean(at.snippet, 60) } : {}), ...(s ? { kind: clean(s.kind, 10), label: clean(s.label, 60) } : {}) };
  });
  const open = comments.filter((k) => k && COMMENT_ID_RE.test(k.id) && k.status !== 'resolved');
  const fresh = open.filter((k) => !seen.has(k.id)).map((k) => ({ id: k.id, ...(ID_RE.test(k.anchor?.id ?? '') ? { anchor: k.anchor.id } : {}), text: clean(k.text, 60) }));
  const errored = files(view.erroredArtboards, 10);
  return {
    path: clean(canvasDir, 1000) === canvasDir ? canvasDir : undefined, // a folder name with controls or <> is left out
    mode: clean(view.mode, 12), page: clean(view.page, 40), dirty: view.dirty === true || undefined,
    selected, selectedArtboards: files(view.selectedArtboards, 20), scope,
    erroredArtboards: errored.length ? errored : undefined, firstError: errored.length ? clean(view.firstError, 60) : undefined,
    openComments: Number.isInteger(view.openComments) ? view.openComments : open.length, newComments: fresh,
    visibleArtboards: files(view.visibleArtboards, 20),
  };
}

// Lowest value first: what the agent can still get from atelier_view.
const SHRINK = [
  (c) => { c.visibleArtboards = c.visibleArtboards.slice(0, 3); },
  (c) => { delete c.visibleArtboards; },
  (c) => { c.selected.forEach((s) => delete s.snippet); },
  (c) => { c.newComments.forEach((k) => delete k.text); },
  (c) => { c.selectedArtboards = c.selectedArtboards.slice(0, 3); },
  (c) => { if (c.erroredArtboards) c.erroredArtboards = c.erroredArtboards.slice(0, 1); },
  (c) => { c.selected.forEach((s) => delete s.label); },
  (c) => { c.newComments = c.newComments.slice(0, 5); },
  (c) => { c.selected = c.selected.slice(-2); if (c.scope) c.scope.ids = c.scope.ids.slice(0, 2); },
  (c) => { c.newComments = []; c.selectedArtboards = c.selectedArtboards.slice(0, 1); delete c.erroredArtboards; delete c.firstError; },
  (c) => { c.selected = c.selected.slice(-1); c.scope = c.scope && { kind: c.scope.kind }; },
  (c) => { delete c.path; },
];
function render(name, ctx) {
  const wrap = (c) => `<atelier-view-context canvas="${name}">${JSON.stringify(c).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</atelier-view-context>\n`;
  let out = wrap(ctx);
  for (const step of SHRINK) {
    if (Buffer.byteLength(out) <= CAP) return { out, ctx };
    step(ctx);
    out = wrap(ctx);
  }
  return Buffer.byteLength(out) <= CAP ? { out, ctx } : null;
}

const canvasName = (dir) => {
  let title; try { title = JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8')).title; } catch { /* none */ }
  return (clean(title, 60) || clean(path.basename(dir), 60) || 'canvas').replace(/["&]/g, "'");
};

// ---------- PostToolUse: a board written outside the locked scope ----------
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-\d+)?$/;
async function postTool(input, pf) {
  const file = input.tool_input?.file_path;
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.dc.html')) quiet();
  const r = await get(pf, '/__agent/scope/written', left(), { path: file });
  if (!r?.locked || r.ok !== false || r.shellAlive === false || !FILE_RE.test(r.file ?? '')) quiet();
  const where = (Array.isArray(r.outside) ? r.outside : []).slice(0, 3).map((o) => {
    const [a, b] = Array.isArray(o?.lines) ? o.lines.map(Number) : [];
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    return `line${a === b ? ` ${a}` : `s ${a}-${b}`}${ID_RE.test(o.near ?? '') ? ` (in ${o.near}${clean(o.tag, 20) ? `, ${clean(o.tag, 20)}` : ''})` : ''}`;
  }).filter(Boolean);
  const scope = r.scope && typeof r.scope === 'object' ? r.scope : {};
  const scoped = [clean(scope.kind, 10), clean(scope.label, 60) || ids(scope.ids, 1)[0] || files(scope.ids, 1)[0]].filter(Boolean).join(': ');
  const undo = TS_RE.test(r.before ?? '') && /^[0-9a-f]{64}$/.test(r.sha ?? '')
    ? `If the user did not ask for this change, put the file back with atelier_version action "restore", file "${r.file}", ts "${r.before}", expectSha "${r.sha}" (the version from just before this write; the current one stays as a version), then tell the user.`
    : 'No version from before this write is kept: if the user did not ask for this change, undo it by hand and tell the user.';
  const text = [
    `<atelier-scope-warning canvas="${canvasName(path.dirname(file))}">`,
    `This ${input.tool_name} changed ${r.file} outside the scope the user locked in Atelier${scoped ? ` (${scoped})` : ''}${where.length ? `: ${where.join('; ')}` : ''}.`,
    'The scope is a hard limit: change only inside it.',
    undo,
    '</atelier-scope-warning>',
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }) + '\n', () => process.exit(0));
}

async function main() {
  const input = await readStdin();
  if (!input || typeof input !== 'object') quiet();
  const post = input.hook_event_name === 'PostToolUse';
  if (post) { BUDGET = POST_BUDGET; clearTimeout(timer); timer = setTimeout(() => process.exit(0), BUDGET - (Date.now() - T0)); }
  let pf; try { pf = JSON.parse(fs.readFileSync(path.join(HOME, 'run', 'atelierd.json'), 'utf8')); } catch { quiet(); }
  if (typeof pf?.ui !== 'string' || typeof pf.token !== 'string') quiet();
  if (!(await get(pf, '/__atelier/ping', Math.min(PING_MS, left())))?.ok) quiet();
  if (post) return postTool(input, pf);
  const view = await get(pf, '/__agent/view', left());
  if (!view || view.shellAlive !== true || typeof view.canvas?.id !== 'string') quiet();
  const canvasDir = real(view.canvas.path);
  if (!canvasDir || !isTarget(input, view, canvasDir)) quiet();

  const q = (o) => new URLSearchParams(o).toString();
  const want = ids(view.selected, 5);
  const [cm, ...at] = await Promise.all([
    get(pf, `/__agent/comments?${q({ canvas: view.canvas.id })}`, left()),
    ...want.map((id) => get(pf, `/__agent/resolve?${q({ canvas: view.canvas.id, id })}`, left())),
  ]);
  const located = new Map(want.map((id, i) => [id, at[i]]).filter(([, r]) => r && Number.isInteger(r.line)));
  const comments = Array.isArray(cm?.comments) ? cm.comments : [];
  const sf = SESSION_RE.test(input.session_id ?? '') ? path.join(HOME, 'run', `hook-${input.session_id}.json`) : null;
  let seen = new Set();
  try { const s = JSON.parse(fs.readFileSync(sf, 'utf8')).seen; if (Array.isArray(s)) seen = new Set(s); } catch { /* first prompt, or no session id */ }

  const r = render(canvasName(canvasDir), context(view, canvasDir, located, comments, seen));
  if (!r) quiet();
  process.stdout.write(r.out, () => {
    // Only what was printed counts as seen; ids cut by the cap come again next prompt.
    if (sf) {
      const all = new Set(comments.map((k) => k?.id));
      const next = [...seen, ...r.ctx.newComments.map((k) => k.id)].filter((id) => all.has(id));
      try {
        const tmp = `${sf}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ seen: next }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, sf);
      } catch { /* the next prompt reports them again */ }
    }
    process.exit(0);
  });
}
main().catch(quiet);
