// The only writer of data/atelier/settings.json: {canvas, board, recent, agent}. From herdr-figcraft-atelier.
// Merge-on-write: re-read, merge the patch, write only if the file is still what was read.
import { readTextFile, writeTextFile, appHome } from "herdr";
import { log } from "./log.js";

const path = () => `${appHome()}/data/atelier/settings.json`;

const parse = (text) => {
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    log("settings.json unreadable, starting from {}");
    return {};
  }
};

export async function readSettings() {
  return parse(await readTextFile(path()));
}

/** Merges `patch` into settings.json and returns the new settings. Retries when another write won. */
export async function updateSettings(patch) {
  for (let attempt = 0; ; attempt++) {
    const before = await readTextFile(path());
    const next = { ...parse(before), ...patch };
    try {
      await writeTextFile(path(), `${JSON.stringify(next, null, 2)}\n`, before);
      return next;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}
