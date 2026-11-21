#!/usr/bin/env node
// atelier-register: installs or removes Atelier's agent side for Claude Code, Codex and opencode (plus a local Ollama
// agent in opencode). File edits only, never the agents' own CLIs, since those write to the real configs.
//   node atelier-register.mjs install|uninstall [--only claude,codex,opencode] [--no-ollama] [--json] [--real]
//     [--home <ATELIER_HOME>] [--claude-dir <dir>] [--codex-home <dir>] [--opencode-dir <dir>]
// Dirs come from the flags, else $ATELIER_HOME, $CLAUDE_CONFIG_DIR, $CODEX_HOME, $OPENCODE_CONFIG_DIR. A dir left unset
// means the real default (~/.config/herdr-app/data/atelier, ~/.claude + ~/.claude.json, ~/.codex, ~/.config/opencode),
// and any real path is refused before anything is written unless --real is passed.
//   Claude Code  <claude-dir>/.claude.json mcpServers.atelier (real: ~/.claude.json); <claude-dir>/settings.json
//                hooks.UserPromptSubmit and hooks.PostToolUse (matcher Write|Edit|MultiEdit) running bin/atelier-hook.mjs,
//                marked by "#atelier-hook" at the end of its command; <claude-dir>/skills/atelier/ (SKILL.md plus the
//                .atelier-owned marker).
//   Codex        <codex-home>/config.toml [mcp_servers.atelier] (text edit, every other byte kept); one marked line in
//                <codex-home>/AGENTS.md pointing to <codex-home>/skills/atelier/SKILL.md.
//   opencode     <opencode-dir>/opencode.json mcp.atelier and an instructions entry for skill/opencode.md (a short pointer:
//                atelier_view first, then the atelier skill; the whole skill there would fill a local model's window);
//                <opencode-dir>/skills/atelier/; unless --no-ollama also mcp.atelier-lite (--lite), agent.atelier-local
//                (prompt skill/atelier-local.md), permission["atelier-lite_*"] = "deny", and provider.ollama only when absent.
// Each changed file is backed up first (<file>.bak-atelier-<ms>, 0600); the first backup is pinned in
// <home>/register/state.json. Uninstall puts that backup back byte for byte when the file is still exactly what install
// wrote, else removes only Atelier's entries. Writes are atomic (temp file + rename); <home>/register/lock keeps runs apart.
// The backup, lock, atomic-write and Codex table code come from herdr-figcraft-atelier's bin/atelier-register.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'atelier-mcp.mjs'), HOOK = path.join(REPO, 'bin', 'atelier-hook.mjs');
const SKILL_SRC = path.join(REPO, 'skill', 'atelier', 'SKILL.md');
const OC_POINTER = path.join(REPO, 'skill', 'opencode.md'), LOCAL_PROMPT = path.join(REPO, 'skill', 'atelier-local.md');
const MARK = '.atelier-owned', HOOK_TAG = '#atelier-hook', AGENTS_TAG = '<!-- atelier-register -->';
const LITE = 'atelier-lite', AGENT = 'atelier-local', LITE_TOOLS = 'atelier-lite_*', MODEL = 'qwen2.5:7b';

const usage = (why) => {
  console.error(`${why ? why + '\n' : ''}usage: atelier-register.mjs install|uninstall [--only claude,codex,opencode] [--no-ollama] [--json] [--real]\n  [--home <dir>] [--claude-dir <dir>] [--codex-home <dir>] [--opencode-dir <dir>]`);
  process.exit(2);
};
let opts, positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' }, 'claude-dir': { type: 'string' }, 'codex-home': { type: 'string' }, 'opencode-dir': { type: 'string' },
      only: { type: 'string' }, 'no-ollama': { type: 'boolean' }, real: { type: 'boolean' }, json: { type: 'boolean' },
    },
  }));
} catch (e) { usage(e.message); }
const ACTION = positionals[0];
if (!['install', 'uninstall'].includes(ACTION)) usage();
const TARGETS = (opts.only ?? 'claude,codex,opencode').split(',').map((s) => s.trim()).filter(Boolean);
if (!TARGETS.length || TARGETS.some((t) => !['claude', 'codex', 'opencode'].includes(t))) usage('--only takes claude, codex and opencode');

// ---- where ----

const HOMEDIR = os.homedir();
const pick = (flag, env) => opts[flag] || process.env[env] || null;
const homeSet = pick('home', 'ATELIER_HOME');
const HOME = path.resolve(homeSet || path.join(process.env.HERDR_APP_HOME || path.join(HOMEDIR, '.config', 'herdr-app'), 'data', 'atelier'));
const claudeSet = pick('claude-dir', 'CLAUDE_CONFIG_DIR');
const CLAUDE = claudeSet ? { dir: path.resolve(claudeSet), mcpFile: path.join(path.resolve(claudeSet), '.claude.json') } : { dir: path.join(HOMEDIR, '.claude'), mcpFile: path.join(HOMEDIR, '.claude.json') };
const CODEX = path.resolve(pick('codex-home', 'CODEX_HOME') || path.join(HOMEDIR, '.codex'));
const OPENCODE = path.resolve(pick('opencode-dir', 'OPENCODE_CONFIG_DIR') || path.join(HOMEDIR, '.config', 'opencode'));

/** The realpath of p, or of its nearest existing parent with the rest appended (so links into ~/.claude count). */
function realish(p) {
  const rest = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    if (cur === path.dirname(cur)) return path.resolve(p);
    rest.push(path.basename(cur));
  }
}
const REAL = ['.claude', '.claude.json', '.codex', '.config/opencode', '.config/herdr-app', '.agents'].map((r) => realish(path.join(HOMEDIR, r)));
const isReal = (p) => { const r = realish(p); return REAL.some((x) => r === x || r.startsWith(x + path.sep)); };

// Refused before anything is created or locked.
const touched = [HOME, ...(TARGETS.includes('claude') ? [CLAUDE.dir, CLAUDE.mcpFile] : []), ...(TARGETS.includes('codex') ? [CODEX] : []), ...(TARGETS.includes('opencode') ? [OPENCODE] : [])];
const real = touched.filter(isReal);
if (real.length && !opts.real) {
  console.error(`Refusing to write to real agent configs without --real: ${[...new Set(real)].join(', ')}\nPass explicit dirs (--home, --claude-dir, --codex-home, --opencode-dir or their env vars).`);
  process.exit(2);
}

// ---- files ----

const DATA = path.join(HOME, 'register');
const STATE_FILE = path.join(DATA, 'state.json'), LOCK = path.join(DATA, 'lock');
const sha = (s) => (s === null ? null : crypto.createHash('sha256').update(s).digest('hex'));
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const log = (line) => fs.appendFileSync(path.join(DATA, 'register.log'), `${new Date().toISOString()} ${line}\n`); // paths and actions only

/** Creates dir and its missing parents, remembering the ones made so uninstall can remove them when empty. */
function mkdirs(dir, state) {
  const made = [];
  for (let cur = dir; !fs.existsSync(cur); cur = path.dirname(cur)) made.push(cur);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of made) if (!state.dirs.includes(d)) state.dirs.push(d);
}
/** Same-folder temp file and rename, keeping the file's mode (0600 for a new one). */
function writeAtomic(file, text, state) {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new */ }
  mkdirs(path.dirname(file), state);
  const tmp = `${file}.atelier-tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.bak-atelier-${Date.now()}`;
  fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(copy, 0o600);
  return copy;
}

/** Applies edit(text|null) → text|null to file. Install pins the first backup; a file changed by someone else since our
 *  last write loses its byte-for-byte restore (uninstall then removes only our entries). */
function apply(file, edit, state) {
  const cur = readText(file);
  const next = edit(cur);
  if (next === cur || next === null) return 'ready';
  const s = state.files[file];
  if (!s) state.files[file] = { existed: cur !== null, backup: backup(file), wrote: null, restore: true };
  else {
    if (sha(cur) !== s.wrote) s.restore = false;
    backup(file);
  }
  writeAtomic(file, next, state);
  state.files[file].wrote = sha(next);
  log(`${ACTION} wrote ${file}`);
  return s ? 'updated' : 'added';
}

/** Undoes apply: the pinned backup when the file is still what we wrote, else strip(text) → text without our entries
 *  (a file install created is removed once isEmpty says nothing else is in it). */
function unapply(file, strip, state, isEmpty) {
  const cur = readText(file), s = state.files[file];
  let result = 'absent';
  if (s && s.restore && cur !== null && sha(cur) === s.wrote) {
    if (s.existed) writeAtomic(file, fs.readFileSync(s.backup), state); else fs.rmSync(file);
    if (s.backup) fs.rmSync(s.backup, { force: true });
    result = 'restored';
  } else if (cur !== null) {
    const next = strip(cur);
    if (next !== cur) {
      backup(file);
      if (s && !s.existed && isEmpty(next)) fs.rmSync(file); else writeAtomic(file, next, state);
      result = 'removed';
    }
  }
  delete state.files[file];
  if (result !== 'absent') log(`uninstall ${result} ${file}`);
  return result;
}

// JSON files: the edit works on the parsed object; the file's indent is kept. Unparseable files are left alone.
const jsonEdit = (fn) => (text) => {
  let obj;
  try { obj = text === null ? {} : JSON.parse(text); } catch { throw new Error('does not parse as JSON; left alone'); }
  if (!isObject(obj)) throw new Error('is not a JSON object; left alone');
  const before = JSON.stringify(obj);
  fn(obj);
  if (JSON.stringify(obj) === before) return text;
  const indent = /^\{\r?\n([ \t]+)"/.exec(text ?? '')?.[1] ?? 2;
  return `${JSON.stringify(obj, null, indent)}\n`;
};
const setIn = (obj, key, sub, value) => { obj[key] = { ...(isObject(obj[key]) ? obj[key] : {}), [sub]: value }; };
const dropIn = (obj, key, sub) => {
  if (!isObject(obj[key]) || !(sub in obj[key])) return;
  delete obj[key][sub];
  if (!Object.keys(obj[key]).length) delete obj[key];
};

// ---- the skill ----

function installSkill(dir, state) {
  const target = path.join(dir, 'skills', 'atelier');
  if (fs.existsSync(target) && !fs.existsSync(path.join(target, MARK))) return 'not ours, left alone';
  const text = fs.readFileSync(SKILL_SRC, 'utf8');
  if (readText(path.join(target, 'SKILL.md')) === text && fs.existsSync(path.join(target, MARK))) return 'ready';
  mkdirs(target, state);
  writeAtomic(path.join(target, 'SKILL.md'), text, state);
  writeAtomic(path.join(target, MARK), `Installed by herdr-atelier's atelier-register from ${SKILL_SRC}. Uninstall removes this folder.\n`, state);
  log(`install skill ${target}`);
  return 'added';
}
function uninstallSkill(dir) {
  const target = path.join(dir, 'skills', 'atelier');
  if (!fs.existsSync(path.join(target, MARK))) return 'absent';
  fs.rmSync(target, { recursive: true, force: true });
  log(`uninstall skill ${target}`);
  return 'removed';
}

// ---- Claude Code ----

const which = (name) => (process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, name)).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });
const NODE = which('node') ?? process.execPath; // the PATH node: Homebrew's execPath points into a Cellar folder an upgrade removes
const ENV = { ATELIER_HOME: HOME };
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const HOOK_CMD = `ATELIER_HOME=${sq(HOME)} ${sq(NODE)} ${sq(HOOK)} ${HOOK_TAG}`;
const ourHook = (h) => isObject(h) && typeof h.command === 'string' && h.command.endsWith(HOOK_TAG);

// Our hook under each event it serves: UserPromptSubmit (the view context) and PostToolUse on the write tools (the scope
// warning). Their own groups and hooks stay where they are; nothing changes when ours is already there as it should be.
const HOOK_EVENTS = { UserPromptSubmit: null, PostToolUse: 'Write|Edit|MultiEdit' };
function claudeSettings(obj, on) {
  const hooks = isObject(obj.hooks) ? { ...obj.hooks } : {};
  for (const [ev, matcher] of Object.entries(HOOK_EVENTS)) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const had = groups.flatMap((g) => g?.hooks ?? []).filter(ourHook);
    if (on && had.length === 1 && had[0].command === HOOK_CMD) continue; // already ours as it should be
    if (!on && !had.length) continue;
    const list = groups.map((g) => (isObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ourHook(h)) } : g))
      .filter((g) => !isObject(g) || !Array.isArray(g.hooks) || g.hooks.length);
    if (on) list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] });
    if (list.length) hooks[ev] = list; else delete hooks[ev];
  }
  if (Object.keys(hooks).length) obj.hooks = hooks; else delete obj.hooks;
}
const MCP_ENTRY = { type: 'stdio', command: NODE, args: [MCP], env: ENV };
const emptyJson = (text) => { try { return Object.keys(JSON.parse(text)).every((k) => k === '$schema'); } catch { return false; } };
const emptyText = (text) => !text.trim();

function claude(state) {
  const rows = {};
  if (ACTION === 'install') {
    rows.mcp = apply(CLAUDE.mcpFile, jsonEdit((o) => { if (JSON.stringify(o.mcpServers?.atelier) !== JSON.stringify(MCP_ENTRY)) setIn(o, 'mcpServers', 'atelier', MCP_ENTRY); }), state);
    rows.hook = apply(path.join(CLAUDE.dir, 'settings.json'), jsonEdit((o) => claudeSettings(o, true)), state);
    rows.skill = installSkill(CLAUDE.dir, state);
  } else {
    // shortcut: .claude.json is rewritten by running Claude Code sessions; the read-modify-write window is a few ms, not locked against them.
    rows.mcp = unapply(CLAUDE.mcpFile, jsonEdit((o) => dropIn(o, 'mcpServers', 'atelier')), state, emptyJson);
    rows.hook = unapply(path.join(CLAUDE.dir, 'settings.json'), jsonEdit((o) => claudeSettings(o, false)), state, emptyJson);
    rows.skill = uninstallSkill(CLAUDE.dir);
  }
  return rows;
}

// ---- Codex ----

const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?atelier"?\s*[.\]]/; // [mcp_servers.atelier] and its subtables
/** text with [mcp_servers.atelier] (and subtables) replaced by `table` (null: removed), or `table` appended; every other
 *  byte stays. A table ends at its last key line, so comments before the next table are kept. */
function withTable(text, table) {
  const lines = text.split('\n'), out = [];
  let placed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE.test(lines[i])) { out.push(lines[i]); continue; }
    let end = i + 1, last = i + 1;
    for (; end < lines.length && !/^\s*\[/.test(lines[end]); end++) if (/^\s*[^\s#]/.test(lines[end])) last = end + 1;
    if (!placed && table) out.push(...table);
    placed = true;
    out.push(...lines.slice(last, end));
    i = end - 1;
  }
  if (placed || !table) return out.join('\n');
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${table.join('\n')}\n`; // no blank line before it: uninstall takes out exactly these lines
}
const CODEX_TABLE = ['[mcp_servers.atelier]', `command = ${JSON.stringify(NODE)}`, `args = ${JSON.stringify([MCP])}`, `env = { ATELIER_HOME = ${JSON.stringify(HOME)} }`]; // JSON strings are TOML strings
const agentsLine = (skill) => `${AGENTS_TAG} When a message names a herdr Atelier canvas, a .dc.html board or carries <atelier-view-context>, read ${skill} and follow it.`;
const withoutAgentsLine = (text) => text.split('\n').filter((l) => !l.includes(AGENTS_TAG)).join('\n');

function codex(state) {
  const toml = path.join(CODEX, 'config.toml'), agents = path.join(CODEX, 'AGENTS.md');
  const line = agentsLine(path.join(CODEX, 'skills', 'atelier', 'SKILL.md'));
  if (ACTION === 'install') {
    return {
      mcp: apply(toml, (t) => withTable(t ?? '', CODEX_TABLE), state),
      agents: apply(agents, (t) => {
        if ((t ?? '').split('\n').includes(line)) return t;
        const base = withoutAgentsLine(t ?? '');
        return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${line}\n`; // no blank line before it, as with the table
      }, state),
      skill: installSkill(CODEX, state),
    };
  }
  return {
    mcp: unapply(toml, (t) => withTable(t, null), state, emptyText),
    agents: unapply(agents, withoutAgentsLine, state, emptyText),
    skill: uninstallSkill(CODEX),
  };
}

// ---- opencode and Ollama ----

const local = (extra) => ({ type: 'local', command: [NODE, MCP, ...extra], enabled: true, environment: ENV });
const AGENT_SPEC = {
  description: 'Answers comments on the design canvas open in Atelier with a local Ollama model, through Atelier\'s small tool set.',
  mode: 'primary', model: `ollama/${MODEL}`, prompt: `{file:${LOCAL_PROMPT}}`, // in place of opencode's long default prompt
  permission: { '*': 'deny', [LITE_TOOLS]: 'allow' }, // this agent only: a 7B model picks right among a few tools
};
const PROVIDER = {
  npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://localhost:11434/v1' },
  models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } },
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function opencode(state) {
  const file = path.join(OPENCODE, 'opencode.json'), oldSkill = path.join(OPENCODE, 'skills', 'atelier', 'SKILL.md');
  const ollama = !opts['no-ollama'];
  if (ACTION === 'install') {
    const cfg = apply(file, jsonEdit((o) => {
      if (Object.keys(o).length === 0) o.$schema = 'https://opencode.ai/config.json';
      if (!same(o.mcp?.atelier, local([]))) setIn(o, 'mcp', 'atelier', local([]));
      const ins = (Array.isArray(o.instructions) ? o.instructions : []).filter((x) => x !== oldSkill); // earlier installs put the whole skill here
      o.instructions = ins.includes(OC_POINTER) ? ins : [...ins, OC_POINTER]; // jsonEdit writes only when this changed anything
      if (!ollama) return;
      if (!same(o.mcp?.[LITE], local(['--lite']))) setIn(o, 'mcp', LITE, local(['--lite']));
      if (!same(o.agent?.[AGENT], AGENT_SPEC)) setIn(o, 'agent', AGENT, AGENT_SPEC);
      if ((o.permission === undefined || isObject(o.permission)) && o.permission?.[LITE_TOOLS] !== 'deny') setIn(o, 'permission', LITE_TOOLS, 'deny');
      if (!o.provider?.ollama) { setIn(o, 'provider', 'ollama', PROVIDER); state.providerAdded = true; } // never overwritten
    }), state);
    return { config: cfg, skill: installSkill(OPENCODE, state) };
  }
  const providerOurs = Boolean(state.providerAdded);
  const cfg = unapply(file, jsonEdit((o) => {
    dropIn(o, 'mcp', 'atelier'); dropIn(o, 'mcp', LITE); dropIn(o, 'agent', AGENT); dropIn(o, 'permission', LITE_TOOLS);
    if (providerOurs) dropIn(o, 'provider', 'ollama');
    if (Array.isArray(o.instructions)) { o.instructions = o.instructions.filter((x) => x !== OC_POINTER && x !== oldSkill); if (!o.instructions.length) delete o.instructions; } // oldSkill: a pre-pointer install's
  }), state, emptyJson);
  delete state.providerAdded;
  return { config: cfg, skill: uninstallSkill(OPENCODE) };
}

// ---- run ----

/** O_EXCL lock; one older than 5 min is a crashed run's and is taken over. */
function lock() {
  for (let i = 0; i < 2; i++) {
    try { fs.closeSync(fs.openSync(LOCK, 'wx')); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs < 300000) return false; fs.rmSync(LOCK, { force: true }); } catch { /* gone */ }
  }
  return false;
}

fs.mkdirSync(DATA, { recursive: true });
if (!lock()) { console.error('Another atelier-register run holds the lock.'); process.exit(1); }
let code = 0;
const result = {};
try {
  let state = { files: {}, dirs: [] };
  try { state = { files: {}, dirs: [], ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
  const run = { claude, codex, opencode };
  for (const t of TARGETS) {
    try { result[t] = run[t](state); } catch (e) { result[t] = { failed: e.message }; code = 1; log(`${ACTION} ${t} failed: ${e.message}`); }
  }
  if (ACTION === 'uninstall') { // folders install made, deepest first, when nothing else is in them
    state.dirs = state.dirs.sort((a, b) => b.length - a.length).filter((d) => { try { fs.rmdirSync(d); return false; } catch (e) { return e.code !== 'ENOENT'; } });
  }
  writeAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { dirs: [] });
} finally { fs.rmSync(LOCK, { force: true }); }
console.log(opts.json ? JSON.stringify(result) : Object.entries(result).map(([t, r]) => `${t}: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ')}`).join('\n'));
process.exit(code);
