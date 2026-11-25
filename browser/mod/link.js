// A Cmd-click on a localhost link in a terminal opens it in the browser panel, like an in-app preview.
// Other URLs, and layouts without the panel, pass to the next handler (the system browser).
import { layout, run, setShared } from "herdr";

const has = (n, id) => Boolean(n && (n.id === id || (n.children ?? []).some((c) => has(c, id))));

export function handleLink({ link }) {
  if (link.kind !== "url" || !has(layout(), "browser")) return "pass";
  setShared("herdr-browser.open", { url: link.url, at: Date.now() }); // main.js opens it on its next tick
  run("layout.select", { stack: "panel-body", child: "browser" });
  run("layout.show", { id: "panel" });
  return "handled";
}
