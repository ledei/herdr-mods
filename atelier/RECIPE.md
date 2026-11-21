# Recipe: add the atelier mod to Herdr

For a coding agent. Read `~/.config/herdr-app/AGENTS.md` first (Herdr's own mod guide), then follow this.
macOS only. Do not delete or replace any file the user already has: a layout that exists stays as it is.

1. Check the tools: `xcrun --find swiftc` must succeed (else tell the user to run `xcode-select --install`), and
   `node --version` must be 22 or later.
2. Ask the user where their copy of Claude Design's board runtime (`dc-runtime.js`) is. It is not in this repository.
   Without it the panel opens but boards don't render; go on if they have none and say so in the report.
3. Get the source: `git clone https://github.com/ledei/herdr-mods.git` into a lasting folder (not into the Herdr
   home): the agents' MCP server runs from it.
4. Run `ATELIER_RUNTIME=<that path> ./install.sh atelier` from the clone (leave out `ATELIER_RUNTIME` when there is
   none). Herdr's home is `$HERDR_APP_HOME` if set.
5. Validate: `herdr-app check ~/.config/herdr-app/mods/atelier` and the same for `tabs-atelier`. Both must print
   `check passed`.
6. Only if the user says yes, since it edits their agents' config files: `node atelier/bin/atelier-register.mjs install --real`.
7. Tell the user to restart Herdr, switch to the `atelier` layout, and open a canvas folder from the panel.

Report what was installed, what was skipped (and why), and the output of the checks.
