// The only writer of data/atelier/atelier.log: sessions, canvas opens, sends. From herdr-figcraft-atelier.
// Lines are stamped when logged and appended (O_APPEND) in batches, so copies never overwrite each other.
// Never log the token, page URLs, message text or config values: ids, paths and counts only.
import { exec, appHome, checking } from "herdr";

// Module state is shared by every copy. A copy closed under its flush leaves that exec unsettled for good, so a flush
// older than STUCK_MS no longer blocks the next one (its batch is lost; the queue was taken before the await).
const STUCK_MS = 2000;
let queue = [];
let flushing = null; // {since} while a flush runs

export const logPath = () => `${appHome()}/data/atelier/atelier.log`;

export function log(line) {
  if (checking()) return;
  queue.push(`${new Date().toISOString()} ${line}\n`);
  if (!flushing || Date.now() - flushing.since > STUCK_MS) flush();
}

// shortcut: no rotation; the log grows until a manual delete.
async function flush() {
  const mine = (flushing = { since: Date.now() });
  try {
    while (queue.length && flushing === mine) {
      const text = queue.join("");
      queue = [];
      mine.since = Date.now();
      await exec("/bin/sh", ["-c", 'mkdir -p "${0%/*}" && printf %s "$1" >> "$0"', logPath(), text], { timeout: 5000 }).catch(() => {});
    }
  } finally {
    if (flushing === mine) flushing = null;
  }
}
