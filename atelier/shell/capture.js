// Context to chat (T12, V2Send): Screenshot (S) snapshots the selected board, Mark up (M) a region dragged on a board;
// either opens the markup editor (pen, arrow, label; undo; Esc cancels), whose Save keeps the marked PNG with the
// element ids under the marks (server/markup.mjs). Record (⇧R) films the board for 5 s (server/record.mjs). Each
// result is a chip in the tray; the tray's Send gives the agent picked in herdr's strip one message: the text, then
// the attachments' paths and anchors (the mod builds it: mods/atelier/agent.js compose). The mod owns the list the
// message takes: every change of the tray is posted to it ({type:"attach", items}).
// The mod tells this page the picked agent (window.__atelierAgent({name, session})); target().session is view-state
// targetSession. frames(ev) answers atelierd's "frames" op: native snapshots of a board's rect every ~200 ms, while the
// user plays it, for a live recording.
import { boardAt, dragRect, own } from './scope.js';

const RUNNER = window.webkit?.messageHandlers?.atelierShell ? 'live-webkit' : 'live-chrome';
const native = () => !!window.webkit?.messageHandlers?.atelierShell;
const SVG = (d, extra = '') => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
const I = {
  pen: SVG('<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>'),
  arrow: SVG('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>'),
  label: SVG('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'),
  undo: SVG('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  shot: SVG('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>'),
  rec: SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  target: SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  send: SVG('<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'),
};
const MARK = '#f07a5a', MARK_INK = '#2a0e06'; // the design's markup colour (--err)
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const button = (cls, html, label, onclick) => { const b = el('button', cls, html); b.type = 'button'; if (label) { b.setAttribute('aria-label', label); b.title = label; } b.onclick = onclick; return b; };
const stem = (f) => f.replace(/\.dc\.html$/, '');
const tidOf = (id) => /#(\d+)/.exec(id)?.[1];
const MAX_ATTACH = 8; // the mod's cap (mods/atelier/agent.js): it refuses a Send with more

/** ctx: {api, boards, camera, layer, canvas (id), selection() → {board, …} | null, post(msg) to the mod, onChange()
 *  (view-state: targetSession)}. */
export function init({ api, boards, camera, layer, canvas, selection, post, onChange = () => {} }) {
  let agent = null; // {name, session} from the mod
  let items = []; // the tray: {kind, name, board, files, anchors, seconds?, frames?, preview?, timeline?}
  const n = { shot: 0, rec: 0 }; // chip names: shot-1.png, rec-1
  let editor = null, picking = false, recording = null;
  const tb = document.getElementById('toolbar');
  const tool = (label) => tb?.querySelector(`.tool[aria-label="${label}"]`);
  const [markBtn, shotBtn, recBtn] = ['Mark up (M)', 'Screenshot (S)', 'Record (⇧R)'].map(tool);
  for (const [b, title, fn] of [[markBtn, 'Mark up (M): drag over a board', () => pickRegion()], [shotBtn, 'Screenshot (S): the selected board, to mark up', () => screenshot()], [recBtn, 'Record (⇧R): 5 s of the selected board', () => record()]]) {
    if (!b) continue;
    b.disabled = false; b.title = title; b.onclick = fn;
  }
  const boardNow = () => { const s = selection?.(); return (s?.board && boards.get(s.board)) || boards.visible()[0] || null; };

  // ---------- tray ----------
  const tray = own(el('section', 'cap-tray'));
  tray.setAttribute('role', 'region'); tray.setAttribute('aria-label', 'Attachments'); tray.hidden = true;
  const recView = el('div', 'cap-rec'), chips = el('div', 'cap-chips'), note = el('div', 'cap-note dim small');
  // In Play the tray folds to one row (it covered the bottom of the played board): this button and Send; it opens it again.
  let playing = false, folded = false;
  const fold = button('cap-fold ghost', '', null, () => { folded = !folded; drawTray(); });
  const field = el('label', 'cap-field', '<span class="sr">Message</span>'), input = el('input');
  input.placeholder = 'Message'; field.append(input);
  const sendBtn = button('prim', I.send + '<span>Send</span>', null, () => send());
  const acts = el('div', 'cap-acts');
  acts.append(button('ghost', 'Clear', null, () => setItems([])), sendBtn);
  tray.append(fold, recView, chips, field, acts, note);
  document.body.append(tray);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } });

  // What the mod gets: only what a message names (no pixels).
  const posted = (a) => ({ kind: a.kind, board: a.board, files: a.files, anchors: a.anchors.map(({ id, label }) => ({ id, label })), ...(a.kind === 'rec' ? { seconds: a.seconds, frames: a.frames } : {}) });
  function setItems(next) {
    items = next;
    post({ type: 'attach', items: items.map(posted) });
    drawTray();
  }
  function drawTray() {
    tray.hidden = !items.length;
    tray.classList.toggle('playing', playing);
    tray.classList.toggle('folded', playing && folded);
    fold.textContent = folded ? `${items.length} attached · Show` : 'Fold';
    chips.replaceChildren();
    for (const a of items) {
      const c = el('span', 'cap-chip', a.kind === 'shot' ? I.shot : I.rec);
      c.append(a.kind === 'shot' ? a.name : `${a.name} · ${a.seconds} s`);
      c.append(button('cap-x', I.x, `Remove ${a.name}`, () => setItems(items.filter((x) => x !== a))));
      chips.append(c);
    }
    const seen = new Set();
    for (const x of items.flatMap((a) => a.anchors)) {
      if (seen.has(x.id) || seen.size >= 6) continue;
      seen.add(x.id);
      const c = el('span', 'cap-chip cap-anchor', I.target);
      c.append(`#${tidOf(x.id)} ${x.label || x.tag || ''}`.trim());
      c.title = x.id;
      chips.append(c);
    }
    const rec = items.findLast((a) => a.kind === 'rec');
    recView.replaceChildren();
    recView.hidden = !rec;
    if (rec) {
      const img = el('img'); img.alt = `${rec.name}: ${rec.frames} frames`; img.src = `data:image/png;base64,${rec.preview}`;
      const line = el('div', 'dim small');
      // Taps first, then changes and errors, then animations (not their starts) fill what is left of 6, in time order.
      const tl = (rec.timeline || []).filter((e) => e.type !== 'animation' || e.phase !== 'start');
      const rank = (e) => (e.type === 'animation' ? 2 : e.type === 'state' || e.type === 'error' ? 1 : 0);
      line.textContent = tl.sort((x, y) => rank(x) - rank(y)).slice(0, 6).sort((x, y) => x.t - y.t).map(say).join(' · ') || 'No clicks or changes in it.';
      const title = el('div', 'cap-title'); title.textContent = `Recording · ${rec.seconds} s`;
      recView.append(title, img, line);
    }
    sendBtn.querySelector('span').textContent = agent ? `Send to ${agent.name}` : 'No agent picked';
    sendBtn.disabled = !agent;
  }
  const say = (e) => `${(e.t / 1000).toFixed(1)} s ${e.type === 'click' ? `tap ${e.text60 || e.tag || ''}` : e.type === 'state' ? `${e.keys.join(', ')} changed` : e.type === 'animation' ? `${e.name} ${e.phase === 'end' ? 'done' : e.phase}` : e.type === 'error' ? 'error' : e.type}`.trim();
  function send() {
    if (!items.length && !input.value.trim()) return;
    if (!agent) { note.textContent = 'Pick an agent in the strip above first.'; return; }
    note.textContent = 'Sending…';
    post({ type: 'send', text: input.value });
  }
  window.__atelierSent = (out) => {
    if (out === 'sent' || out === 'queued') {
      input.value = ''; items = []; drawTray(); // the mod emptied its list itself
      note.textContent = out === 'sent' ? '' : 'Queued: the agent is busy';
    } else note.textContent = String(out?.error || 'Not sent');
    return true;
  };
  window.__atelierAgent = (a) => {
    agent = a && typeof a.name === 'string' && typeof a.session === 'string' ? { name: a.name.slice(0, 60), session: a.session.slice(0, 100) } : null;
    drawTray(); onChange();
    return true;
  };

  // ---------- snapshot → editor ----------
  // A full tray: nothing new starts (a finished markup is never thrown away), and the toast says why.
  const full = () => { if (items.length < MAX_ATTACH) return false; flash(`The tray holds ${MAX_ATTACH} attachments: send or remove one first`); return true; };
  function pickRegion() {
    if (picking) return stopPicking();
    if (full()) return;
    picking = true;
    document.body.classList.add('capturing');
    markBtn?.setAttribute('aria-pressed', 'true');
  }
  function stopPicking() { picking = false; document.body.classList.remove('capturing'); markBtn?.setAttribute('aria-pressed', 'false'); }
  document.getElementById('view')?.addEventListener('pointerdown', (e) => {
    if (!picking || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const hit = boardAt(e, boards, camera);
    if (!hit) return stopPicking();
    dragRect(e, hit, { layer, camera }, (r) => { stopPicking(); snap(r.b, r.rect ? { x: r.rect[0], y: r.rect[1], w: r.rect[2], h: r.rect[3] } : undefined); });
  }, true);
  function screenshot() { if (full()) return; const b = boardNow(); if (b) snap(b); else flash('Select a board first'); }
  async function snap(b, region) {
    tray.style.visibility = 'hidden'; // never in the picture
    try {
      const r = await api.json('POST', '/__atelier/markup/snap', { canvas, board: b.file, ...(region ? { region } : {}), ...(native() ? {} : { runner: 'headless' }) });
      openEditor(b, r);
    } catch (e) { flash(`No snapshot: ${e.message}`); } finally { tray.style.visibility = ''; }
  }

  function openEditor(b, shot) {
    const marks = []; // {kind, pts: [[x,y]] in image px, text?}
    let kind = 'pen', live = null;
    const root = own(el('div', 'cap-edit')), stage = el('div', 'cap-stage'), img = new Image(), cv = el('canvas');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', `Mark up ${stem(b.file)}`);
    img.src = `data:image/png;base64,${shot.png}`;
    cv.width = shot.w; cv.height = shot.h;
    stage.append(cv);
    const bar = el('div', 'cap-bar'), kinds = {};
    for (const [k, label] of [['pen', 'Pen (P)'], ['arrow', 'Arrow (A)'], ['label', 'Label (T)']]) {
      kinds[k] = button('tool', I[k], label, () => setKind(k));
      bar.append(kinds[k]);
    }
    bar.append(el('div', 'sep'), button('tool', I.undo, 'Undo (⌘Z)', () => { marks.pop(); paint(); }), el('div', 'sep'),
      button('ghost', 'Cancel', 'Cancel (Esc)', () => close()), button('prim', 'Save', null, () => save()));
    const head = el('div', 'cap-head'), name = el('b'), sub = el('span', 'dim');
    name.textContent = stem(b.file);
    sub.textContent = shot.runner === 'headless-chrome' ? 'From a fresh load: the board\'s start, not where you clicked to' : 'As on screen';
    head.append(name, sub);
    root.append(head, stage, bar);
    document.body.append(root);
    const setKind = (k) => { kind = k; for (const [x, n] of Object.entries(kinds)) n.setAttribute('aria-pressed', String(x === k)); };
    setKind('pen');
    const k = () => cv.width / cv.getBoundingClientRect().width; // image px per screen px
    const at = (e) => { const r = cv.getBoundingClientRect(), s = k(); return [Math.round((e.clientX - r.left) * s), Math.round((e.clientY - r.top) * s)]; };
    function paint(ctx = cv.getContext('2d')) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (img.naturalWidth) ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const u = Math.max(1, shot.scale || 1); // marks keep their on-board size at any snapshot scale
      for (const m of live ? [...marks, live] : marks) {
        ctx.strokeStyle = ctx.fillStyle = MARK; ctx.lineWidth = 2.5 * u; ctx.lineCap = ctx.lineJoin = 'round';
        if (m.kind === 'label') {
          ctx.font = `600 ${11 * u}px Inter, -apple-system, system-ui, sans-serif`;
          const [x, y] = m.pts[0], w = ctx.measureText(m.text).width + 14 * u, h = 20 * u;
          ctx.beginPath(); ctx.roundRect(x, y, w, h, 5 * u); ctx.fill();
          ctx.fillStyle = MARK_INK; ctx.textBaseline = 'middle'; ctx.fillText(m.text, x + 7 * u, y + h / 2);
          continue;
        }
        ctx.beginPath();
        m.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        if (m.kind === 'arrow' && m.pts.length === 2) {
          const [[x0, y0], [x1, y1]] = m.pts, a = Math.atan2(y1 - y0, x1 - x0), L = 12 * u;
          ctx.beginPath(); ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - L * Math.cos(a - 0.45), y1 - L * Math.sin(a - 0.45)); ctx.lineTo(x1 - L * Math.cos(a + 0.45), y1 - L * Math.sin(a + 0.45));
          ctx.closePath(); ctx.fill();
        }
      }
    }
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = at(e);
      if (kind === 'label') return labelAt(p, e);
      cv.setPointerCapture(e.pointerId);
      live = { kind, pts: kind === 'arrow' ? [p, p] : [p] };
    });
    const extend = (e) => {
      if (!live) return;
      const p = at(e);
      if (live.kind === 'arrow') live.pts[1] = p; else live.pts.push(p);
      paint();
    };
    cv.addEventListener('pointermove', extend);
    const end = (e) => {
      if (!live) return;
      if (e.type === 'pointerup') extend(e); // the release point is the arrow's tip, even with no move just before it
      const [a, z] = [live.pts[0], live.pts.at(-1)];
      if (live.pts.length > 1 && Math.hypot(z[0] - a[0], z[1] - a[1]) + live.pts.length > 4) marks.push(live);
      live = null; paint();
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    function labelAt(p, e) {
      stage.querySelector('.cap-label')?.remove();
      const f = el('input', 'cap-label'), r = stage.getBoundingClientRect();
      f.placeholder = 'Label'; f.maxLength = 120;
      f.style.left = `${e.clientX - r.left}px`; f.style.top = `${e.clientY - r.top}px`;
      stage.append(f); setTimeout(() => f.focus());
      const done = (keep) => { const t = f.value.trim(); f.remove(); if (keep && t) { marks.push({ kind: 'label', pts: [p], text: t }); paint(); } };
      f.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      f.addEventListener('blur', () => done(true));
    }
    const keys = (e) => {
      if (e.target.closest?.('input, textarea')) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') close();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); marks.pop(); paint(); }
      else if (!e.metaKey && !e.ctrlKey && { p: 'pen', a: 'arrow', t: 'label' }[e.key]) setKind({ p: 'pen', a: 'arrow', t: 'label' }[e.key]);
    };
    addEventListener('keydown', keys, true);
    function close() { removeEventListener('keydown', keys, true); root.remove(); editor = null; }
    async function save() {
      const out = el('canvas'); out.width = cv.width; out.height = cv.height;
      paint(out.getContext('2d'));
      const png = out.toDataURL('image/png').split(',')[1];
      const [rx, ry] = shot.region, s = shot.scale || 1; // image px → board px
      const board = marks.map((m) => ({ kind: m.kind, pts: m.pts.map(([x, y]) => [Math.round((rx + x / s) * 10) / 10, Math.round((ry + y / s) * 10) / 10]), ...(m.text ? { text: m.text } : {}) }));
      try {
        // The snap's runner and state: the marks are hit-tested where the picture came from (server/markup.mjs).
        const r = await api.json('POST', '/__atelier/markup/save', { canvas, board: b.file, png, marks: board, runner: shot.runner, state: shot.state });
        close();
        n.shot++;
        setItems([...items, { kind: 'shot', name: `shot-${n.shot}.png`, board: b.file, files: [{ role: 'png', path: r.path }], anchors: r.anchors || [] }]);
        if (r.stale) flash(r.stale);
      } catch (e) { sub.textContent = `Not saved: ${e.message}`; }
    }
    img.onload = () => paint();
    editor = { close };
  }

  // ---------- record ----------
  async function record(seconds = 5) {
    if (recording || full()) return;
    const b = boardNow();
    if (!b) return flash('Select a board first');
    recording = b.file;
    recBtn?.setAttribute('aria-pressed', 'true');
    recBtn?.classList.add('recording');
    const t0 = Date.now(), tick = setInterval(() => { if (recBtn) recBtn.title = `Recording ${stem(b.file)} · ${Math.max(0, seconds - Math.floor((Date.now() - t0) / 1000))} s`; }, 250);
    try {
      const r = await api.json('POST', '/__atelier/record', { canvas, board: b.file, seconds, ...(native() ? {} : { runner: 'headless' }) });
      n.rec++;
      setItems([...items, { kind: 'rec', name: `rec-${n.rec}`, board: b.file, seconds: r.seconds, frames: r.frames, preview: r.preview, timeline: r.timeline,
        files: [{ role: 'filmstrip', path: r.filmstrip }, { role: 'events', path: r.events }, ...(r.video ? [{ role: 'video', path: r.video }] : [])], anchors: r.anchors || [] }]);
      if (native() && r.notLive) flash(`Filmed from a fresh load, not what you did: ${r.notLive}`);
    } catch (e) { flash(`Not recorded: ${e.message}`); } finally {
      clearInterval(tick); recording = null;
      recBtn?.setAttribute('aria-pressed', 'false'); recBtn?.classList.remove('recording');
      if (recBtn) recBtn.title = 'Record (⇧R): 5 s of the selected board';
    }
  }

  // atelierd's live recording: native snapshots of the board's rect every ~200 ms for ms, each into the helper's
  // folder by ref (as main.js's live shot does); the answers come back through window.__atelierShot.
  const waiting = new Map();
  const prior = window.__atelierShot;
  window.__atelierShot = (ref, r) => { const done = waiting.get(ref); if (done) { waiting.delete(ref); done(r); return true; } return prior ? prior(ref, r) : false; };
  async function frames(ev) {
    const { board, ms: ms0, every: ev0, check } = ev.args && typeof ev.args === 'object' ? ev.args : {};
    let out;
    try {
      const b = typeof board === 'string' ? boards.get(board) : null;
      if (!b) throw new Error(board ? `no board ${board} on this canvas` : 'args.board is required');
      if (!native()) throw new Error('live frames need the native view in herdr');
      if (!b.el?.isConnected || b.el.classList.contains('off')) throw new Error('the board is not on the page shown in Atelier (removed or archived?)');
      const ms = Math.min(Math.max(Number(ms0) || 5000, 1000), 10000), every = Math.min(Math.max(Number(ev0) || 200, 100), 1000);
      const r = b.el.getBoundingClientRect(), s = r.width / b.w;
      const x = Math.ceil(r.left), y = Math.ceil(r.top), rect = { x, y, w: Math.floor(r.left + b.w * s) - x, h: Math.floor(r.top + b.h * s) - y };
      if (rect.w < 1 || rect.h < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > innerWidth || rect.y + rect.h > innerHeight) throw new Error('the board is not fully on screen in Atelier');
      if (check === true) out = { id: ev.id, result: { ok: true, runner: RUNNER } }; // atelierd asks before any step runs: no filming
      else out = { id: ev.id, result: await film(rect, ms, every, s) };
    } catch (e) { out = { id: ev.id, error: String(e.message || e) }; }
    api.json('POST', '/__agent/result', out).catch(() => {});
  }
  async function film(rect, ms, every, s) {
    tray.style.visibility = 'hidden';
    try {
      const got = [], t0 = Date.now();
      for (let i = 0; t0 + i * every < t0 + ms; i++) {
        const wait = t0 + i * every - Date.now();
        if (wait > 0) await new Promise((r2) => setTimeout(r2, wait)); else if (wait < -every) continue;
        const ref = crypto.randomUUID(), t = Date.now();
        got.push(new Promise((ok) => {
          const timer = setTimeout(() => { waiting.delete(ref); ok(null); }, 5000);
          waiting.set(ref, (res) => { clearTimeout(timer); ok(res?.error ? null : { ref, t }); });
          post({ type: 'snapshot', ref, rect });
        }));
      }
      return { frames: (await Promise.all(got)).filter(Boolean), scale: Math.round(s * 1000) / 1000, runner: RUNNER };
    } finally { tray.style.visibility = ''; }
  }

  // ---------- keys, notes ----------
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || editor) return;
    if (e.key === 'Escape' && picking) { e.stopImmediatePropagation(); stopPicking(); }
    else if (e.key === 'm' || e.key === 'M') pickRegion();
    else if (e.key === 's' || e.key === 'S') screenshot();
    else if (e.key === 'R' && e.shiftKey) record();
  }, true);
  let flashTimer = 0;
  function flash(text) {
    let t = document.querySelector('.cap-toast');
    if (!t) { t = el('div', 'cap-toast'); t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = text; t.hidden = false;
    t.style.bottom = tray.hidden ? '' : `${innerHeight - tray.getBoundingClientRect().top + 8}px`; // above an open tray, clear of its Send
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  drawTray();
  return { frames, target: () => agent, items: () => items, setPlaying(on) { playing = folded = !!on; drawTray(); } };
}
