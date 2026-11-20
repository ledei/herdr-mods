# browser

A browser panel for Herdr, with two ways to show the page:

- **Native** (default): the `herdr-web` helper shows a real WebKit view in its own borderless window, kept
  exactly over the panel's page area. Scrolling, clicks and keys go straight to it, so it feels like any Mac
  app. The mod keeps the toolbar and tabs.
- **Stream**: the `herdr-browser` helper runs headless Chrome and the panel draws its JPEG frames. Slower
  and laggier, but an AI agent can drive the same tab over MCP (see `herdr-browser --help`).

The **Stream** / **Native** pill in the toolbar switches between them.

## Install

```sh
./install.sh browser
```

It installs the `browser`, `browser-import` and `tabs-browser` mods, builds `herdr-web` (needs `swiftc`,
from Xcode or the Command Line Tools) and, if `cargo` is installed, `herdr-browser`, then adds the
`browser` layout. A layout you already have is kept. Open the layout, or its **Browser** pill in the
`tabs-browser` tab bar.

## Use

- Move the pointer over the page once after opening the panel: the mod learns where the page area is from
  a mouse event.
- Address bar, back, forward, reload and tabs are in the panel. Shortcuts while the page has the
  keyboard: cmd-R and shift-cmd-R (reload, ignoring the cache), cmd-[ and cmd-] (history), cmd-T, cmd-W,
  cmd-L and cmd-1 to cmd-9; cmd-C, V, X, A and Z work in the page.
- **Select** picks an element on the page and copies it as XML (tag, box, text, styles, ancestors, HTML and a
  screenshot path) to paste into an agent's chat.
- **Sign-ins** copies the sign-ins of sites you pick from one of your Chrome profiles into the view. It
  reads Chrome's cookie file and needs its Keychain key: macOS asks once (choose Always Allow to stop the
  prompt). It needs the Chrome helper (`cargo`).

## Trade-offs

The native view is a separate window over a hole the panel leaves, as in [ios-sim](../ios-sim/README.md):

- Herdr's menus, popups and toasts draw under the page where they overlap it. The Sign-ins dialog hides the
  page while it is open.
- A window of another app that covers a whole edge strip of the page trims the page; a window over a corner
  or the middle sits above it.
- The native view has its own cookie store. Chrome sign-in import, Select for agents and the MCP tools
  belong to Stream mode.
- Docked only: floating windows and panes inside tabs are not supported.

## How it works

`herdr-web` (`helpers/web/main.swift`) listens on 127.0.0.1 and writes `<home>/data/herdr-web/port-<pid>`
(`<port>\n<token>`, mode 0600), one per Herdr process. The first line from the mod is
`{"op":"hello","token":…}`; lines are JSON. The mod sends `rect` (the page area in window units plus the
window size) and `lease` every 250 ms while the panel draws: without a lease the window hides. It also sends
`tab`, `select`, `close`, `go`, `back`, `forward`, `reload`, `reloadHard`, `pick`, `theme` and `cookies`.
The helper answers with `tab` (url, title, loading, history state, active), `key` (shortcuts it took),
`picked` and `cookies`. It places its window above Herdr's with
`order(.above, relativeTo:)` and follows Herdr's window from `CGWindowListCopyWindowInfo`. It exits when
Herdr does.
