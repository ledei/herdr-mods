// The page-side halves of the agent tools. `agentLib` runs in the private world `agentWorld`, where page scripts can
// neither see nor patch it; `hooksScript` runs in the page world, where console and fetch live, and only appends to
// the tab's console and network rings.

// Called as callAsyncJavaScript(agentLib, arguments: {fn, A, base}): runs __herdr[fn](A) and returns it as JSON text,
// so integers stay integers. A failure is {error}. Refs (backendDOMNodeId) live per document; `base` is the tab's
// counter, which only grows, so a ref from an earlier document never resolves.
let agentLib = #"""
if (!globalThis.__herdr) globalThis.__herdr = (() => {
  const H = { next: 1 }, ids = new Map(), refOf = new WeakMap();
  const fail = (m) => { throw { herdr: m }; };
  const ref = (n) => { let r = refOf.get(n); if (r === undefined) { r = H.next++; refOf.set(n, r); ids.set(r, new WeakRef(n)); } return r; };
  const node = (r) => { const w = ids.get(r), n = w && w.deref(); if (!n || !n.isConnected) fail('ref e' + r + ' is gone; call read_page again'); return n; };
  const elOf = (n) => n.nodeType === 3 ? n.parentElement : n;
  const style = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Top-level viewport CSS px: add the offsets of every same-origin iframe the node sits in.
  const offset = (doc) => {
    let x = 0, y = 0;
    for (let d = doc; d && d.defaultView && d.defaultView.frameElement; ) {
      const f = d.defaultView.frameElement, r = f.getBoundingClientRect(), s = style(f);
      x += r.left + f.clientLeft + parseFloat(s.paddingLeft); y += r.top + f.clientTop + parseFloat(s.paddingTop);
      d = f.ownerDocument;
    }
    return [x, y];
  };
  const box = (n) => {
    let r;
    if (n.nodeType === 3) { const g = n.ownerDocument.createRange(); g.selectNodeContents(n); r = g.getBoundingClientRect(); } else r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const [ox, oy] = offset(n.ownerDocument);
    return { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height };
  };
  const shown = (n, r) => box(n) || fail('ref e' + r + ' is not rendered (hidden or display:none)');
  // The focused element, followed into open shadow roots and same-origin iframes, and the document that holds it.
  const deepActive = () => {
    let d = document, a = d.activeElement;
    for (let i = 0; i < 64 && a; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.localName === 'iframe' || a.localName === 'frame') {
        let cd = null; try { cd = a.contentDocument; } catch (e) {}
        if (cd && cd.activeElement) { d = cd; a = cd.activeElement; continue; }
      }
      break;
    }
    return { doc: d, el: a };
  };

  const CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'cell']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'br', 'wbr']);
  const LEAF = new Set(['textarea', 'svg', 'canvas', 'video', 'audio', 'object', 'embed']);
  const ROLES = { button: 'button', summary: 'button', textarea: 'textbox', option: 'option', p: 'paragraph', ul: 'list', ol: 'list',
    menu: 'list', li: 'listitem', img: 'img', svg: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', form: 'form', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', thead: 'rowgroup',
    tbody: 'rowgroup', tfoot: 'rowgroup', dialog: 'dialog', fieldset: 'group', details: 'group', progress: 'progressbar',
    meter: 'meter', hr: 'separator', article: 'article', blockquote: 'blockquote', figure: 'figure', iframe: 'Iframe', frame: 'Iframe' };
  const isPassword = (el) => (el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') ||
    /password|one-time-code/i.test(el.getAttribute('autocomplete') || '');
  const inputType = (el) => (el.getAttribute('type') || 'text').toLowerCase();
  function role(el) {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r) return r;
    const t = el.localName;
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'input') {
      const ty = inputType(el);
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (el.hasAttribute('list')) return 'combobox';
      return ty === 'search' ? 'searchbox' : 'textbox';
    }
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic';
    if (ROLES[t]) return ROLES[t];
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return 'generic';
  }
  function name(el, r) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const s = text(by.split(/\s+/).map((i) => { const x = el.ownerDocument.getElementById(i); return x ? x.textContent : ''; }).join(' '));
      if (s) return s;
    }
    const al = text(el.getAttribute('aria-label')); if (al) return al;
    if (el.labels && el.labels.length) { const s = text(Array.from(el.labels).map((l) => l.textContent).join(' ')); if (s) return s; }
    for (const a of ['alt', 'title', 'placeholder']) { const v = text(el.getAttribute(a)); if (v) return v; }
    if (el.localName === 'input' && ['button', 'submit', 'reset'].includes(inputType(el))) return text(el.value) || { submit: 'Submit', reset: 'Reset' }[inputType(el)] || '';
    return CONTENT.has(r) ? text(el.textContent) : '';
  }
  function value(el) {
    const t = el.localName;
    if (t === 'textarea') return el.value;
    if (t === 'input') return ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(inputType(el)) ? '' : el.value;
    if (t === 'select') { const o = el.selectedOptions && el.selectedOptions[0]; return o ? o.text : ''; }
    return '';
  }
  function props(el, r, act) {
    const p = [], add = (n, v) => p.push({ name: n, value: { value: v } }), aria = (a) => el.getAttribute(a);
    if (el === act) add('focused', true);
    let dis = false; try { dis = el.matches(':disabled'); } catch (e) {}
    if (dis || aria('aria-disabled') === 'true') add('disabled', true);
    if (el.selected === true || aria('aria-selected') === 'true') add('selected', true);
    if (el.required === true || aria('aria-required') === 'true') add('required', true);
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(r)) {
      const ac = aria('aria-checked');
      add('checked', el.localName === 'input' && ac === null ? (el.indeterminate ? 'mixed' : el.checked) : ac === 'mixed' ? 'mixed' : ac === 'true');
    }
    const ex = aria('aria-expanded');
    if (ex !== null) add('expanded', ex === 'true'); else if (el.localName === 'details') add('expanded', el.open);
    if (r === 'heading') { const l = parseInt(aria('aria-level') || el.localName.slice(1), 10); if (l > 0) add('level', l); }
    return p;
  }
  function kids(el) {
    if (el.localName === 'iframe' || el.localName === 'frame') {
      let d = null; try { d = el.contentDocument; } catch (e) {} // cross-origin: not read
      const b = d && (d.body || d.documentElement);
      return b ? Array.from(b.childNodes) : [];
    }
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes); // open ones only; closed ones are not reachable
    if (el.localName === 'slot') { const a = el.assignedNodes({ flatten: true }); return a.length ? a : Array.from(el.childNodes); }
    return Array.from(el.childNodes);
  }

  // A DOM walk shaped like CDP's Accessibility.getFullAXTree, for format_ax and find_nodes in herdr-browser.
  H.ax = (A) => {
    const nodes = [], passwords = [], act = deepActive().el, boxes = !!A.boxes;
    const rootEl = document.body || document.documentElement;
    let budget = 50000;
    const emit = (n, r, nm, parent) => {
      const o = { nodeId: String(nodes.length + 1), childIds: [], ignored: false, role: { value: r }, name: { value: nm.slice(0, 300) }, backendDOMNodeId: ref(n) };
      if (parent) { o.parentId = parent.nodeId; parent.childIds.push(o.nodeId); }
      if (boxes) o.box = box(n);
      nodes.push(o); budget--;
      return o;
    };
    const visit = (n, parent, top) => {
      if (budget <= 0) return;
      if (n.nodeType === 3) { const t = text(n.data); if (t) emit(n, 'StaticText', t, parent); return; }
      if (n.nodeType !== 1) return;
      const el = n, t = el.localName;
      if (!top) {
        if (SKIP.has(t) || (t === 'input' && inputType(el) === 'hidden') || el.getAttribute('aria-hidden') === 'true') return;
        const s = style(el); if (s.display === 'none' || s.visibility === 'hidden') return;
      }
      const r = top && el === rootEl ? 'RootWebArea' : role(el);
      const nm = r === 'RootWebArea' ? text(document.title) : name(el, r);
      const o = emit(el, r, nm, parent);
      if (isPassword(el)) { passwords.push(o.backendDOMNodeId); return; } // no value, and nothing under it is read
      const v = r === 'RootWebArea' ? '' : value(el);
      if (v) o.value = { value: v.slice(0, 500) };
      const d = text(el.getAttribute('aria-description')) || (text(el.getAttribute('title')) !== nm ? text(el.getAttribute('title')) : '');
      if (d) o.description = { value: d.slice(0, 300) };
      const p = props(el, r, act); if (p.length) o.properties = p;
      if (LEAF.has(t)) return;
      for (const k of kids(el)) visit(k, o, false);
    };
    visit(A.root == null ? rootEl : node(A.root), null, true);
    return { nodes, passwords };
  };
  // The centre of a ref's box, after scrolling it into view.
  H.point = (A) => {
    const n = node(A.ref);
    elOf(n).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const b = shown(n, A.ref);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };
  const NOTEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);
  const takesText = (e) => !!e && (e.isContentEditable ||
    ((e.localName === 'textarea' || (e.localName === 'input' && !NOTEXT.has(inputType(e)))) && !e.readOnly && !e.disabled));
  // execCommand fires trusted beforeinput and input events and never touches the clipboard.
  H.type = (A) => {
    const noText = 'the focused element does not take text; pass the ref of a text field';
    let el = null;
    if (A.ref != null) {
      el = elOf(node(A.ref));
      const before = deepActive().el;
      el.focus();
      if (deepActive().el === before && before !== el && el.isContentEditable) {
        // A part of a contenteditable takes no focus: focus its editing host, the caret at the end of the part.
        let h = el; while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
        h.focus();
        const s = el.ownerDocument.getSelection(), r = el.ownerDocument.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r);
      } else if (before !== el && !A.clear && (el.localName === 'input' || el.localName === 'textarea')) { try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {} }
      // Focus that did not move to the ref would type into whatever had it before.
      const a = deepActive().el, inside = a === el || el.contains(a) || (el.shadowRoot && el.shadowRoot.contains(a)) || (el.isContentEditable && a.contains(el));
      if (a === before && !inside) fail(noText);
    }
    const a = deepActive();
    if (!takesText(a.el)) fail(noText); // the selection may sit elsewhere than the focus: execCommand would type there
    if (A.clear) {
      const t = el && el.isContentEditable ? el : a.el;
      if (t.localName === 'input' || t.localName === 'textarea') t.select();
      else { const s = a.doc.getSelection(), r = a.doc.createRange(); r.selectNodeContents(t); s.removeAllRanges(); s.addRange(r); }
      a.doc.execCommand('delete');
    }
    if (!a.doc.execCommand('insertText', false, A.text)) fail(noText);
    return {};
  };
  H.form = (A) => (FORM_JS).call(elOf(node(A.ref)), A.value);
  const scrollable = (e, dx, dy) => {
    if (e === e.ownerDocument.scrollingElement || e === e.ownerDocument.body) return false;
    const s = style(e), on = (o) => /(auto|scroll|overlay)/.test(o);
    return (dy && on(s.overflowY) && e.scrollHeight > e.clientHeight) || (dx && on(s.overflowX) && e.scrollWidth > e.clientWidth);
  };
  // shortcut: scrollBy, not wheel events, so a page that only listens to `wheel` does not see it; upgrade if agents need that.
  H.scroll = (A) => {
    const dx = A.dx || 0, dy = A.dy || 0;
    let t = null;
    if (A.ref != null) { const n = node(A.ref); t = elOf(n); t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); shown(n, A.ref); }
    if (dx || dy) {
      if (!t) {
        let x = A.x != null ? A.x : innerWidth / 2, y = A.y != null ? A.y : innerHeight / 2;
        t = document.elementFromPoint(x, y);
        while (t && (t.localName === 'iframe' || t.localName === 'frame')) {
          let cd = null; try { cd = t.contentDocument; } catch (e) {}
          if (!cd) break;
          const r = t.getBoundingClientRect(); x -= r.left + t.clientLeft; y -= r.top + t.clientTop;
          const i = cd.elementFromPoint(x, y); if (!i) break; t = i;
        }
      }
      let e = t;
      while (e && !scrollable(e, dx, dy)) e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null;
      if (e) e.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      else (t ? t.ownerDocument.defaultView : window).scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  };
  H.text = () => ({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' });
  return H;
})();
const H = globalThis.__herdr;
if (base > H.next) H.next = base;
try { const r = H[fn](A); r.next = H.next; return JSON.stringify(r); }
catch (e) { if (e && e.herdr) return JSON.stringify({ error: e.herdr, next: H.next }); throw e; }
"""#.replacingOccurrences(of: "FORM_JS", with: formJS)

// Sets a form field's value the way agent.rs did over CDP (moved here unchanged): React and friends see the change.
let formJS = #"""
function(v) {
  const el = this, tag = (el.tagName || '').toLowerCase();
  const fire = () => { el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); };
  if (tag === 'select') {
    const want = (Array.isArray(v) ? v : [v]).map(String);
    let hit = 0;
    for (const o of el.options) {
      const on = want.includes(o.value) || want.includes(o.text.trim());
      if (on) hit++;
      if (el.multiple) o.selected = on; else if (on) { o.selected = true; break; }
    }
    if (!hit) return {error: 'no option matches ' + JSON.stringify(v)};
    fire(); return {ok: true, kind: 'select', value: el.value};
  }
  if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
    el.checked = v === true || ['true', '1', 'on', 'yes', 'checked'].includes(String(v).toLowerCase());
    fire(); return {ok: true, kind: el.type, checked: el.checked};
  }
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    fire(); return {ok: true, kind: tag === 'input' ? el.type : 'textarea'};
  }
  if (el.isContentEditable) { el.textContent = String(v); fire(); return {ok: true, kind: 'contenteditable'}; }
  return {error: 'not a form field: <' + tag + '>'};
}
"""#

// Page world, document start, every frame. Not seen: lines logged before document start, and workers.
let hooksScript = #"""
(function () {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.herdrLog;
  if (!h || window.__herdrHooked) return;
  Object.defineProperty(window, '__herdrHooked', { value: true });
  const post = h.postMessage.bind(h);
  const str = (x) => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return x.stack ? String(x) + '\n' + x.stack : String(x);
    try { const j = JSON.stringify(x); return j === undefined ? String(x) : j; } catch (e) { return String(x); }
  };
  const log = (level, text, source) => { try { post({ k: 'c', level, text: String(text).slice(0, 2048), source: source || '', time: Date.now() }); } catch (e) {} };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...a) { log(level, a.map(str).join(' ')); return orig.apply(this, a); };
  }
  addEventListener('error', (e) => { if (e instanceof ErrorEvent) log('exception', e.error ? str(e.error) : e.message, e.filename ? e.filename + ':' + e.lineno : ''); }, true);
  addEventListener('unhandledrejection', (e) => log('exception', 'Uncaught (in promise) ' + str(e.reason)));
  const net = (method, url, status, type, failed) => { try { post({ k: 'n', method, url: String(url).slice(0, 2048), status, type, failed }); } catch (e) {} };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };
  const of = window.fetch;
  if (of) window.fetch = function (input, init) {
    let method = 'GET', url = '';
    try {
      method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      url = abs(input && typeof input === 'object' && input.url ? input.url : input);
    } catch (e) {}
    const p = of.apply(this, arguments);
    p.then((r) => net(method, r.url || url, r.status, 'fetch', null), (e) => net(method, url, null, 'fetch', String((e && e.message) || e)));
    return p;
  };
  const X = XMLHttpRequest.prototype, oo = X.open, os = X.send, info = new WeakMap();
  X.open = function (m, u) { info.set(this, { method: String(m).toUpperCase(), url: abs(u) }); return oo.apply(this, arguments); };
  X.send = function () {
    const i = info.get(this);
    if (i) {
      let failed = null;
      for (const k of ['error', 'abort', 'timeout']) this.addEventListener(k, () => { failed = k; });
      this.addEventListener('loadend', () => net(i.method, this.responseURL || i.url, failed ? null : this.status, 'xmlhttprequest', failed));
    }
    return os.apply(this, arguments);
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') net(null, e.name, null, e.initiatorType, null);
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}
})();
"""#
