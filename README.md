# herdr-mods

Mods for [Herdr](https://github.com/herdrdev/herdr-app) that install into the stock app.

| Mod | What it does |
|---|---|
| [ios-sim](ios-sim/README.md) | A live iOS Simulator docked on the right of the Herdr window, with touch, keys, hardware buttons, rotation and an annotate mode that turns picked screen elements into a prompt for your coding agent. |
| [browser](browser/README.md) | A browser panel with a real native WebKit view (or a headless-Chrome stream) docked in the Herdr window: tabs, element select that copies XML for your coding agent, and Chrome sign-in import. |

## Install with your AI agent

Paste one of these into the coding agent running in Herdr (Claude Code, Codex, or similar). It reads
Herdr's own mod guide first, then follows the mod's `RECIPE.md`:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/ledei/herdr-mods/tree/main/browser
```

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/ledei/herdr-mods/tree/main/ios-sim
```

Or install by hand, below.

## Requirements (ios-sim)

- macOS 15 or later (the helper's minimum). Tested on macOS 26.6 with Xcode 27.0 and an iOS 26.4
  simulator; older versions are untested.
- Xcode with its iOS simulators (not only the Command Line Tools). The helper is built with Xcode's Swift.
- Network access for the first build. Swift Package Manager fetches FBSimulatorControl 1.7.8
  (Meta's [idb](https://github.com/facebook/idb) frameworks, from the `facebook/homebrew-fb`
  package, MIT-licensed). You don't need Homebrew itself.

## Install by hand

```sh
git clone https://github.com/ledei/herdr-mods.git
cd herdr-mods
./install.sh browser    # or: ./install.sh ios-sim
```

`install.sh <mod> [--home DIR]` installs into your Herdr home: `--home`, else `$HERDR_APP_HOME`,
else `~/.config/herdr-app`. It copies the mod into `<home>/mods/<mod>`. For ios-sim it also
builds the `herdr-sim` helper and installs it in `<home>/bin`, and adds the `ios-sim` layout to
`<home>/layouts`. For browser it installs three mods, builds `herdr-web` (needs `swiftc`) and, if Rust is installed, `herdr-browser`. A layout you already have is never replaced (the script says what it
skipped), and none of your files are deleted. Run it again after a `git pull` to update: it
overwrites the installed mod's files, and names each one that differed, so keep your own
changes to a mod elsewhere.

Then see the mod's README ([ios-sim](ios-sim/README.md), [browser](browser/README.md)) for how to open and use it.

## Trade-offs of the stock version

Stock Herdr's mod API can't draw another app's live video, so the simulator screen is a separate
borderless window, kept over an empty area the mod draws. That costs a few things:

- Herdr's menus, dialogs and toasts draw under the simulator screen where they overlap it.
- Switching to Herdr from another app can show the screen a frame late (a brief flash).
- Docked only: the block sits on the right edge of the window. Floating windows and panes inside
  tabs aren't supported.
- The helper uses private macOS and Xcode frameworks (CoreSimulator through
  FBSimulatorControl). An Xcode update can break it until you reinstall.
- Mission Control and screen sharing show the screen as its own window.

## Faster, fully integrated version

The [ios-sim branch of ledei/herdr-app](https://github.com/ledei/herdr-app/tree/ios-sim) is a
patched Herdr that draws the simulator inside its own renderer: no separate window, no flash,
menus draw on top, and the panel can float or sit in a tab. It uses the same helper:

```sh
git clone -b ios-sim https://github.com/ledei/herdr-app.git
cd herdr-app
cargo build --release
```

Then run `./install.sh ios-sim` from this repository. If that build has run once, the script sees
that your Herdr ships its own ios-sim mod, keeps it, and installs only the helper in
`<home>/bin/herdr-sim`, where Herdr finds it. If it hasn't, the script installs the stock mod
too; the patched build then installs its own on first start and keeps the stock one as an
edited copy, which you can delete.

## License

Apache-2.0, the same as Herdr. See [LICENSE](LICENSE).
