# Recipe: add the browser mod to Herdr

For a coding agent. Read `~/.config/herdr-app/AGENTS.md` first (Herdr's own mod guide), then follow this.
macOS only. Do not delete or replace any file the user already has: a layout that exists stays as it is.

1. Check the tools: `xcrun --find swiftc` must succeed (else tell the user to run `xcode-select --install`).
   `cargo` is optional; without it the agent tools and Sign-ins are skipped (importing Sign-ins also needs Chrome).
2. Get the source: `git clone https://github.com/ledei/herdr-mods.git` into a scratch folder (not into the Herdr home).
3. Run `./install.sh browser` from that clone. It installs the `browser`, `browser-import` and `tabs-browser`
   mods into `~/.config/herdr-app/mods/`, builds `herdr-web` (and `herdr-browser` if cargo exists) into
   `~/.config/herdr-app/bin/`, and adds `layouts/browser.json` if the user has no layout of that name.
   Herdr's home is `$HERDR_APP_HOME` if set.
4. Validate: `herdr-app check ~/.config/herdr-app/mods/browser` and the same for `browser-import`.
   Both must print `check passed`.
5. Tell the user to restart Herdr, then open the `browser` layout or the **Browser** pill, and move the
   pointer over the page once. Features and limits are in `browser/README.md`.

Report what was installed, what was skipped (and why), and the output of the checks.
