# atelier

Live design canvases inside Herdr. A canvas is a folder with `canvas.json` and one `.dc.html` file per board, the
format Claude Design uses. Atelier shows it in a side panel next to your coding agent's chat, and the agent edits it
through Atelier's MCP tools while you watch.

- Pan and zoom the canvas, open pages, select elements or whole boards.
- Pin comments on an element; your agent reads them and answers in the thread.
- **Play**: the ▷ PLAY pill on a board's name strip clicks through it as a live prototype, on the canvas or full screen.
- Variants of a board, side by side, and a copy of the whole canvas to try things in.
- Send: the composer sends a message, the selection and screenshots to the agent in the current space.

## Requirements

- macOS, with `swiftc` (Xcode or the Command Line Tools). The canvas is a native WebKit view built from
  `helpers/web/main.swift`.
- Node 22 or later on your `PATH` (the server, `atelierd`, has no dependencies).
- **The board runtime.** Boards load `./support.js`, which is Claude Design's `dc-runtime.js`. This repository does
  not include it. Point the installer at your copy: `ATELIER_RUNTIME=/path/to/dc-runtime.js ./install.sh atelier`,
  or put it at `atelier/vendor/runtime/support.js` (gitignored). Without it the panel opens but boards don't render.

## Install

```sh
./install.sh atelier
```

It installs the `atelier` and `tabs-atelier` mods, builds `atelier-web` into `<home>/bin`, copies the server, canvas
UI and runtime into `<home>/atelier`, and adds the `atelier` layout if you don't have one. Run it again after a
`git pull` to update.

## Open it

- Switch to the layout: `herdr-app do layout.switch '{"name":"atelier"}'`, or pick **atelier** in Herdr's layouts.
  Its tab bar has an **Atelier** pill at the top right, beside Files and Changes.
- In the panel, **Open a canvas** and pick the canvas folder.
- A board that uses a design system reads it from `<canvas>/ds/<namespace>/`; a canvas without one falls back to
  `<home>/data/atelier/ds/`.

To keep your own layout and add the pill to it instead, give its tab bar block `"content": {"mod": "tabs-atelier",
"props": {"start": "none"}}` and add `{"id": "atelier", "type": "block", "content": {"mod": "atelier"}}` to its
`panel-body` stack. `start: "none"` keeps spaces from opening on Atelier until you pick it.

## Connect your agents

```sh
node atelier/bin/atelier-register.mjs install --real
```

It adds the `atelier` MCP server and the Atelier skill to Claude Code (`~/.claude.json`, `~/.claude/`), Codex
(`~/.codex/`) and opencode (`~/.config/opencode/`), plus two Claude Code hooks: one gives the agent what you see in
Atelier with each prompt, one warns it when it edits a board outside the part you locked. Every file it changes is backed up first (`*.bak-atelier-*`).
`--only claude,codex,opencode` picks agents; without `--real` it refuses your real config folders. Restart running
agents afterwards. The MCP server runs from this clone, so keep it where it is.

Undo with `node atelier/bin/atelier-register.mjs uninstall --real`.

## Remove

Delete `<home>/mods/atelier`, `<home>/mods/tabs-atelier`, `<home>/layouts/atelier.json`, `<home>/atelier`,
`<home>/bin/atelier-web` and, with your settings and comments' state, `<home>/data/atelier`.

## Trade-offs

The canvas is a native WebKit view in its own borderless window, kept over the panel, as in
[ios-sim](../ios-sim/README.md): Herdr's menus and toasts draw under it where they overlap, and all canvas controls
live inside the page.
