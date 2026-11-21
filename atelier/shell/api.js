// Every call to atelierd. The URL hash holds only the canvas and board (#canvas=…[&board=…]) and stays, so a reload
// opens the same canvas. The token comes from the mod through window.__atelierInit(token) (main.js) and is kept in
// this module only: never in a URL, the DOM, a global, storage or a log. The event stream is read with fetch, so it
// can send the token as a header too.
const hash = new URLSearchParams(location.hash.slice(1));
let token = null;

export const params = { canvas: hash.get('canvas') || null, board: hash.get('board') || null };
export const setToken = (t) => { token = t; };

const call = (method, path, body) => fetch(path, {
  method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function json(method, path, body) {
  const r = await call(method, path, body);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `${method} ${path.split('?')[0]}: ${r.status}`), { status: r.status });
  return j;
}

/** A board's snapshot as a Blob, or null while atelierd renders it (an SSE {type:"thumb"} follows). */
export async function thumb(canvas, board) {
  const r = await call('GET', `/__atelier/thumb?canvas=${encodeURIComponent(canvas)}&board=${encodeURIComponent(board)}`);
  if (r.status === 200) return r.blob();
  if (r.status === 202) return null;
  throw new Error(`thumb ${r.status}`);
}

/** The shell's event stream (role=shell: atelierd counts the shell as open while it is connected), reconnected 1 s
 *  after it drops. onReopen: after a dropped stream came back, when events may have been missed. */
export function events(canvas, onEvent, onReopen) {
  let opened = false;
  (async () => {
    for (;;) {
      try {
        const r = await call('GET', `/__atelier/events?role=shell&canvas=${encodeURIComponent(canvas)}`);
        if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
        if (opened) onReopen(); else opened = true;
        const read = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await read.read();
          if (done) break;
          buf += value;
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(i + 2);
            let ev; try { ev = JSON.parse(data.slice(6)); } catch { continue; }
            onEvent(ev);
          }
        }
      } catch { /* dropped or refused: try again */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}
