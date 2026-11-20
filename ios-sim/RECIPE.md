# Recipe: add the iOS Simulator mod to Herdr

For a coding agent. Read `~/.config/herdr-app/AGENTS.md` first (Herdr's own mod guide), then follow this.
macOS 15 or later with full Xcode (not only the Command Line Tools) and network access for the first build.
Do not delete or replace any file the user already has.

1. Check: `xcrun --find swift` and `xcrun simctl help` succeed. If not, tell the user to install Xcode and open it once.
2. `git clone https://github.com/ledei/herdr-mods.git` into a scratch folder, then run `./install.sh ios-sim`
   from it. It installs the mod, builds the `herdr-sim` helper into `~/.config/herdr-app/bin/`, and adds the
   `ios-sim` layout if none exists.
3. Run `herdr-app check ~/.config/herdr-app/mods/ios-sim`; it must print `check passed`.
4. Tell the user to restart Herdr and open the `ios-sim` layout. Usage is in `ios-sim/README.md`.

Report what was installed and the output of the check.
