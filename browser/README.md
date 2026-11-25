# browser

A browser panel for Herdr. The `herdr-web` helper shows a real WebKit view in its own borderless window, kept
exactly over the panel's page area. Scrolling, clicks and keys go straight to it, so it feels like any Mac
app. The mod keeps the toolbar and tabs.

AI agents drive their own tabs in the same view through `herdr-browser`, an MCP server and CLI that talks to
`herdr-web` (see `herdr-browser --help`). You watch live and can still click and type. Each agent terminal
gets its own tab group; the panel shows the group of the agent in the Herdr tab you look at.

## Install

```sh
./install.sh browser
```

It installs the `browser`, `browser-import` and `tabs-browser` mods, builds `herdr-web` (needs `swiftc`,
from Xcode or the Command Line Tools) and, if `cargo` is installed, `herdr-browser` (the agent tools and Sign-ins), then adds the
`browser` layout. A layout you already have is kept. Open the layout, or its **Browser** pill in the
`tabs-browser` tab bar.

## Use

- **Open and close** with the **Browser** pill, the palette's "Toggle browser", or cmd-shift-b. For the key,
  add `"layout:browser": { "cmd-shift-b": "tabs-browser.browser" }` to `keys.json` (see `keys.json` here).
- The first time in a layout, move the pointer over the page once: the mod learns where the page area is from a
  mouse event, then remembers it for that layout.
- **Localhost links** (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`) that you Cmd-click in a terminal open in
  the panel, in a new tab unless the active one is empty. Other links go to your usual browser.
- Address bar, back, forward, reload and tabs are in the panel. Shortcuts while the page has the
  keyboard: cmd-R and shift-cmd-R (reload, ignoring the cache), cmd-[ and cmd-] (history), cmd-T, cmd-W,
  cmd-L and cmd-1 to cmd-9; cmd-C, V, X, A and Z work in the page.
- **Select** picks elements on the page. Each one is pasted as XML (tag, box, text, styles, ancestors, HTML and a
  screenshot path) into the focused terminal, without Enter, and Select stays on: pick several, then write
  your message to the agent and send it. Esc or Select again stops.
- **Sign-ins** copies the sign-ins of sites you pick from one of your Chrome profiles into the view. It
  reads Chrome's cookie file and needs its Keychain key: macOS asks once (choose Always Allow to stop the
  prompt). It needs `herdr-browser` (`cargo`) and Chrome, and only for importing.

## Trade-offs

The native view is a separate window over a hole the panel leaves, as in [ios-sim](../ios-sim/README.md):

- Herdr's menus, popups and toasts draw under the page where they overlap it. The Sign-ins dialog hides the
  page while it is open.
- A window of another app that covers a whole edge strip of the page trims the page; a window over a corner
  or the middle sits above it.
- The native view has its own cookie store, kept between runs. Sign-ins copied from Chrome land there, and
  every agent's tab group shares it.
- Docked only: floating windows and panes inside tabs are not supported.

## How it works

`herdr-web` (`helpers/web/`, protocol in `helpers/web/PROTOCOL.md`) listens on 127.0.0.1 and writes `<home>/data/herdr-web/port-<pid>`
(`<port>\n<token>`, mode 0600), one per Herdr process. The first line from the mod is
`{"op":"hello","token":…,"v":2,"role":"panel"}`; lines are JSON. Agents connect the same way with
`role:"agent"` (the `herdr-browser` front) and the cookie import with `role:"cookies"`. The mod sends `rect` (the page area in window units plus the
window size) and `lease` every 250 ms while the panel is open (from the layout, so a skipped frame does not count as closed): without a lease for 3 s the window hides. It also sends
`tab`, `select`, `close`, `go`, `back`, `forward`, `reload`, `reloadHard`, `pick`, `theme` and `cookies`.
The helper answers with `tab` (url, title, loading, history state, active), `key` (shortcuts it took),
`picked` and `cookies`. It places its window above Herdr's with
`order(.above, relativeTo:)` and follows Herdr's window from `CGWindowListCopyWindowInfo`. It exits when
Herdr does.
