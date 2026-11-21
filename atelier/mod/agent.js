// The agent a Send goes to: sanitizer, the send queue, and the picker over agents(). From herdr-figcraft-atelier (T5).
// `setup(app)` adds:
//   app.agent.list()            the agents in the shown space, one per program: [{key, name, address, status}]
//   app.agent.target()          the one the person picked (settings.json), else the first listed; null when none
//   app.agent.pick(key, cx)     picks and saves
//   app.agent.send(text, cx)    resolves "sent" | "queued"; throws "No agent in this space"
//   app.agent.queued(address)   true while a message waits for that agent
// Text from the strip or the shell goes through sanitize() before it gets near here; send() takes finished text.
import { hc, agents, spaces, checking } from "herdr";
import { log } from "./log.js";
import { readSettings, updateSettings } from "./settings.js";

// ---- text from a design file is untrusted: one clean line, capped, in a fixed frame ----

const BLANKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
// C0 and C1 controls, zero-width and bidi controls (U+200B-200F, 202A-202E, 2060-206F), U+061C, BOM.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const MAX_NAME = 200;

/** `text` as one line a terminal can't misread: line breaks become blanks, controls go, the quote that would close the
 *  frame becomes ', and anything past `max` characters is cut with an ellipsis. */
export function sanitize(text, max = MAX_NAME) {
  const clean = String(text).replace(BLANKS, " ").replace(HIDDEN, "").replaceAll('"', "'").replace(/ +/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

// ---- attachments (T12): marked screenshots and recordings, named in the message ----

const MAX_ATTACH = 8;
const BOARD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html$/;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html#\d{1,4}(?::\d{1,2}(?:\/\d{1,2}){0,8})?(?:@\d{1,3})?$/;
const ROLES = { png: "", filmstrip: "filmstrip ", events: "events ", video: "video ", gif: "gif " };
const SHOT_NAME = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/; // what atelierd names under shots/: no blanks, no brackets
// A part starts with "[Atelier]" and a label sits in ( ): text from a board or a folder name gets look-alikes for both,
// so it can neither close its label nor start a part of its own.
const inert = (text, max) => sanitize(text, max).replace(/[()[\]]/g, (c) => ("([".includes(c) ? "‹" : "›"));
const MARKER = /\[(\s*atelier\s*)\]/gi;
// The file paths go as they are (the agent opens them), so a canvas folder whose path has the marker sends no part.
const markedPath = (canvas) => !!canvas && String(canvas.path).search(MARKER) !== -1; // search ignores /g

/** One "[Atelier] <canvas> <board> …" part, or null when the attachment is not one atelierd made: a file outside
 *  <canvas>/.atelier/shots, a path the sanitizer would change, a bad board name. Anchors with a bad id are left out. */
function part(a, canvas) {
  if (markedPath(canvas)) return null;
  const shots = `${canvas.path}/.atelier/shots/`;
  if (!a || typeof a !== "object" || !BOARD_RE.test(a.board ?? "") || (a.kind !== "shot" && a.kind !== "rec")) return null;
  const files = (Array.isArray(a.files) ? a.files : []).filter((f) => Object.hasOwn(ROLES, f?.role) && typeof f.path === "string"
    && f.path.startsWith(shots) && SHOT_NAME.test(f.path.slice(shots.length)) && !f.path.split("/").includes("..") && sanitize(f.path, 1000) === f.path);
  if (!files.length) return null;
  const anchors = (Array.isArray(a.anchors) ? a.anchors : []).filter((x) => ID_RE.test(x?.id ?? "")).slice(0, 10)
    .map((x) => `${x.id}${inert(x.label ?? "", 60) ? ` (${inert(x.label, 60)})` : ""}`);
  const n = (v, unit) => (Number.isInteger(v) && v >= 0 && v < 100000 ? `${v} ${unit}` : null);
  const what = a.kind === "shot" ? "marked screenshot" : `recording${[n(a.seconds, "s"), n(a.frames, "frames")].filter(Boolean).join(", ").replace(/^./, " $&")}:`;
  return `[Atelier] ${inert(canvas.name, 80)} ${a.board} ${what} ${files.map((f) => ROLES[f.role] + f.path).join(", ")}${anchors.length ? ` on ${anchors.join(", ")}` : ""}`;
}

/** The message: the user's text, then one part per attachment. One line, as sanitize() gives every text (hc send
 *  pastes and presses Enter). The user's words stay, but a "[Atelier]" in them becomes "‹Atelier›": only a real part
 *  carries the marker. canvas: {name, path} of the canvas open in the panel, or null (then no attachment goes). */
export function compose(text, attachments, canvas, max = 4000) {
  const parts = canvas ? attachments.map((a) => part(a, canvas)).filter(Boolean) : [];
  return [sanitize(text ?? "", max).replace(MARKER, "‹$1›"), ...parts].filter(Boolean).join(" ");
}

// ---- the send queue: `--if idle`, never forced ----

// The app's "done" is an agent that finished while nobody looked; hc still calls it idle (checked: `--if idle` types), so it counts.
const isIdle = (status) => status === "idle" || status === "done";

/** deliver(address, text) resolves "sent" or "refused" (the agent was not idle after all) and throws when it can't send.
 *  statusOf(address) is the agent's status, null when it is gone. A send to a busy agent waits, and what waits for one
 *  agent goes out as one message when it turns idle. */
export function createQueue({ statusOf, deliver, onDrop = (_address, _why) => {} }) {
  const waiting = new Map(); // address -> texts, oldest first
  const flushing = new Set();
  let ticking = null;

  async function flush(address) {
    // A copy: send() appends to the waiting array while deliver() runs, and those texts must stay waiting.
    const texts = [...(waiting.get(address) ?? [])];
    if (!texts.length || flushing.has(address)) return;
    flushing.add(address);
    try {
      const outcome = await deliver(address, texts.join(" "));
      if (outcome !== "sent") return;
      const rest = (waiting.get(address) ?? []).slice(texts.length);
      if (rest.length) waiting.set(address, rest);
      else waiting.delete(address);
    } catch (e) {
      waiting.delete(address); // a send that fails outright is dropped, not retried forever
      throw e;
    } finally {
      flushing.delete(address);
    }
  }

  return {
    /** "sent" when it went out now, else "queued". */
    async send(address, text) {
      const texts = waiting.get(address) ?? [];
      if (!texts.includes(text)) texts.push(text);
      waiting.set(address, texts);
      if (isIdle(statusOf(address))) await flush(address);
      return waiting.has(address) ? "queued" : "sent";
    },
    /** Sends what waits for agents that are idle now; drops what waits for agents that are gone. */
    tick() {
      ticking ??= (async () => {
        for (const address of [...waiting.keys()]) {
          const status = statusOf(address);
          if (status === null) {
            waiting.delete(address);
            onDrop(address, "gone");
          } else if (isIdle(status)) {
            await flush(address).catch((e) => onDrop(address, e));
          }
        }
      })().finally(() => { ticking = null; });
      return ticking;
    },
    pending: (address) => waiting.get(address)?.length ?? 0,
    size: () => waiting.size,
  };
}

// ---- the picker, over agents() ----

/** hc send --if idle: pasted and submitted only when the agent is idle. A refusal (status_mismatch, or blocked on a
 *  dialog) types nothing and exits 10 / 9 with {"error": {"kind"}} on stdout (checked on hc in herdr-app 0.1.16). */
async function deliver(address, text) {
  const r = await hc(["send", "--json", "--if", "idle", address, text]);
  if (r.code === 0) return "sent";
  let kind;
  try {
    kind = JSON.parse(r.stdout).error?.kind;
  } catch {}
  if (kind === "status_mismatch" || kind === "blocked") return "refused";
  throw new Error(`hc send exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 120)}`);
}

export function setup(app) {
  let loop = false;
  const spaceAgents = () => {
    const space = spaces().find((s) => s.active);
    return space ? agents().filter((a) => a.space === space.id) : [];
  };
  const statusOf = (address) => agents().find((a) => a.address === address)?.status ?? null;
  const queue = createQueue({
    statusOf,
    deliver,
    onDrop: (address, why) => log(`send dropped address=${address} ${why instanceof Error ? why.message : why}`),
  });
  const saved = { key: null };
  if (!checking()) readSettings().then((s) => { saved.key = s.agent ?? null; }).catch(() => {});

  const list = () => {
    const best = new Map(); // one per program: the focused one, else the one that changed last
    for (const a of spaceAgents()) {
      const key = a.program.key, cur = best.get(key);
      if (!cur || (a.focused && !cur.focused) || (a.focused === cur.focused && a.seq > cur.seq)) best.set(key, a);
    }
    return [...best].map(([key, a]) => ({ key, name: a.program.name, address: a.address, status: a.status }));
  };
  const target = () => {
    const all = list();
    return all.find((a) => a.key === saved.key) ?? all[0] ?? null;
  };
  const pick = async (key, cx) => {
    saved.key = key;
    await updateSettings({ agent: key });
    cx?.notify();
  };

  let attached = []; // the shell's tray, as it last posted it; the next Send (strip or tray) takes it along
  app.agent = {
    list,
    target,
    pick,
    attach: (items) => { attached = Array.isArray(items) ? items : []; }, // whole: over MAX_ATTACH the Send refuses, nothing is dropped
    attached: () => attached,
    message: (text, canvas) => compose(text, attached, canvas),
    /** Why the Send stops, or null: an attachment compose would leave out, so a dropped one never reads as sent.
     *  {text, short}: short fits the strip's note (about 24 characters); the shell's tray shows text. */
    refusal: (canvas) => {
      if (attached.length > MAX_ATTACH) return { text: `Not sent: at most ${MAX_ATTACH} attachments go in one message, this has ${attached.length}`, short: `Max ${MAX_ATTACH} attachments` };
      if (attached.length && markedPath(canvas)) return { text: "Not sent: the canvas folder's path has [Atelier] in it; rename the folder to send attachments", short: "[Atelier] in folder name" };
      const bad = canvas ? attached.filter((a) => !part(a, canvas)).length : attached.length;
      return bad ? { text: `Not sent: ${bad} attachment${bad > 1 ? "s are" : " is"} not from this canvas`, short: `${bad} not from this canvas` } : null;
    },
    queued: (address) => queue.pending(address) > 0,
    async send(text, cx) {
      const to = target();
      if (!to) throw new Error("No agent in this space");
      const outcome = await queue.send(to.address, text);
      log(`send address=${to.address} ${outcome}`);
      if (outcome === "queued" && !loop && cx) {
        loop = true;
        cx.spawn(async (cx) => {
          while (queue.size()) {
            await cx.sleep(500);
            await queue.tick();
            cx.notify();
          }
          loop = false;
        });
      }
      return outcome;
    },
  };
}
