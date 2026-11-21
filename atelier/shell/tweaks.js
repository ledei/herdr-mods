// The Tweaks panel (V2Play), docked at the right in Play mode: the played board's props from its data-props
// (propsMeta), previewed live through the bridge's props op, saved as the file's defaults with Save as default, and
// Reset. A mock key (mock, useMocks, mockData, scenario) is the top "Data" switch; $presets are a Scenario picker.
// Speed (1×, ½×, ¼×) and Reduce motion go to the bridge's motion op. All of it changes this view only and lives in
// the board's frame, so it is kept here per board and given back when the frame loads again (live()).
// Under 600 px the panel is a drawer folded to its header.
//   init({api, boards, canvas, target, onChange}) → {setOpen(on), retarget(), refresh(file), live(board), get()}
// target(): the board file to tweak, or null; onChange(): view-state's tweaks (get()) changed.
const ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 18h4"/><path d="M12 18h8"/><circle cx="10" cy="18" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/></svg>';
const MOCK = /^(use[-_]?)?mocks?([-_]?data)?$|^scenario$/i;
const SPEEDS = [[1, '1×'], [0.5, '½×'], [0.25, '¼×']];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const button = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };
// "longDesc" → "Long desc", unless the board names it.
const labelOf = (k, m) => (typeof m.label === 'string' && m.label) || k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const stem = (f) => f.replace(/\.dc\.html$/, '');

// ---------- controls: each returns {node, set(value)} and calls pick(value) on a change ----------
function segments(name, opts, pick) { // opts: [[value, text]]
  const g = el('span', 'seg');
  g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', name);
  const set = (x) => { for (const [v, b] of bs) b.setAttribute('aria-checked', String(v === x)); };
  const bs = opts.map(([v, t]) => { const b = button('', t); b.setAttribute('role', 'radio'); b.dataset.value = String(v); b.onclick = () => { set(v); pick(v); }; g.append(b); return [v, b]; });
  return { node: g, set };
}
function select(name, opts, pick, placeholder) { // option values are String(v); pick gets the option itself back
  const s = el('select', 'field');
  s.setAttribute('aria-label', name);
  if (placeholder) s.append(Object.assign(el('option', '', placeholder), { value: '' }));
  for (const v of opts) s.append(Object.assign(el('option', '', String(v)), { value: String(v) }));
  s.onchange = () => { const v = opts.find((o) => String(o) === s.value); if (v !== undefined) pick(v); };
  return { node: s, set: (x) => { s.value = x === undefined || x === null ? '' : String(x); } };
}
function toggle(name, pick) {
  const b = button('switch');
  b.setAttribute('role', 'switch'); b.setAttribute('aria-label', name);
  b.append(el('span'));
  const set = (x) => b.setAttribute('aria-checked', String(x === true));
  b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; set(v); pick(v); };
  return { node: b, set };
}
function slider(name, m, pick) {
  const box = el('span', 'slide'), r = el('input'), n = el('input', 'field num');
  for (const i of [r, n]) Object.assign(i, { min: m.min ?? 0, max: m.max ?? 100, step: m.step ?? 1 });
  r.type = 'range'; n.type = 'number';
  r.setAttribute('aria-label', name); n.setAttribute('aria-label', `${name}, value`);
  let t = 0;
  r.oninput = () => { const v = Number(r.value); n.value = v; clearTimeout(t); t = setTimeout(() => pick(v), 80); }; // v now: an answer to an earlier change may set r meanwhile
  n.onchange = () => { const v = Math.min(Math.max(Number(n.value), Number(n.min)), Number(n.max)); if (Number.isFinite(v)) { r.value = n.value = v; pick(v); } };
  box.append(r, n);
  if (m.unit) box.append(el('span', 'dim', m.unit));
  return { node: box, set: (x) => { r.value = n.value = x; } };
}
function text(name, pick) {
  const i = el('input', 'field');
  i.type = 'text'; i.setAttribute('aria-label', name); i.spellcheck = false;
  i.onchange = () => pick(i.value);
  return { node: i, set: (x) => { i.value = x ?? ''; } };
}
function control(k, m, pick) {
  const name = labelOf(k, m);
  if (m.editor === 'boolean') return MOCK.test(k) ? segments('Data', [[true, 'Mock'], [false, 'Real shape']], pick) : toggle(name, pick);
  if (m.editor === 'enum' && Array.isArray(m.options)) {
    const short = m.options.length <= 3 && m.options.every((o) => String(o).length <= 8);
    return short || MOCK.test(k) ? segments(name, m.options.map((o) => [o, String(o)]), pick) : select(name, m.options, pick);
  }
  if (m.editor === 'range' || m.editor === 'number' || typeof m.default === 'number') return slider(name, m, pick);
  return text(name, pick);
}

export function init({ api, boards, canvas, target, onChange }) {
  const kept = new Map(); // file → {values: the changed Tweaks, rate, reduce}
  const keep = (f) => kept.get(f) || kept.set(f, { values: {}, rate: 1, reduce: false }).get(f);
  let open = false, file = null, seq = 0, sets = {}, presetSel = null;
  let edits = 0; // counts the user's changes: an answer to an older one does not move the controls back

  const panel = el('aside', 'tweaks');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Tweaks');
  panel.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a pan or a pick on the canvas
  panel.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); }); // V, C, R are the canvas's
  const head = button('sh');
  head.setAttribute('aria-expanded', 'false');
  head.innerHTML = `${ICON}<span>Tweaks</span>`;
  const name = el('span', 'board dim');
  head.append(name);
  head.onclick = () => { const on = !panel.classList.contains('open'); panel.classList.toggle('open', on); head.setAttribute('aria-expanded', String(on)); };
  const body = el('div', 'tbody');
  body.addEventListener('input', () => { edits++; }, true); // a slider moving before its debounced preview
  panel.append(head, body);
  document.body.append(panel);

  const save = button('link save', 'Save as default'), reset = button('link reset', 'Reset'), dot = el('span', 'dim', ' · '), status = el('div', 'tstatus');
  const note = el('div', 'tnote', 'Tweaks change this view only. ');
  note.append(save, dot, reset);
  const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };
  const told = () => { if (file) { const n = Object.keys(keep(file).values).length; save.hidden = reset.hidden = dot.hidden = !n; } onChange(); };
  const row = (key, label, c, cls = '') => { const r = el('div', `kv ${cls}`.trim()); r.dataset.key = key; r.append(el('span', 'k', label), c.node); return r; };

  // ---------- the board's Tweaks ----------
  async function preview(vals) {
    const f = file, b = boards.get(f), at = ++edits;
    try {
      const r = await boards.ask(b, 'props', { set: vals }, { pin: true, ms: 10000 });
      keep(f).values = r.changed;
      if (f === file && at === edits) { for (const [k, s] of Object.entries(sets)) s(r.values[k]); say(''); }
    } catch (e) { if (f === file) { say(String(e.message || e), true); load(); } }
    told();
  }
  function build(r) {
    sets = {};
    const meta = r.meta || {}, keys = Object.keys(meta), rows = [];
    const add = (k, cls) => {
      const c = control(k, meta[k], (v) => preview({ [k]: v }));
      sets[k] = c.set;
      c.set(r.values[k]);
      rows.push(row(k, MOCK.test(k) && meta[k].editor === 'boolean' ? 'Data' : labelOf(k, meta[k]), c, `tw ${cls}`));
    };
    for (const k of keys.filter((x) => MOCK.test(x))) add(k, 'top');
    presetSel = null;
    if (r.presets && Object.keys(r.presets).length) {
      presetSel = select('Scenario', Object.keys(r.presets), (label) => preview(r.presets[label]), 'Choose…');
      rows.push(row('preset', 'Scenario', presetSel));
    }
    const rest = keys.filter((x) => !MOCK.test(x)), sections = [...new Set(rest.map((k) => meta[k].section).filter(Boolean))];
    for (const k of rest.filter((x) => !meta[x].section)) add(k, '');
    for (const s of sections) { rows.push(el('div', 'sect', s)); for (const k of rest.filter((x) => meta[x].section === s)) add(k, ''); }
    if (!keys.length) rows.push(el('div', 'tempty dim', 'This board has no Tweaks.'));
    const group = el('div', 'tgroup');
    group.append(...rows);
    body.replaceChildren(group, motionRows(), note, status);
    told();
  }
  // Nothing to tweak (no board, or it did not answer): one line, no controls that would ask it.
  function only(msg, err = false) {
    sets = {};
    const e = el('div', `tempty ${err ? 'err' : 'dim'}`, msg);
    body.replaceChildren(e);
    onChange();
  }
  async function load() {
    const f = file, my = ++seq;
    name.textContent = f ? stem(f) : '';
    if (!f || !boards.get(f)) return only('No board to tweak. Pick one in Design, then press Play.');
    let r;
    try { r = await boards.ask(boards.get(f), 'props', {}, { pin: true, ms: 10000 }); } catch (e) { r = { error: String(e.message || e) }; }
    if (my !== seq || f !== file) return;
    if (r.error && !/has no props/.test(r.error)) return only(`The board did not answer: ${r.error}`, true);
    if (r.error) r = { meta: {}, values: {}, changed: {} }; // not a dc board: no Tweaks, but motion still works
    keep(f).values = r.changed;
    build(r);
  }

  // ---------- motion: this view only, never written ----------
  function motionRows() {
    const k = keep(file), g = el('div', 'tgroup'), hint = el('div', 'thint dim');
    const send = async (args) => {
      try {
        const r = await boards.ask(boards.get(file), 'motion', args, { pin: true, ms: 5000 });
        hint.textContent = r.reduce && !r.honoured.mediaRules && !r.honoured.matchMedia ? 'This board has no reduced-motion styles, so it looks the same.' : '';
      } catch (e) { say(String(e.message || e), true); }
      told();
    };
    const sp = segments('Animation speed', SPEEDS, (v) => { k.rate = v; send({ rate: v }); });
    const rm = toggle('Reduce motion', (v) => { k.reduce = v; send({ reduce: v }); });
    sp.set(k.rate); rm.set(k.reduce);
    g.append(row('speed', 'Speed', sp), row('reduce', 'Reduce motion', rm), hint);
    return g;
  }

  save.onclick = async () => {
    const f = file, values = { ...keep(f).values };
    if (!Object.keys(values).length) return;
    say('Saving…');
    try { await api.json('POST', '/__atelier/props/persist', { canvas, board: f, values }); say('Saved as the default. The file changed in this one place.'); } catch (e) { say(String(e.message || e), true); }
  };
  reset.onclick = async () => {
    const f = file;
    try {
      const r = await boards.ask(boards.get(f), 'props', { reset: true }, { pin: true, ms: 10000 });
      keep(f).values = r.changed;
      for (const [k, s] of Object.entries(sets)) s(r.values[k]);
      presetSel?.set('');
      say('');
    } catch (e) { say(String(e.message || e), true); }
    told();
  };

  return {
    setOpen(on) {
      open = !!on;
      panel.hidden = !open;
      document.body.classList.toggle('tweaks-open', open);
      if (open) { file = null; this.retarget(); }
    },
    // The board to tweak may have changed (a selection, a page, the view moved).
    retarget() {
      if (!open) return;
      const f = target() || null;
      if (f === file) return;
      file = f;
      load();
      onChange();
    },
    // After an agent's props call or a hot swap of that board: read it again.
    refresh(f) { if (open && f === file) load(); },
    // A board's frame loaded again: its Tweaks and motion come back.
    async live(b) {
      const k = kept.get(b?.file);
      if (!k) return;
      try {
        if (Object.keys(k.values).length) await boards.ask(b, 'props', { set: k.values }, { ms: 10000 });
        if (k.rate !== 1 || k.reduce) await boards.ask(b, 'motion', { rate: k.rate, reduce: k.reduce }, { ms: 5000 });
      } catch { /* a board that cannot take them back shows its defaults; load() says so */ }
      if (b.file === file) this.refresh(b.file);
    },
    // view-state tweaks: the board shown here and what is changed on it, or null.
    get() {
      const k = file && kept.get(file);
      if (!k || (!Object.keys(k.values).length && k.rate === 1 && !k.reduce)) return null;
      return { board: file, values: { ...k.values }, ...(k.rate !== 1 ? { speed: k.rate } : {}), ...(k.reduce ? { reduceMotion: true } : {}) };
    },
  };
}
