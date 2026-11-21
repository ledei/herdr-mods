// Pan and zoom: one transform on the board layer, written once per frame; --s (the zoom) only when it changed, so
// panning never restyles or lays out anything. Two-finger scroll pans; pinch or ⌘/ctrl+wheel zooms (Chrome sends
// pinch as ctrl+wheel, WebKit as gesture events). Zoom 10%-200%.
const MIN = 0.1, MAX = 2;
const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

/** onMove(): any move, as it is asked for; onZoom(s): a frame applied a new zoom; onSettle(): 140 ms after the last move. */
export function createCamera(view, layer, { onMove, onZoom, onSettle }) {
  let s = 1, tx = 0, ty = 0, shownS = null, raf = 0, settle = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function apply() {
    onMove();
    layer.classList.add('moving');
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      layer.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      if (s !== shownS) { layer.style.setProperty('--s', s); layer.classList.toggle('far', s < 0.2); shownS = s; onZoom(s); }
    });
    clearTimeout(settle);
    settle = setTimeout(() => { layer.classList.remove('moving', 'anim'); onSettle(); }, 140);
  }
  function zoomAt(factor, cx, cy) {
    const n = clamp(s * factor);
    tx = cx - (cx - tx) * (n / s); ty = cy - (cy - ty) * (n / s); s = n;
    apply();
  }
  const pan = (dx, dy) => { tx += dx; ty += dy; apply(); };
  // Shows rect {x,y,w,h} (canvas px) with pad px around it (top px above); zoom at most `most`. Animated only for an
  // explicit fit.
  function fit(rect, { pad = 48, top = pad, bottom = 80, most = 1, animate = false } = {}) {
    const W = view.clientWidth, H = view.clientHeight;
    s = clamp(Math.min((W - pad * 2) / Math.max(rect.w, 1), (H - top - bottom) / Math.max(rect.h, 1), most));
    tx = Math.round((W - rect.w * s) / 2 - rect.x * s);
    ty = Math.round(top + Math.max(0, (H - top - bottom - rect.h * s) / 2) - rect.y * s);
    layer.classList.toggle('anim', animate && !reduced.matches);
    apply();
  }

  let held = false; // hold(true): the person can neither pan nor zoom; fit and set still move it (Play full screen)
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (held) return;
    layer.classList.remove('anim');
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else pan(-e.deltaX, -e.deltaY);
  }, { passive: false });
  let g0 = 1;
  view.addEventListener('gesturestart', (e) => { e.preventDefault(); g0 = s; });
  view.addEventListener('gesturechange', (e) => { e.preventDefault(); if (!held) zoomAt((g0 * e.scale) / s, e.clientX, e.clientY); });
  view.addEventListener('gestureend', (e) => e.preventDefault());

  return {
    pan, zoomAt, fit, hold: (on) => { held = on; },
    get: () => ({ s, tx, ty }),
    set: (v) => { ({ s, tx, ty } = v); apply(); },
    size: () => ({ W: view.clientWidth, H: view.clientHeight }),
  };
}
