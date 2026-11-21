// Board bridge. atelierd's boards origin injects it into every .dc.html, before the runtime's ./support.js, as
//   <script src="/_atelier/bridge.js" data-ui="<UI origin>"></script>
// The shell on the UI origin cannot read this frame's DOM, so it asks by postMessage. Only window.parent is heard,
// and only when event.origin is data-ui; replies and events go to that origin, never '*'. Without data-ui (or opened
// top-level) the bridge answers nothing and emits nothing.
//   parent → frame {__atelier:'req', id, op, args}     frame → parent {__atelier:'res', id, result} | {…, error}
//   frame → parent {__atelier:'event', type:'__dc_booted', rootName, mounted} and {…, type:'__dc_render_errors', errors}
//   frame → parent {__atelier:'esc'} on an Escape keydown (no other key)
// Ids use Claude's grammar (view-state.md): "<File>.dc.html#<tid>:<path>[@k]", path from the runtime's annotated
// template (never from rendered child indices), @k the k-th rendered repeat of a template element inside sc-for.
// An element inside a <dc-import> is reported as the importing file's dc-import element.
(() => {
  if (window.__atelierBridge) return;
  window.__atelierBridge = true;
  const UI = document.currentScript?.dataset.ui || null; // read now: currentScript is null once this script has run
  const framed = window.parent !== window;
  const clip = (t, n = 60) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const str = (v) => (v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'object' ? (() => { try { return JSON.stringify(v); } catch { return String(v); } })() : String(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- captured before the runtime loads ----------
  const log = { console: [], failedLoads: [] };
  const ring = []; // [{t, kind:'console'|'missing', text}], the last 200, for logs({since})
  const add = (list, t) => {
    ring.push({ t: Date.now(), kind: list === log.failedLoads ? 'missing' : 'console', text: clip(t, 300) });
    if (ring.length > 200) ring.shift();
    if (list.length < 20) list.push(clip(t, 300));
  };
  const ce = console.error;
  console.error = (...a) => { add(log.console, a.map(str).join(' ')); return ce.apply(console, a); };
  const cw = console.warn;
  console.warn = (...a) => { const t = a.map(str).join(' '); if (t.startsWith('[dc-runtime]')) add(log.console, t); return cw.apply(console, a); };
  addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) add(log.failedLoads, t.src || t.href);
    else add(log.console, (e.message || 'Script error') + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''));
  }, true);
  addEventListener('unhandledrejection', (e) => add(log.console, 'unhandledrejection: ' + str(e.reason)));

  // Tweaks' motion preview (op "motion"): an animation speed for every animation, and Reduce motion, which answers
  // the board's own prefers-reduced-motion as if the user had asked for it: matchMedia (patched here, before the
  // board's scripts) and its @media rules (their media text swapped while it is on). <html data-atelier-reduce-motion>
  // marks it.
  // shortcut: JS-timed motion (setTimeout, rAF) keeps its speed; matchMedia change listeners do not fire when Reduce
  // motion flips (a board that reads it once at mount needs Restart); every animation gets the rate, so 1 also undoes a
  // board's own playbackRate.
  const motion = { rate: 1, reduce: false, asked: 0, flipped: false };
  const RM = /prefers-reduced-motion/i;
  const asIfReduced = (q) => q.replace(/\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/gi, '(max-width: -1px)').replace(/\(\s*prefers-reduced-motion\s*(?::\s*reduce\s*)?\)/gi, '(min-width: 0px)');
  const matchMedia0 = window.matchMedia?.bind(window);
  if (matchMedia0) window.matchMedia = (q) => { const s = String(q); if (RM.test(s)) motion.asked++; return matchMedia0(motion.reduce ? asIfReduced(s) : s); };
  const animate0 = Element.prototype.animate;
  if (animate0) Element.prototype.animate = function (...a) { const x = animate0.apply(this, a); if (motion.rate !== 1) x.playbackRate = motion.rate; return x; };

  // ---------- the runtime's view of the template ----------
  const rootName = () => { try { return window.__dcRootName?.() ?? null; } catch { return null; } };
  const dcRoot = () => document.getElementById('dc-root');
  const last = location.pathname.split('/').pop() || '';
  const FILE = (() => { try { return encodeURIComponent(decodeURIComponent(last)); } catch { return last; } })();
  const PATH_RE = /^\d{1,2}(?:\/\d{1,2}){0,8}$/;
  const ID_RE = /^((?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2}){1,200}\.dc\.html)#(\d{1,4})(?::(\d{1,2}(?:\/\d{1,2}){0,8}))?(?:@(\d{1,3}))?$/;
  let tplCache = { src: null, map: new Map() };
  // tid → {tag, path, inFor}, parsed from __dcAnnotatedTemplate(root) (re-parsed when a hot swap changes it).
  function template() {
    let src = null;
    try { src = window.__dcAnnotatedTemplate?.(rootName()) ?? null; } catch { /* not booted */ }
    if (src === tplCache.src) return tplCache.map;
    const map = new Map();
    if (typeof src === 'string') {
      const t = document.createElement('template');
      t.innerHTML = src; // a template's content is inert: nothing in it runs or loads
      (function walk(parent, prefix, inFor) {
        [...parent.children].forEach((el, i) => {
          const p = prefix === null ? String(i) : `${prefix}/${i}`;
          const tag = el.localName.replace(/^sc-helmet$/, 'helmet').replace(/^sc-raw-/, '');
          map.set(el.getAttribute('data-dc-tpl'), { tag, path: p, inFor });
          walk(el, p, inFor || tag === 'sc-for');
        });
      })(t.content, null, false);
    }
    tplCache = { src, map };
    return map;
  }
  // The element of the root file this element stands for: itself, or the outermost dc-import host around it.
  function own(el) {
    const root = rootName();
    let host = el.closest('[data-sc-name]');
    while (host && host.getAttribute('data-sc-name') !== root) { el = host; host = host.parentElement?.closest('[data-sc-name]'); }
    return el;
  }
  const isLayer = (el) => el.hasAttribute('data-dc-tpl') && el.getAttribute('data-dc-tpl') !== '' && own(el) === el;
  const sameTid = (tid) => [...document.querySelectorAll(`[data-dc-tpl="${CSS.escape(tid)}"]`)].filter((x) => own(x) === x && !x.closest('x-dc'));
  function idOf(el, peers) {
    const tid = el.getAttribute('data-dc-tpl'), info = template().get(tid);
    if (!info) return { id: `${FILE}#${tid}`, info: null };
    let k = '';
    if (info.inFor) { const list = peers?.get(tid) || sameTid(tid); k = '@' + list.indexOf(el); }
    return { id: `${FILE}#${tid}${PATH_RE.test(info.path) ? ':' + info.path : ''}${k}`, info };
  }
  function byId(id) {
    const m = ID_RE.exec(String(id ?? ''));
    if (!m) throw new Error('id must look like File.dc.html#<tid>:<path>[@k]');
    if (m[1] !== FILE) throw new Error(`id is for ${m[1]}, this board is ${FILE}`);
    const info = template().get(m[2]);
    if (m[3] && info && info.path !== m[3]) throw new Error(`tid ${m[2]} is at ${info.path} on this board, not ${m[3]}`);
    return sameTid(m[2])[m[4] ? Number(m[4]) : 0] || null;
  }
  const bboxOf = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10); };
  const ownText = (el) => clip([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(' '));
  const labelOf = (el, text60) => clip(el.getAttribute('aria-label') || el.getAttribute('data-screen-label') || text60 || el.localName);
  function describe(el, peers) {
    const { id, info } = idOf(el, peers);
    const text60 = clip(el.textContent);
    return { id, tid: Number(el.getAttribute('data-dc-tpl')), tag: info?.tag || el.localName, label: labelOf(el, text60), bbox: bboxOf(el), text60 };
  }
  // A wrapper: a div with one layer child, no words of its own, no label, nothing painted.
  function wrapper(el, kids) {
    if (el.localName !== 'div' || kids.length !== 1 || ownText(el) || el.hasAttribute('aria-label') || el.hasAttribute('data-screen-label')) return false;
    const cs = getComputedStyle(el);
    const painted = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || cs.backgroundImage !== 'none'
      || ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none')
      || cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0);
    return !painted;
  }
  // The layer children of el: the nearest layers below it, through runtime-only elements (hosts, interpolation spans).
  function layerKids(el) {
    const out = [];
    for (const k of el.children) {
      if (k.localName === 'script' || k.localName === 'style') continue;
      if (isLayer(k)) out.push(k);
      else if (!k.hasAttribute('data-sc-name') || k.getAttribute('data-sc-name') === rootName()) out.push(...layerKids(k));
    }
    return out;
  }

  // ---------- boot and errors, pushed to the parent ----------
  const post = (msg) => { if (UI && framed) window.parent.postMessage(msg, UI); };
  // Esc while a click in Play mode left the keys with this frame: the shell's own Esc (clear the selection, else out of full screen).
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.isTrusted && !e.target?.closest?.('input, textarea, select, [contenteditable]')) post({ __atelier: 'esc' }); }, true);
  const errorBoxes = () => [...document.querySelectorAll('.sc-logic-error, .sc-placeholder-error')].map((x) => clip(x.textContent, 300)).slice(0, 10);
  const renderErrors = () => [...new Set([...errorBoxes(), ...log.console.filter((t) => /\[dc-runtime\]|render error|compile FAILED/.test(t))])].slice(0, 10);
  let isBooted = false;
  const booted = (async () => {
    for (let i = 0; i < 150; i++) { if (dcRoot() && rootName()) return (isBooted = true); await sleep(100); }
    return false;
  })();
  booted.then((ok) => {
    post({ __atelier: 'event', type: '__dc_booted', rootName: rootName(), mounted: ok && !!dcRoot()?.firstElementChild });
    let sent = null, t = 0;
    const check = () => { const e = JSON.stringify(renderErrors()); if (e !== sent) { sent = e; post({ __atelier: 'event', type: '__dc_render_errors', errors: JSON.parse(e) }); } };
    check();
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(check, 250); }).observe(document.documentElement, { childList: true, subtree: true });
  });

  // ---------- hot swap ----------
  // The file as this frame loaded it, split like build-canvas.py's splitDc: the template, the logic, the props, and
  // everything outside them (head, runtime tag), which __dcUpdate cannot swap.
  const split = (t) => {
    const o = /<x-dc(?:\s[^>]*)?>/.exec(t), c = t.lastIndexOf('</x-dc>');
    if (!o || c < o.index) return null;
    const sc = /<script\b[^>]*\bdata-dc-script\b[^>]*>[\s\S]*?<\/script>/.exec(t.slice(c));
    const s = sc && new DOMParser().parseFromString(sc[0], 'text/html').querySelector('script'); // an inert document: nothing runs
    return { template: t.slice(o.index + o[0].length, c), js: s ? s.textContent : '', props: s ? s.getAttribute('data-props') : null,
      outside: t.slice(0, o.index) + (sc ? t.slice(c).replace(sc[0], '') : t.slice(c)) };
  };
  const source = () => fetch(location.href, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  let loaded = UI && framed ? source() : Promise.resolve(null), swapping = Promise.resolve();

  // ---------- play: steps sent to the element itself, settle, state ----------
  // Steps act like a user: the element is scrolled into view, must be the topmost thing at its centre (or contain
  // it), and gets the events a real pointer or keyboard sends, in board CSS px (the camera's zoom never enters).
  let lastChange = performance.now(); // DOM mutations and scrolls, for settle's 300 ms of quiet
  new MutationObserver(() => { lastChange = performance.now(); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('scroll', () => { lastChange = performance.now(); }, true);
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); }); // rAF stalls in a hidden frame
  const layerOf = (el) => { while (el && !(el.hasAttribute?.('data-dc-tpl') && el.getAttribute('data-dc-tpl') !== '')) el = el.parentElement; return el ? own(el) : null; };
  const at = (el) => { const l = layerOf(el); if (!l) return { id: null, tag: el.localName, text60: clip(el.textContent) }; const d = describe(l); return { id: d.id, tag: d.tag, text60: d.text60 }; };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  // Where a pointer at el's centre lands: {x, y, hit}, or null when the centre is outside the board.
  const centre = (el) => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ? null : { x, y, hit: document.elementFromPoint(x, y) };
  };
  const reaches = (el, c) => !!c?.hit && (c.hit === el || el.contains(c.hit));
  // Hidden, or something else (a sheet, the next screen) is on top at its centre and at four inner points; a hit on
  // an ancestor (el or its parts take no pointer) or outside the board counts as in sight.
  const covered = (el) => {
    if (!shown(el)) return true;
    const r = el.getBoundingClientRect();
    return [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].every(([fx, fy]) => {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      return hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    });
  };
  // The elements a step names, in the order to try them: an id, a CSS selector, or visible text (exact, else prefix; deepest first).
  function candidates(step) {
    if (step.id) { const el = byId(step.id); if (!el) throw new Error(`no rendered element ${step.id}`); return [el]; }
    const root = dcRoot() || document.body;
    if (typeof step.selector === 'string' && step.selector) return [...root.querySelectorAll(step.selector)];
    if (typeof step.text === 'string' && step.text.trim()) {
      const want = clip(step.text, 200), all = [...root.querySelectorAll('[data-dc-tpl]')].filter(isLayer);
      const said = (el) => clip(el.getAttribute('aria-label') || el.innerText || '', 200);
      const exact = all.filter((el) => said(el) === want);
      const hits = exact.length ? exact : all.filter((el) => said(el).startsWith(want));
      return hits.filter((el) => !hits.some((x) => x !== el && el.contains(x))).reverse(); // the deepest of nested matches
    }
    return null;
  }
  // Scrolls el into view and returns {el, hit, x, y}: hit is what a pointer at el's centre lands on. Throws when no
  // candidate is shown, or every shown one is covered (naming what covers it) or outside the board.
  async function reach(list) {
    const seen = list.filter(shown);
    if (!seen.length) throw new Error(list.length ? 'the element is not shown (no size, or hidden)' : 'no element matches');
    let why = '';
    for (const el of seen.slice(0, 5)) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      await frame();
      const c = centre(el);
      if (!c) { why ||= 'its centre is outside the board even after scrolling'; continue; }
      if (reaches(el, c)) return { el, ...c };
      if (!why) { const l = c.hit && layerOf(c.hit), d = l && describe(l); why = `covered by ${d ? `${d.tag} "${d.label}" (${d.id})` : 'something outside the board\'s layers'}`; }
    }
    throw new Error(why);
  }
  const mouse = (o, type) => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: o.x, clientY: o.y, screenX: o.x, screenY: o.y, button: 0, buttons: type === 'down' ? 1 : 0, detail: 1 });
  const ptr = (o, type, kind) => ({ ...mouse(o, type), pointerId: 1, isPrimary: true, pointerType: kind, width: 1, height: 1, pressure: type === 'down' ? 0.5 : 0 });
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]';
  function press(o, kind) { // pointerdown, mousedown, (focus), pointerup, mouseup, click: what a real click or tap sends
    const t = o.hit;
    t.dispatchEvent(new PointerEvent('pointerover', ptr(o, 'move', kind)));
    t.dispatchEvent(new PointerEvent('pointerdown', ptr(o, 'down', kind)));
    if (t.dispatchEvent(new MouseEvent('mousedown', mouse(o, 'down')))) t.closest(FOCUSABLE)?.focus({ preventScroll: true });
    t.dispatchEvent(new PointerEvent('pointerup', ptr(o, 'up', kind)));
    t.dispatchEvent(new MouseEvent('mouseup', mouse(o, 'up')));
    t.dispatchEvent(new MouseEvent('click', mouse(o, 'up')));
  }
  function hover(o) {
    const t = o.hit;
    for (const [C, type, bubbles] of [[PointerEvent, 'pointerover', true], [PointerEvent, 'pointerenter', false], [MouseEvent, 'mouseover', true], [MouseEvent, 'mouseenter', false], [PointerEvent, 'pointermove', true], [MouseEvent, 'mousemove', true]]) {
      t.dispatchEvent(new C(type, { ...(C === PointerEvent ? ptr(o, 'move', 'mouse') : mouse(o, 'move')), bubbles }));
    }
  }
  function type(el, value) {
    el.focus({ preventScroll: true });
    const v = String(value ?? '');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // React keeps its own copy of the value: set it through the prototype's setter so the input event counts.
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    } else if (el.isContentEditable) el.textContent = v;
    else throw new Error(`cannot type into a ${el.localName}`);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const CODES = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', ' ': 'Space', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  function key(el, k) {
    const o = { key: k, code: CODES[k] || (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k), bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  // The element itself when it scrolls that way, else its nearest ancestor that does (overflow auto or scroll: what a
  // user can scroll), else the page.
  function scroller(el, dx, dy) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e), can = (o) => o === 'auto' || o === 'scroll' || o === 'overlay';
      if ((dy && can(cs.overflowY) && e.scrollHeight > e.clientHeight) || (dx && can(cs.overflowX) && e.scrollWidth > e.clientWidth)) return e;
    }
    return document.scrollingElement || document.documentElement;
  }
  const ACTS = ['click', 'tap', 'type', 'key', 'scroll', 'hover'];
  async function step(s) {
    if (!s || typeof s !== 'object' || !ACTS.includes(s.do)) throw new Error(`do must be one of ${ACTS.join(', ')}`);
    const list = candidates(s);
    if (s.do === 'key') {
      if (typeof s.key !== 'string' || !s.key) throw new Error('key needs key, e.g. "Enter"');
      const el = list ? (await reach(list)).el : (document.activeElement || document.body);
      key(el, s.key);
      return at(el);
    }
    if (s.do === 'scroll') {
      const dx = Number(s.dx) || 0, dy = Number(s.dy) || 0;
      if (!dx && !dy) throw new Error('scroll needs dx or dy');
      const o = list ? await reach(list) : null, sc = scroller(o?.el || dcRoot() || document.body, dx, dy);
      const was = [sc.scrollLeft, sc.scrollTop];
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, deltaX: dx, deltaY: dy, deltaMode: 0, clientX: o?.x ?? innerWidth / 2, clientY: o?.y ?? innerHeight / 2 });
      if ((o?.hit || sc).dispatchEvent(wheel)) sc.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return { ...at(o?.el || sc), scrolled: [Math.round(sc.scrollLeft - was[0]), Math.round(sc.scrollTop - was[1])] };
    }
    if (!list) throw new Error(`${s.do} needs id, selector or text`);
    const o = await reach(list);
    if (s.do === 'type') type(o.el, s.value);
    else if (s.do === 'hover') hover(o);
    else press(o, s.do === 'tap' ? 'touch' : 'mouse');
    return at(o.el);
  }
  // Still: no finite animation running, no stream, and no DOM change or scroll for 300 ms, counted from the call.
  // Infinite animations never end: they are listed in running and not waited on.
  async function settle({ timeoutMs = 5000 } = {}) {
    await booted;
    const t0 = performance.now(), limit = Math.min(Math.max(Number(timeoutMs) || 5000, 300), 30000);
    let busySince = t0, finite = [], streaming = false;
    for (;;) {
      const now = performance.now(), anims = document.getAnimations();
      const live = anims.filter((a) => a.playState === 'running' || a.pending);
      const loops = live.filter((a) => a.effect?.getComputedTiming().iterations === Infinity);
      finite = live.filter((a) => !loops.includes(a));
      try { streaming = !!window.__dcStreaming?.(); } catch { streaming = false; }
      if (finite.length || streaming) busySince = now;
      const quiet = now - Math.max(lastChange, busySince, t0);
      if (quiet >= 300 || now - t0 >= limit) {
        const name = (a) => a.animationName || a.transitionProperty || a.id || 'animation';
        const running = [...new Map(loops.map((a) => { const r = { name: name(a), ...(a.effect?.target ? { at: at(a.effect.target).id } : {}) }; return [`${r.name} ${r.at}`, r]; })).values()].slice(0, 20);
        const out = { settled: quiet >= 300, ms: Math.round(now - t0), running };
        if (!out.settled) out.busy = { animations: [...new Set(finite.map(name))].slice(0, 10), streaming, domChangedMsAgo: Math.round(now - lastChange) };
        return out;
      }
      await sleep(50);
    }
  }
  // The root's logic host: the component the runtime renders for <x-dc>, found through React's fiber on its element.
  // shortcut: reads React and dc-runtime internals (__reactFiber$, host.logic, __makeLogic); a runtime update may move them.
  function host() {
    const el = document.querySelector(`[data-sc-name="${CSS.escape(rootName() || '')}"]`);
    const k = el && Object.keys(el).find((n) => n.startsWith('__reactFiber$'));
    for (let f = k && el[k]; f; f = f.return) if (f.stateNode?.logic && f.stateNode.__name === rootName()) return f.stateNode;
    throw new Error('the board has no logic state (not a dc board, or not booted)');
  }
  // ---------- tweaks: props and motion ----------
  // The runtime's entry for the root: propsMeta (from data-props, kept current by hot swaps) and propOverrides (the
  // live preview, which __dcSetProps replaces as a whole).
  const entry = () => { try { return window.__dcRegistry?.[rootName()] ?? null; } catch { return null; } };
  function checkValue(meta, k, v) { // the same rules as server/props.mjs checkValue
    const m = Object.hasOwn(meta, k) ? meta[k] : null;
    if (!m) throw new Error(`no Tweak ${k}; this board has ${Object.keys(meta).join(', ') || 'none'}`);
    if (m.editor === 'enum' && Array.isArray(m.options)) { if (!m.options.includes(v)) throw new Error(`${k} must be one of ${m.options.join(', ')}`); return; }
    if (m.editor === 'boolean') { if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`); return; }
    if (m.editor === 'range' || m.editor === 'number') {
      const lo = Number.isFinite(m.min) ? m.min : -Infinity, hi = Number.isFinite(m.max) ? m.max : Infinity;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be a number${lo > -Infinity || hi < Infinity ? ` in ${lo}-${hi}` : ''}`);
      return;
    }
    if (typeof m.default === 'string' && typeof v !== 'string') throw new Error(`${k} must be a string`);
    if (v === null || typeof v === 'object') throw new Error(`${k} must be a string, number or boolean`);
  }
  // $presets ({label: {key: value}}) from the file's data-props: the runtime keeps no $-keys but $preview.
  async function presets() {
    const src = await loaded, raw = src ? split(src)?.props : document.querySelector('script[data-dc-script]')?.getAttribute('data-props');
    try { const p = JSON.parse(raw).$presets; return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
  }
  // Every animation at the speed, and the @media (prefers-reduced-motion) rules as Reduce motion has them. → the
  // number of those rules.
  function applyMotion() {
    for (const a of document.getAnimations()) if (a.playbackRate !== motion.rate) a.playbackRate = motion.rate;
    if (!motion.reduce && !motion.flipped) return 0;
    motion.flipped = true;
    let n = 0;
    const walk = (rules) => {
      for (const r of rules) {
        if (r.media && r.cssRules) {
          r.__atelierMedia ??= r.media.mediaText; // the rule's own text, kept on it
          if (RM.test(r.__atelierMedia)) { r.media.mediaText = motion.reduce ? asIfReduced(r.__atelierMedia) : r.__atelierMedia; n++; }
        }
        if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const sh of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) { try { walk(sh.cssRules); } catch { /* another origin's sheet */ } }
    return n;
  }
  // New animations and style sheets (a class change, a hot swap) follow the setting.
  let motionTimer = 0;
  const motionLater = () => { if ((motion.rate !== 1 || motion.flipped) && !motionTimer) motionTimer = setTimeout(() => { motionTimer = 0; applyMotion(); }, 30); };
  new MutationObserver(motionLater).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  for (const t of ['animationstart', 'transitionrun']) addEventListener(t, () => { if (motion.rate !== 1) applyMotion(); }, true);

  const stateJson = (st) => { const seen = new WeakSet(); return JSON.stringify(st ?? {}, (k, v) => (typeof v === 'function' || v instanceof Node ? undefined : v && typeof v === 'object' ? (seen.has(v) ? '[cycle]' : (seen.add(v), v)) : v)); };
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  // What the user sees: the shown, uncovered buttons and links by label, and the start of the visible text.
  function screen() {
    const root = dcRoot() || document.body, buttons = [];
    for (const el of root.querySelectorAll('button, a[href], [role="button"], [role="tab"], input, select, textarea')) {
      if (buttons.length < 30 && shown(el) && reaches(el, centre(el))) buttons.push(labelOf(el, clip(el.innerText || el.value || '')));
    }
    return { buttons, text: clip(root.innerText, 400) };
  }

  // ---------- ops ----------
  // Every op takes one args object and returns JSON-able data.
  const ops = {
    // After the file changed on disk: hands the changed parts to the runtime, which keeps the board's state.
    // → {reload:false, parts} or {reload:true} when only a reload can show it (no __dcUpdate, or the outside changed).
    update() {
      const run = swapping.then(async () => {
        await booted;
        const [was, now] = [await loaded, await source()];
        const a = was && split(was), b = now && split(now);
        if (!a || !b || typeof window.__dcUpdate !== 'function' || a.outside !== b.outside) return { reload: true };
        const parts = [['props', 'props'], ['html', 'template'], ['js', 'js']].filter(([, k]) => a[k] !== b[k]);
        for (const [kind, k] of parts) window.__dcUpdate(rootName(), kind, b[k], false);
        loaded = Promise.resolve(now);
        return { reload: false, parts: parts.map(([kind]) => kind) };
      });
      swapping = run.catch(() => {});
      return run;
    },
    async status() {
      let streaming = false; try { streaming = !!window.__dcStreaming?.(); } catch { /* old runtime */ }
      return { href: location.href, file: FILE, rootName: rootName(), booted: isBooted, mounted: !!dcRoot()?.firstElementChild, streaming,
        renderErrors: renderErrors(), consoleErrors: log.console.slice(), failedLoads: log.failedLoads.slice() };
    },
    // {root?: id, depth?: 1-12 (default 8), max?: nodes (default 1500)} → {file, tree:[node], count, truncated}
    async tree({ root = null, depth = 8, max = 1500 } = {}) {
      await booted;
      depth = Math.min(Math.max(Number(depth) || 8, 1), 12);
      const peers = new Map();
      for (const el of document.querySelectorAll('[data-dc-tpl]')) if (isLayer(el)) { const t = el.getAttribute('data-dc-tpl'); (peers.get(t) || peers.set(t, []).get(t)).push(el); }
      let count = 0, truncated = false;
      const kidsOf = (el) => (el.localName === 'svg' || el.hasAttribute('data-sc-name') ? [] : layerKids(el)); // svg and imports are leaves
      function build(el, d) {
        let kids = kidsOf(el);
        while (wrapper(el, kids)) { el = kids[0]; kids = kidsOf(el); }
        count++;
        const node = describe(el, peers);
        node.children = [];
        if (d >= depth) { if (kids.length) node.more = kids.length; return node; }
        for (const k of kids) { if (count >= max) { truncated = true; break; } node.children.push(build(k, d + 1)); }
        return node;
      }
      const start = root ? byId(root) : null;
      if (root && !start) throw new Error('no rendered element with that id');
      const tops = start ? [start] : layerKids(dcRoot() || document.body);
      const tree = [];
      for (const el of tops) { if (count >= max) { truncated = true; break; } tree.push(build(el, 1)); }
      return { file: FILE, tree, count, truncated };
    },
    // {x, y} in board CSS pixels → the layer at that point, or null (for the picker).
    async at({ x, y } = {}) {
      await booted;
      let el = document.elementFromPoint(Number(x), Number(y));
      while (el && !(el.hasAttribute('data-dc-tpl') && el.getAttribute('data-dc-tpl') !== '')) el = el.parentElement;
      return el ? describe(own(el)) : null;
    },
    async bbox({ id } = {}) {
      await booted;
      const el = byId(id);
      return el ? { id, bbox: bboxOf(el), covered: covered(el) } : null;
    },
    // {selector} or {text} → up to 20 layers: the hook atelier_resolve uses for "the Fortsätt button" (and T7 for play).
    async find({ selector, text } = {}) {
      await booted;
      let els;
      if (typeof selector === 'string' && selector) els = [...(dcRoot() || document.body).querySelectorAll(selector)].map((el) => { while (el && !el.hasAttribute('data-dc-tpl')) el = el.parentElement; return el && own(el); });
      else if (typeof text === 'string' && text.trim()) {
        const want = clip(text, 200), all = [...document.querySelectorAll('[data-dc-tpl]')].filter(isLayer);
        const said = (el) => clip(el.getAttribute('aria-label') || el.innerText || '', 200);
        const exact = all.filter((el) => said(el) === want);
        els = (exact.length ? exact : all.filter((el) => said(el).startsWith(want))).reverse(); // deepest first
      } else throw new Error('find needs selector or text');
      return [...new Set(els.filter(Boolean))].slice(0, 20).map((el) => describe(el));
    },
    // {steps:[{do, id?|selector?|text?, value?, key?, dx?, dy?}]} → {ok, steps:[{do, ok, error?, at:{id, tag, text60}}]},
    // stopping at the first failure. No waiting between steps: the caller waits (settle) after each one.
    async play({ steps } = {}) {
      await booted;
      if (!Array.isArray(steps) || !steps.length || steps.length > 50) throw new Error('steps must be a list of 1-50 steps');
      const out = [];
      for (const s of steps) {
        try { out.push({ do: s?.do, ok: true, at: await step(s) }); } catch (e) { out.push({ do: s?.do, ok: false, error: String(e?.message || e) }); break; }
      }
      return { ok: out.every((r) => r.ok) && out.length === steps.length, steps: out };
    },
    // {timeoutMs?} → {settled, ms, running:[{name, at}], busy?}
    wait: settle,
    // {action:"get"} → {state (JSON ≤ 4 KB, the largest keys left out beyond that), truncated, dropped?, bytes, sha};
    // {action:"reset"}: a fresh logic with the current props, mounted again (the runtime's own path when its logic changes).
    async state({ action = 'get' } = {}) {
      await booted;
      const h = host();
      if (action === 'reset') {
        try { h.logic.componentWillUnmount?.(); } catch { /* the board's own cleanup failed */ }
        h.__makeLogic(h.logic.constructor, null);
        h.__needsDidMount = true;
        h.forceUpdate();
        await frame();
        return { reset: true };
      }
      if (action !== 'get') throw new Error('action must be get or reset');
      const full = stateJson(h.logic.state), obj = JSON.parse(full), dropped = [];
      while (JSON.stringify(obj).length > 4096 && Object.keys(obj).length) {
        const big = Object.keys(obj).sort((a, z) => JSON.stringify(obj[z] ?? null).length - JSON.stringify(obj[a] ?? null).length)[0];
        dropped.push(big); delete obj[big];
      }
      return { state: obj, truncated: dropped.length > 0, ...(dropped.length ? { dropped } : {}), bytes: full.length, sha: await sha(full) };
    },
    // The state's sha and what is on screen, to tell two moments of a flow apart.
    async digest() {
      await booted;
      let stateSha = null; try { stateSha = await sha(stateJson(host().logic.state)); } catch { /* no logic state */ }
      return { stateSha, screen: screen() };
    },
    // Tweaks. {} or {get:true} → {meta, values (in effect), changed (those not at the file's default), presets?};
    // {set:{key: value}}: a live preview merged with the earlier ones, nothing written; {reset:true}: the defaults again.
    async props({ set, reset } = {}) {
      await booted;
      const e = entry();
      if (!e || typeof window.__dcSetProps !== 'function') throw new Error('the board has no props (not a dc board, or not booted)');
      const meta = Object.fromEntries(Object.entries(e.propsMeta || {}).filter(([, v]) => v && typeof v === 'object'));
      if (reset) window.__dcSetProps(rootName(), null);
      else if (set !== undefined) {
        if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('set must be an object of Tweaks, e.g. {"start": "…"}');
        for (const [k, v] of Object.entries(set)) checkValue(meta, k, v);
        window.__dcSetProps(rootName(), { ...(e.propOverrides || {}), ...set });
      }
      if (reset || set !== undefined) { await frame(); await frame(); } // React renders, then the board's componentDidUpdate
      const over = e.propOverrides || {}, values = {}, changed = {};
      for (const [k, m] of Object.entries(meta)) {
        const on = Object.hasOwn(over, k);
        values[k] = on ? over[k] : m.default;
        if (on && over[k] !== m.default) changed[k] = over[k];
      }
      const p = await presets();
      return { meta, values, changed, ...(p ? { presets: p } : {}) };
    },
    // {rate?: (0, 4], reduce?: boolean} → {rate, reduce, honoured: {mediaRules, matchMedia (times the board asked)}, rates}
    async motion({ rate, reduce } = {}) {
      if (rate !== undefined) {
        if (typeof rate !== 'number' || !(rate > 0 && rate <= 4)) throw new Error('rate must be a number above 0 and at most 4 (1 is normal speed)');
        motion.rate = rate;
      }
      if (reduce !== undefined) {
        if (typeof reduce !== 'boolean') throw new Error('reduce must be true or false');
        motion.reduce = reduce;
        document.documentElement.toggleAttribute('data-atelier-reduce-motion', reduce);
      }
      const n = applyMotion();
      return { rate: motion.rate, reduce: motion.reduce, honoured: { mediaRules: n, matchMedia: motion.asked }, rates: [...new Set(document.getAnimations().map((a) => a.playbackRate))] };
    },
    // {since?: ms epoch} → {now, console:[{t, text}], missing:[{t, url}], renderErrors}
    async logs({ since = 0 } = {}) {
      await booted;
      const after = ring.filter((e) => e.t > (Number(since) || 0));
      return { now: Date.now(), console: after.filter((e) => e.kind === 'console').map(({ t, text }) => ({ t, text })),
        missing: after.filter((e) => e.kind === 'missing').map(({ t, text }) => ({ t, url: text })), renderErrors: renderErrors() };
    },
  };
  // ---------- T12: the event log a recording reads (server/record.mjs) ----------
  // Clicks (a user's or a play step's) with the element they hit, animations and transitions starting and ending, and
  // the logic state's top-level keys that changed (watched every 100 ms while a recording asks for it). Errors come
  // from the logs ring above. Each entry has t, ms since the epoch; the last 500 are kept.
  const evlog = [];
  const note = (e) => { evlog.push({ t: Date.now(), ...e }); if (evlog.length > 500) evlog.shift(); };
  addEventListener('click', (e) => { if (e.target instanceof Element) note({ type: 'click', ...at(e.target), trusted: e.isTrusted }); }, true);
  for (const [type, phase] of [['animationstart', 'start'], ['animationend', 'end'], ['animationcancel', 'cancel'], ['transitionstart', 'start'], ['transitionend', 'end'], ['transitioncancel', 'cancel']]) {
    addEventListener(type, (e) => {
      if (!(e.target instanceof Element)) return;
      note({ type: 'animation', phase, name: clip(e.animationName || e.propertyName || 'animation', 60), ...(type.startsWith('transition') ? { transition: true } : {}), id: at(e.target).id });
    }, true);
  }
  let watching = 0, watchTimer = 0, lastState = null;
  function watchState() {
    let now = null; try { now = stateJson(host().logic.state); } catch { /* no logic state */ }
    if (lastState !== null && now !== null && now !== lastState) {
      const a = JSON.parse(lastState), b = JSON.parse(now);
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      note({ type: 'state', keys: keys.slice(0, 10) });
    }
    lastState = now;
    watchTimer = Date.now() < watching ? setTimeout(watchState, 100) : 0;
  }
  // {since?: ms epoch, watchMs?: watch the state that long (≤ 30 s) from now} → {now, events: [{t, type, …}]}, oldest first.
  ops.events = async ({ since = 0, watchMs = 0 } = {}) => {
    await booted;
    const from = Number(since) || 0;
    if (Number(watchMs) > 0) { watching = Date.now() + Math.min(Number(watchMs), 30000); if (!watchTimer) { lastState = null; watchState(); } }
    const errors = ring.filter((e) => e.t > from).map((e) => (e.kind === 'missing' ? { t: e.t, type: 'missing', url: e.text } : { t: e.t, type: 'error', text: e.text }));
    return { now: Date.now(), events: [...evlog.filter((e) => e.t > from), ...errors].sort((x, y) => x.t - y.t) };
  };

  // Opened top-level (atelierd's headless runner over CDP), nothing can post to the bridge: the runner calls this.
  // A top-level board is its own page, so this reaches nothing it could not already touch.
  if (!framed) window.__atelierBridgeOp = (op, args) => (Object.hasOwn(ops, op) ? ops[op](args && typeof args === 'object' ? args : {}) : Promise.reject(new Error(`no op ${op}`)));

  addEventListener('message', async (e) => {
    if (!UI || !framed || e.source !== window.parent || e.origin !== UI) return;
    const m = e.data;
    if (!m || m.__atelier !== 'req' || typeof m.op !== 'string' || !Object.hasOwn(ops, m.op)) return;
    try { post({ __atelier: 'res', id: m.id, result: await ops[m.op](m.args && typeof m.args === 'object' ? m.args : {}) }); }
    catch (err) { post({ __atelier: 'res', id: m.id, error: String(err?.message || err) }); }
  });
})();
