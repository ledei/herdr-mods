# iOS Simulator for Herdr

A live iOS Simulator docked on the right of the Herdr window: a drawn iPhone with its side
buttons, a toolbar (device picker, Home, Rotate, Annotate, Close), and an annotate mode that
turns picked screen elements into a prompt for your coding agent. It works with stock Herdr; no
patched build is needed.

## How it works

Herdr's mod API can't draw another app's live video, so the work is split in two:

- `mod/` is a Herdr mod. It draws the phone frame and the toolbar, and leaves the screen area
  empty.
- `helper/` builds `herdr-sim`, a small macOS program. It shows the simulator's screen in its
  own borderless window and keeps that window exactly over the empty screen area, following
  the Herdr window as it moves and resizes. Clicks, drags and trackpad scrolls
  on that window go straight to the simulator as touches.

The mod starts the helper when the block is shown and talks to it over a local TCP
connection (127.0.0.1 only, with a per-run token in an owner-only file). The helper exits
when Herdr quits, when you close the block, or 10 seconds after its last connection closes.

## Install

From the repository root:

```sh
./install.sh ios-sim
```

This copies the mod to `~/.config/herdr-app/mods/ios-sim`, builds and installs the helper as
`~/.config/herdr-app/bin/herdr-sim`, and adds the `ios-sim` layout (Herdr's main layout with
the simulator docked on the right). It never replaces a layout you already have.

## Use

1. Switch to the layout: Cmd+Shift+L until it shows, the command palette's `layout.switch`,
   or Settings. The simulator block is on the right.
2. Pick a device in the toolbar menu. A shut-down device boots when you pick it.
3. Click and drag on the screen to touch it. Click the phone frame first to type into the
   simulator with the keyboard.

Close hides the block and stops the helper. To show it again, run `layout.toggle` with id
`ios-sim` from the command palette, or bind a key in `~/.config/herdr-app/keys.json`:

```json
"layout:ios-sim": {
  "cmd-shift-i": { "command": "layout.toggle", "args": { "id": "ios-sim" } }
}
```

Editing `keys.json` makes it yours: Herdr stops upgrading its default shortcuts in that file.

### Keys

While the block has the keyboard (click the phone frame or the toolbar):

| Key | Does |
|---|---|
| Cmd+Shift+H | Home |
| Cmd+Right | Rotate right |
| Esc | Stop annotating, close the device menu |
| Letters, digits, punctuation, Return, Tab, arrows, Delete | Type into the simulator (US layout) |

Cmd, Ctrl and Option combinations stay with Herdr.

The mod also takes these commands, for key bindings or `herdr-app do`: `ios-sim.home`,
`ios-sim.rotate`, `ios-sim.annotate`, `ios-sim.devices` (open or close the device menu),
`ios-sim.add` (add the picks to the focused agent's prompt) and `ios-sim.close`.

### Annotate

Turn on Annotate in the toolbar. Taps stop reaching the app: the helper outlines the element
under the pointer, and a click picks it. Each pick gets a row with a note field. "Add to
<agent> prompt" puts this into the focused agent's prompt without sending it:

```
Simulator: iPhone 16, iOS 26.4
1. Button "About" (general.about)
   frame 12,280 288×38 pt
   note: rename to "About this iPhone"
   image: ~/Library/Caches/herdr-sim/<session>/pick-1.png
```

Stock Herdr has no command to type text into a terminal without Enter, so the button puts the
text on the clipboard and runs Herdr's own `terminal.paste` on the agent's pane. Agents turn on
bracketed paste, so the newlines don't send it: edit it, then press Return. The text stays on
your clipboard (a toast says so). The button only works when the focused pane runs an agent,
because a plain shell without bracketed paste would run each line.

## Limits

- Docked only: the block must stay the last block of the layout's root row, flush with the
  window's right and bottom edges. Floating windows and panes inside tabs aren't supported.
- If the block is wider than the window has room for (a narrow window, or the block resized
  past it), it runs off the right edge and the screen shows in the wrong place. Narrow the
  block or widen the window.
- Herdr's menus, dialogs and toasts draw under the simulator screen where they overlap it.
  The mod's own device menu hides the screen while it is open.
- Switching to Herdr from another app can show the screen a frame late (a brief flash).
- The screen is a separate window: Mission Control and screen sharing show it as one.
- The helper uses private macOS and Xcode frameworks (CoreSimulator through
  FBSimulatorControl); an Xcode update can break it until the helper is rebuilt.
- While the screen shows, the mod redraws its block four times a second: that is how the
  helper learns the block is really on screen (a hidden block doesn't draw).
- Keyboard input needs the block to have the keyboard, which a click on the simulator screen
  doesn't give it (that click goes to the helper's window).
