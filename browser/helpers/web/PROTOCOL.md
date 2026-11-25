# herdr-web wire protocol, v2

This file is the contract between the three parts of the herdr browser mod:

- **herdr-web** (`helpers/web/main.swift`) is the only browser. It owns every tab: the user's and every agent's.
- **herdr-browser** (`helpers/chrome`, Rust) is the MCP front (`mcp`, `call`) and the cookie CLI (`cookies`). It talks to herdr-web as a client.
- **The panel** (`mod/main.js`) is the Browser panel in Herdr. It talks to herdr-web as a client.

Words used below:

- "Swift" means herdr-web and "Rust" means herdr-browser.
- A **group** is a set of tabs: the user's (`"user"`) or one agent terminal's.
- The **shown group** is the group whose tabs the panel shows.
- The **lease** is live while a panel sent `rect` or `lease` in the last 3 s. The panel sends one every 250 ms and an explicit `hide` when it closes, so the margin only matters when Herdr stalls (it can skip about a second of frames). While no lease is live the helper ticks at 4 Hz instead of 60.

Anything this file does not fix is up to the implementer. If an implementer has to break a rule here, they report it; they do not quietly diverge.

## 1. Transport and discovery

### Transport
- The transport is TCP on 127.0.0.1, carrying one JSON object per line (UTF-8, `\n`-terminated) in both directions. Nothing changes from v1.
- Swift writes the port file once its listener is ready. The file holds `<port>\n<token>`: the token is 48 hex characters, the file mode is 0600 and the directory mode is 0700.
- The first line a client sends must be `hello` with the right token. Otherwise Swift closes the connection.
- Nobody ever prints or logs the token, or a cookie value.

### Files under `<app_home>/data/herdr-web/`
| file | written by | meaning |
|---|---|---|
| `port-<herdrPid>` | Swift | The live helper for that Herdr app process. `<herdrPid>` is the pid of the Herdr GUI, not of herdr-web. |
| `port-<herdrPid>.lock` | Swift | An exclusive `flock` that Swift holds for its whole life. |
| `helper-<herdrPid>.log` | whoever spawned it | herdr-web's stdout and stderr. |
| `selections/<ms>.png` | Swift | Element screenshots from Select element (as in v1). |

### One instance per Herdr pid
- At startup, Swift opens `<port-file>.lock` (O_CREAT, mode 0600) and takes `flock(LOCK_EX|LOCK_NB)`.
- If the lock fails, another herdr-web owns this pid. Swift prints `herdr-web: another instance owns <port-file>` and exits 0 before it opens a window or a listener.
- This settles the race between the panel's spawn (which runs `rm -f` on the port file first) and the front's spawn: the first process to get the lock wins.
- Once a second, in `tick`, Swift rewrites its port file if the file is missing. A panel that ran `rm -f` after the winner wrote the file then finds it again within about 1 s.
- Swift removes its port file before it exits. That happens when Herdr is gone (`kill(herdrPid,0) != 0`) and on `quit`. Swift removes the file only if it still holds Swift's own port and token.

### Command line
```
herdr-web --herdr-pid <pid> --port-file <path> [--ephemeral]
```
- `--ephemeral` makes every tab use `WKWebsiteDataStore.nonPersistent()`; without it, tabs use `.default()`, as in v1.
- Tests always pass `--ephemeral`.

### Discovery (Rust, `native.rs`)
Rust runs these steps once per request attempt, the way `Conn::request` reconnects today.

1. List `<app_home>/data/herdr-web/`. Keep only names that match `^port-[0-9]+$`; `.lock` and `.log` files are skipped.
2. Drop any file whose pid is not alive. A pid is alive when `kill(pid,0) == 0` or errno is `EPERM`.
3. Order the rest by file mtime, newest first. For each one:
   - read `port` and `token`;
   - connect with a 2 s timeout;
   - send the hello for its role (§2);
   - read lines for up to 3 s until one has `ev == "hello"`.
   The first helper whose hello reply has a number `v >= 2` is used, on that same connection.
4. If no helper qualified, but one that is alive answered a hello without `v`, return the error `herdr-web is an older version: close and reopen the Browser panel in Herdr to update it`. Rust does not spawn in this case.
5. If `HERDR_BROWSER_NO_SPAWN=1` is set, or the role is `cookies`, return the error `open the Browser panel in Herdr`. The cookie CLI never spawns.
6. Otherwise run `pgrep -x Herdr`. If it prints exactly one pid, spawn (below). If it prints none or several, return the error `open the Browser panel in Herdr`.

### Spawn by the front
- Rust runs `mkdir -p <dir>` with mode 0700.
- It does not remove any file. The lock decides which helper runs.
- It runs `<app_home>/bin/herdr-web --herdr-pid <pid> --port-file <dir>/port-<pid>`, and adds `--ephemeral` when `HERDR_WEB_EPHEMERAL=1` is set.
- The child's stdio:
  - stdin is `/dev/null`;
  - stdout and stderr are appended to `<dir>/helper-<pid>.log`;
  - the child runs in its own process group (`process_group(0)`) and is reaped in a thread.
  - Nothing is inherited, because an inherited stdout would corrupt the MCP stream.
- If `bin/herdr-web` is missing, return the error `herdr-web is not installed (run install-helpers.sh)`.
- Then Rust repeats step 3 for `port-<pid>` only, every 200 ms for up to 8 s.
- If no helper answers in that time, return the error `herdr-web did not start (see data/herdr-web/helper-<pid>.log)`.

A helper spawned by the front has no panel, so it shows no window. The panel adopts it later through its usual `nativeOpen`, because both use the same `port-<pid>`.

## 2. Hello, roles, envelopes

### The three hellos
| role | client sends (first line) | Swift replies (first line back) | then |
|---|---|---|---|
| panel, v2 | `{"op":"hello","token":T,"v":2,"role":"panel"}` | `{"ev":"hello","v":2,"role":"panel"}` | One `tab` event for every tab in every group, then one `groups` event. |
| panel, legacy | `{"op":"hello","token":T}`: `v` missing or below 2, and `role` missing or `"panel"` | `{"ev":"hello","v":2,"role":"panel"}` | `tab` events for user-group tabs only, now and later. It gets no `groups` event and no `selecting` event. |
| agent | `{"op":"hello","token":T,"v":2,"role":"agent","name":N,"group":G,"terminal":TERM\|null}` | `{"ev":"hello","v":2,"role":"agent","group":G}` | Only `res` lines. |
| cookies | `{"op":"hello","token":T,"v":2,"role":"cookies"}` | `{"ev":"hello","v":2,"role":"cookies"}` | One `groups` event as a snapshot, then only the `cookies` reply. |

A hello with `v:2` and no `role` is a v2 panel.

Rules for the agent hello:
- The agent's `G` comes from `agent_group_key(name, HC_TERMINAL_ID)`. That function moves from `engine.rs` to `proto.rs` unchanged. It gives `"t:<terminal>"` when the terminal is set, else `"n:<name>"`. The terminal and name are trimmed, control characters are removed, and each is cut to 64 characters.
- Swift trusts `G` only when it matches `^(t|n):[^\x00-\x1f]{0,64}$`. Any other `G` (including `"user"`) gets `{"ev":"hello","v":2,"role":"agent","error":"bad group"}` and Swift closes the connection.
- An agent hello without `v >= 2` is closed without a reply.
- Groups keep cooperating agents apart; they are not a security boundary. `HC_TERMINAL_ID` is not secret, and any process of the same user can read the token, so it can claim another terminal's group or connect as a panel.
- Before the hello, a first line that is not JSON closes the connection, and so does a partial line over 64 KB (over 64 MB after the hello).
- `name` is the MCP `clientInfo.name`, or `--name` for the `call` door (default `"cli"`). Swift stores it as the group's `name`; the last name seen wins.
- An agent hello does not create the group. The group's first `req` does (§4).

### What each role may send
| op | panel (v2 and legacy) | agent | cookies |
|---|---|---|---|
| `rect` `lease` `hide` `theme` `tab` `select` `close` `go` `back` `forward` `reload` `reloadHard` `stop` `pick` | yes | no | no |
| `show` `quit` (new) | yes | no | no |
| `cookies` | yes (today's `send_native` does it) | no | yes |
| `req` | ignored | yes | no |

When a role sends an op it may not use:
- An agent's line is answered with `{"ev":"res","id":<its id or null>,"ok":false,"error":"<op> is not allowed for agents"}`, and the connection stays open.
- A panel's or cookie CLI's line is ignored.

### Replies go to the connection that asked
- Every reply (`res`, `cookies`) goes only to the connection that sent the request. Today's `send()` broadcasts to everyone; v2 drops that.
- Events go to panel connections only, and legacy panels see user-group tab events only (see above).

### Agent request and response
```
→ {"op":"req","id":7,"tool":"click","args":{...}}
← {"ev":"res","id":7,"ok":true,"data":<any JSON>}
← {"ev":"res","id":7,"ok":false,"error":"<one line>"}
```
- `id` is echoed back exactly as sent. Rust numbers requests 1, 2, … on each connection.
- Every `req` gets exactly one `res`.
- `error` is always one line with no newlines, because `tool_error` shows only the first line.
- A connection may have several requests in flight. Swift runs one group's requests one at a time, in the order they arrive. The exception is `select_element`: its wait does not hold up the group's queue.
- Swift's deadline for a request (§5) counts from when its `req` line arrives, so time spent waiting in the queue counts too. When the deadline passes before the request starts, the answer is `<tool> timed out after <n> s`.
- A queued `req` whose connection has closed is dropped without running. That way Rust's reconnect-and-retry never repeats a click.
- An unknown `tool` gets the error `unknown tool "<tool>"`.

## 3. Tools: what Swift receives and returns

Rust keeps every MCP tool name, input schema and render step. For each tool it validates the arguments, sends one `req` (plus at most one sleep, for `wait`), then post-processes the `data`.

These args are common to the table below:
- **`tab`** is an optional integer tab number in the caller's group. When it is absent, the group's active tab is used.
  - Rust rejects a `tab` that is not an integer, with `tab must be a tab id from tabs`.
  - Swift answers a number outside the caller's group with `no tab <n>; call tabs to list them`, and a group with no tab with `no tab is open`.
- **`ref`** is a JSON integer: the N of `eN`. Rust's `get_ref` parses `"e12"` into `12`.

| MCP tool | Rust before sending | `tool` and args Swift receives | `data` Swift returns | Rust after |
|---|---|---|---|---|
| browser_tabs | Validates `action`, which must be list, new, close or select; otherwise `action must be list, new, close or select, not "<a>"`. On `new` with a url, it runs `normalize_url`, then `agent_url_ok`. | `tabs {action, id?: int, url?: string}` | `[{id:int, title, url, active:bool}]`: the caller's tabs, in tab order, after the action. | as is |
| browser_navigate | With `url`: `normalize_url`, then `agent_url_ok`. Otherwise `action` must be back, forward or reload; else `give url, or action "back" \| "forward" \| "reload"`. | `navigate {tab?, url?: string, action?: "back"\|"forward"\|"reload"}` | `{url, title}`, plus `failed: "<text>"` when the load failed | as is |
| browser_screenshot | none | `screenshot {tab?}` | `{data: <base64 PNG>, w:int, h:int, mimeType:"image/png"}`. `w` and `h` are the PNG's pixel size, which equals the viewport in CSS px. | `png_size` check (`not a PNG`), then `render` / `save_shot` unchanged |
| browser_read_page | Validates `filter`; clamps `max_chars` (default 40000) to the range 500–400000; parses `ref`. | `ax {tab?, root?: int}` | `{nodes:[AXNode], passwords:[int]}` (§3.1) | `format_ax(nodes, interactive, root, passwords, max)` unchanged, giving `{text}` |
| browser_find | `query` is required; an empty query gives `query is empty`. | `ax {tab?, boxes:true}` | the same, and every node that has a `backendDOMNodeId` also carries `box` | `find_nodes(nodes, query, passwords)`, then `[{ref:"e<N>", role, name, box}]`, taking `box` from the node whose `backendDOMNodeId` is N |
| browser_click | Validates `button` (default left; else `button must be left, right or middle, not "<b>"`). Clamps `clicks` to 1–3. Runs `parse_mods`, giving bits. Needs `ref`, or both `x` and `y`; else `give ref, or x and y (viewport CSS px, as in the screenshot)`. | `click {tab?, ref?: int, x?: num, y?: num, button: "left"\|"right"\|"middle", clicks: 1..3, mods: int}` | `{x, y}`: the point clicked, in viewport CSS px | as is |
| browser_type | `text` is required. | `type {tab?, ref?: int, text: string, clear: bool}` | `{}` | `{typed_chars: text.chars().count()}`. The text is never echoed. |
| browser_key | `key_ops`/`parse_chord`, including the clipboard refusal; then one key object per chord (§3.2). | `key {tab?, keys:[{key, code, text, mods:int}]}` | `{}` | `{pressed: n}` |
| browser_form_input | `ref` is required (`ref is required`); `value` must be present (`value is required`). | `form_input {tab?, ref: int, value: <any JSON>}` | the object FORM_JS returns, such as `{ok:true, kind, value?\|checked?}`. When FORM_JS returns `{error}`, Swift answers with `ok:false` and that error text. | as is |
| browser_scroll | none | `scroll {tab?, ref?: int, x?: num, y?: num, dx: num, dy: num}`. `dx` and `dy` default to 0. A missing `x` or `y` means the viewport's centre. | `{scrollX, scrollY}` of the top window | as is |
| browser_get_page_text | Defaults `max_chars` to 50000, with a minimum of 100. | `get_page_text {tab?}` | `{title, url, text}`, where `text` is the raw `document.body.innerText` (`""` when there is no body) | adds PAGE_NOTE, clips, adds the truncation note (the code moves from agent.rs) |
| browser_javascript | `code` is required. | `javascript {tab?, code}` | the value as JSON; `undefined` becomes `null` | `render`, with PAGE_NOTE |
| browser_console | none | `console {tab?, clear: bool}` | `{entries:[{level, text, source, time}]}`: the whole ring, oldest first. Swift empties the ring after the snapshot when `clear` is set. | `read_ring` on `entries` with the `pattern` and `limit` args and field `"text"` |
| browser_network | none | `network {tab?, clear: bool}` | `{entries:[{method, url, status, type, failed}]}`, as for console | `read_ring` with field `"url"` |
| browser_wait | When `ms` is given, Rust sleeps `min(ms, 30000)` and sends nothing; the result is `{waited_ms}`. Without `ms` or `text`: `give ms, or text to wait for`. | `wait {tab?, text, timeout_ms}`. `timeout_ms` defaults to 10000 and is capped at 30000 by Rust. | `{found:true}`, or the error `text not on the page after <ms> ms` | as is |
| browser_select_element | none | `select_element {}` | `{xml}` | `render` unchanged |

Other details per tool:

- **tabs**
  - `new` loads `url`, or about:blank when there is none, and the new tab becomes the active tab. Swift returns at once; it does not wait for the load.
  - `select` needs `id` (`id is required`).
  - `close` defaults to the active tab. An unknown `id` gets `no tab <id>`.
  - An agent group always keeps one tab. Closing the last one opens a new blank tab, with a new number.
  - More than 9 tabs gives the error `At most 9 tabs`.
- **navigate**
  - `back` and `forward` first check `canGoBack` and `canGoForward`, and fail with `no page to go back to` or `no page to go forward to`.
  - Swift waits for whichever comes first: `didFinish`, `didFail` or `didFailProvisionalNavigation`, a same-document URL change, or 30 s. Then it answers `ok:true` with the current `{url, title}`.
  - Swift never runs its own `normalize()` on agent URLs. It checks `agent_url_ok` again with the same rule as Rust: after trimming and lowercasing, the URL is exactly `about:blank`, or it starts with `http://`, `https://` or `data:`. A URL that fails gets `agents may open http, https, about:blank and data: pages only`.
- **click**
  - With `ref`, Swift first scrolls the element into view (`scrollIntoView({block:"center", inline:"center"})`), then clicks the centre of its box.
  - The events are one mouseMoved, then for n = 1…clicks a down and an up with clickCount n.
  - `right` uses rightMouseDown and rightMouseUp; `middle` uses otherMouseDown and otherMouseUp with buttonNumber 2.
  - An agent right-click must never show a native context menu (§5).
- **type**
  - With `ref`, Swift calls `el.focus()` first; a Text-node ref focuses its parent element.
  - `clear` empties the field first: for input and textarea it calls `el.select()`, for contenteditable it selects the node's contents. Then it runs `execCommand('delete')`.
  - Then it runs `document.execCommand('insertText', false, text)` on the document that holds the deepest `activeElement`, following same-origin iframes down.
  - If that call returns false, the error is `the focused element does not take text; pass the ref of a text field`.
- **javascript**
  - First Swift decides, without running the code, whether it is an expression: `callAsyncJavaScript("return typeof (async function () { return (" + code + "\n) })", in: nil, in: agentWorld)` only defines the function, in the private world the page cannot reach. A `SyntaxError` means statements; any other failure is the error.
  - The code then runs exactly once, and no error makes it run again (a page that replaces `JSON.stringify` or `String` cannot make the wrapper fail into a second run).
  - An expression runs as `try { return {v: JSON.stringify(await (CODE\n))} } catch (e) { return {e: String(e)} }` with `callAsyncJavaScript(in: nil, in: .page)`. Swift parses `v` as JSON, with fragments allowed; nil becomes `null`. `{e}`, or a failure of the call itself, becomes the error.
  - Statements run as `evaluateJavaScript(code, in: nil, in: .page)`, and Swift converts the Foundation value to JSON. A type it cannot convert gives `unsupported result type`.
  - A thrown exception gives `WKJavaScriptExceptionMessage` as the error (for example `Error: boom`), or else `localizedDescription`, as one line.
  - After 12 s without an answer, Swift stops the page (§5) and answers `javascript did not finish in 12 s; the tab was stopped and reloaded`.
  - The reload makes a new document, so every earlier ref answers `ref eN is gone; call read_page again`.
  - When another tab shares the WebContent pid, or `_webProcessIdentifier` is not available, Swift does not kill anything and answers `javascript did not finish in 12 s and is still running; close the tab with browser_tabs`. It remembers that pid as wedged: when a tab closes and no tab is left in a wedged process, Swift sends it `SIGKILL`.
- **wait (text)**: Swift checks `!!document.body && document.body.innerText.includes(text)` in the private world every 200 ms.
- **console**
  - `level` is one of `log`, `info`, `warn`, `error`, `debug` or `exception`.
  - `text` is at most 2048 characters. `source` is `"<url>:<line>"` or `""`. `time` is ms since the epoch, as a number.
  - The ring keeps the last 500 entries per tab.
- **network**
  - `method` and `status` are `null` when they cannot be known; they are known only for main-frame navigations and fetch/XHR.
  - `type` is `"document"`, `"fetch"`, `"xmlhttprequest"`, or the `PerformanceResourceTiming.initiatorType`.
  - `failed` is an error string or `null`.
  - The ring keeps the last 500 entries per tab. Swift never reads `responseStatus`: it does not exist in WebKit.
- **select_element**: see §6.

### 3.1 AX nodes (the `ax` reply)
`nodes` is a flat array in document pre-order (`find_nodes` takes the first 20 hits). It is built by a DOM walk in the private world.

The JS returns `JSON.stringify({nodes, passwords})` as a string, and Swift passes it through `JSONSerialization`, so integers stay JSON integers. `backendDOMNodeId` must serialize as `15`, never `15.0`, because `as_i64` rejects the latter.

```
{
  "nodeId": "15",                 // string, unique in this reply (use String(ref) or a counter)
  "parentId": "14",               // string; ABSENT (not null) on the root node only
  "childIds": ["16","17"],        // strings, in document order; [] for leaves
  "ignored": false,
  "role": {"value": "button"},
  "name": {"value": "Go"},        // "" when none
  "value": {"value": "a@b.c"},    // only for form fields; NEVER present for a password node
  "description": {"value": "…"},  // optional (aria-description / title when not the name)
  "backendDOMNodeId": 15,         // the ref: JSON integer >= 1
  "properties": [{"name": "focused", "value": {"value": true}}],
  "box": {"x":0,"y":0,"w":10,"h":10} | null   // only when args.boxes; null = zero size
}
```
- **Root.** There is one root, and it stands for `document.body` (or `documentElement` when there is no body): `role` `RootWebArea`, `name` equal to `document.title`, and `backendDOMNodeId` equal to that element's ref. The body element is not emitted a second time, and its children are the root's children.
- **Subtree.** With `root: N`, the reply is the subtree of ref N, and that node has no `parentId`. An unknown ref answers `ref eN is gone; call read_page again`.
- **Roles.** A role is the explicit `role=` attribute, or the implicit role from the role vocabulary that `format_ax` knows:
  - the INTERACTIVE list: `button link textbox searchbox combobox checkbox radio switch tab menuitem option slider spinbutton`;
  - also `heading`, `StaticText`, `RootWebArea`, `generic`, `paragraph`, `list`, `listitem`, `img`, `navigation`, `main`, `form`, `table`, `row`, `cell`, `dialog`, and so on.
  - A text node with visible non-whitespace text is a `StaticText` node. Its name is the collapsed text, and its ref points at the Text node.
- **Names** come from the first of: aria-labelledby, aria-label, `label[for]` or a wrapping label, alt, title, placeholder. Only the roles that take their name from content fall back to their text content: button, link, heading, tab, menuitem, option, checkbox, radio, switch and cell. Every other element, including an unnamed container (role `generic`), gets name `""`. Its text shows up through its `StaticText` children instead, as in the agent.rs fixture, where `paragraph` and `generic` have no name. Names are cut to 300 characters and values to 500.
- **What the walk skips.** It leaves out `display:none`, `visibility:hidden` and `aria-hidden="true"` subtrees, rather than sending `ignored:true`. It goes into open shadow roots and same-origin iframes, and never into cross-origin iframes or closed shadow roots. It stops after 50,000 nodes.
- **Properties.** These are emitted only when they apply:
  - `focused`, `disabled`, `selected` and `required`, as `true`;
  - `checked`, as `true`, `false` or `"mixed"`;
  - `expanded`, as `true` or `false`, and only when `aria-expanded` is set or the element is a `<details>`;
  - `level`, as an integer, for headings.
- **Passwords.** A password node is any `input[type=password]`, or any element whose `autocomplete` contains `password` or `one-time-code`. Its ref goes in `passwords` and its node has no `value` key at all.
- **Boxes.** `box` is the border box from `getBoundingClientRect` in top-level viewport CSS px, with iframe offsets added. A Text node uses a Range's box.

**Refs**
- Each tab keeps a counter that only ever grows. The same element keeps its ref across `ax` calls within a document.
- A ref from an earlier document never resolves. A ref whose node is gone or disconnected answers `ref eN is gone; call read_page again`.
- A ref whose box has zero size, when a box is needed (click, or scroll with a ref), answers `ref eN is not rendered (hidden or display:none)`.

### 3.2 Key objects and mods
The `mods` bitfield matches `Mods::cdp_bits` in proto.rs: **Alt/Option = 1, Ctrl = 2, Cmd = 4, Shift = 8**. Swift maps the bits to `.option`, `.control`, `.command` and `.shift`. The same bits are used for `click.mods`.

Rust builds each key object from `parse_chord` like this:
- a named key gets `key` and `code` from `keys::named_key`;
- `space` gets `key " "`, `code "Space"` and `text " "`;
- a single character `c` gets `key = c`, `code = char_code(c).0`, which is `""` for characters it does not know, and `text = c`, upper-cased when shift is held and `c` is a letter.

| chord | key | code | text | mods |
|---|---|---|---|---|
| `Enter` | `Enter` | `Enter` | `\r` | 0 |
| `shift+Tab` | `Tab` | `Tab` | `""` | 8 |
| `Backspace` | `Backspace` | `Backspace` | `""` | 0 |
| `ArrowDown` | `ArrowDown` | `ArrowDown` | `""` | 0 |
| `cmd+a` | `a` | `KeyA` | `a` | 4 |
| `A` | `A` | `KeyA` | `A` | 0 |
| `shift+a` | `a` | `KeyA` | `A` | 8 |
| `space` | `" "` | `Space` | `" "` | 0 |
| `å` | `å` | `""` | `å` | 0 |

How Swift turns a key object into an NSEvent:
- `code` maps to a kVK through a table that covers every named key, every `Key*`, `Digit*`, `Space` and the punctuation codes in `char_code`. An empty or unknown `code` gives keyCode 0.
- Named keys get the mac function-key characters: Backspace is `\u{7f}`, Delete is `NSDeleteFunctionKey`, the arrows, Home, End, PageUp and PageDown are their function keys, Tab is `\t`, Escape is `\u{1b}` and Enter is `\r`.
- Every other key uses `text`.
- `charactersIgnoringModifiers` is `text` lower-cased.

**Clipboard refusal.** Swift checks a second time, behind Rust. If `mods & (2|4)` is set and `code` is `KeyC`, `KeyV` or `KeyX`, or `key` lower-cased is `c`, `v` or `x`, it refuses the whole request with the agent.rs text: `"<key>" with cmd/ctrl is paste, copy or cut, which agents may not use: it touches the user's clipboard. Use browser_type to enter text.`

## 4. Groups, tabs, limits

### Tab ids
- Every Tab has a `num`: an integer from one counter for the whole process, starting at 1 and never reused.
- Agents see only `num`, in the `id` of `tabs` and in the `tab` arg.
- In panel ops and events, a tab's `id` is a string:
  - User tabs keep the id the mod gave them (`"t<N>"`) when it gave one. Today's mod sends `tab` without an id, so its tabs get `"a<num>"` too.
  - Agent tabs get `"a<num>"`, assigned by Swift.

### Groups
- The user group (`"user"`) holds the panel's tabs. Swift never fills it on its own: when it is empty, the mod opens a tab itself.
- An agent group is created on its first `req`, with one blank tab.

### Limits
- **Tabs.** A group has at most 9 tabs. An agent gets `At most 9 tabs`. A panel `tab` op over the limit gets `{"ev":"error","message":"At most 9 tabs"}`.
- **Groups.** There are at most 8 agent groups. Before a 9th is created, Swift closes groups following `evict_pick`:
  - first a group that no agent connection is attached to and that has been idle for at least 30 min;
  - else, while there are more than 7 groups, the one idle longest, with unattached groups before attached ones;
  - never the user group, the shown group, or a group with a request in flight. If every group is protected, the count may go over 8.
- **Idle.** Once a minute, `tick` also closes any unattached group that has been idle for 30 min.
- **Closing a group.** Its tabs close. Its `select_element` waiters get `this browser was closed`. Panels get a `groups` event.
- **What counts.** A group's `used` time is set when each request starts and ends. "Attached" means an open agent connection whose hello named that group.

### Hosting
These are Swift-internal rules, but agents depend on them.
- `current` is the shown group's active tab. It is the only view in `win`, the overlay window that sits over the panel.
- Every other tab lives in the `stage` window.
- `stage` is sized to the last panel page-rect size, in points. That is 1280x800 until a `rect` arrives.
- Every tab must stay `visibilityState=visible` with full-rate timers, including `current` while no lease is live.
- So `win` is never ordered out while it holds a view. To hide `win`, Swift sets its alpha to 0, sets `ignoresMouseEvents`, and moves it to the corner position that `stage` uses (§5). To show it, Swift reverses that.
- With no panel connected, the shown group is `"user"`.

### `show {group}` (panel)
- `show` makes `group` the shown group. Swift moves views between `win` and `stage`; a white frame is acceptable.
- An unknown group shows `"user"`.
- Any `select_element` waiters of the group shown before are cancelled with `Select element was cancelled`.
- After a `show`, Swift sends a `groups` event right away.

### `groups` event
It is sent to v2 panels and, once after hello, to the cookie CLI.
```
{"ev":"groups","shown":"user","groups":[
  {"id":"user","owner":"user","name":null,"terminal":null,"busy":false,
   "tabs":[{"id":"t1","num":1,"title":"…","url":"…","active":true}]},
  {"id":"t:w3p2","owner":"agent","name":"claude-code","terminal":"w3p2","busy":true,
   "tabs":[{"id":"a4","num":4,"title":"…","url":"…","active":true}]}]}
```
- The user group comes first, then agent groups, the most recently used first.
- `busy` means a request is in flight, or one finished less than 20 s ago.
- `active` marks the group's own active tab.
- The event is sent:
  - right after hello and after `show`;
  - otherwise when anything in it changes: the groups, a name, `busy`, the tabs, their order, the active tab, a url or title, or `shown`.
  - Changes are coalesced: at most one event per 250 ms, always sending the latest state.
- `busy` turning false also counts as a change, so `tick` must notice it.
- This is the truth about which tabs exist. The mod's `wantedGroup()` and the agent badge in `strip()` read it as they are.

### `tab` event
It is sent to panels; legacy panels get user-group tabs only.
```
{"ev":"tab","id":"a4","group":"t:w3p2","num":4,"url":"…","title":"…","loading":false,"canBack":false,"canForward":false,"active":true}
```
- `active` now means "the active tab of its group". For the user group, that is the same as in v1 while the user group is shown.
- Tab events carry the fields that change often (`loading`, `canBack`, `canForward`). Which tabs exist comes from `groups`.

### Panel ops, v2
Fields that are new in v2 are marked **new**; everything else is as in v1.

| op | fields | effect |
|---|---|---|
| `tab` | `id?`, `url`, `group?` **new** (default `"user"`) | Without `id` (**new**): opens a tab in `group` (any group, `"user"` included), and Swift assigns its id `"a<num>"`. An unknown group gets an `error` event `no group <group>`. With an `id` that is unknown: opens that tab in `group`, which is what the v1 user tabs do. With a known `id`: selects it. The tab becomes its group's active tab, and the view swaps if the group is shown. `url` `"about:blank"` loads the themed blank page; for user tabs any other url goes through Swift's `normalize()` (as in v1); agent-group tabs follow the agent-tab policy (§5). |
| `select` | `id` | Makes it its group's active tab. Never changes `shown`. |
| `close` | `id` | Closes the tab. If it was the last tab of an agent group, a new blank tab opens in its place. The user group may be left empty. |
| `go` `back` `forward` `reload` `reloadHard` `stop` `pick` | `id` (falls back to `current`, as in v1) | As in v1, on a tab in any group. `pick` is covered in §6. (v1's `js` op is gone: no panel sent it, and it ran any code in any tab.) |
| `rect` `lease` `hide` `theme` | as in v1 | As in v1. `rect` also records the stage size. `hide` makes `win` invisible as described under Hosting, without ordering it out. |
| `cookies` | `cookies:[CDP-style]` | As in v1. The reply `{"ev":"cookies","imported":n,"skipped":n}` goes to the requester only. Swift then reloads `current`. |
| `show` **new** | `group` | see above |
| `quit` **new** | none | Swift removes its port file (as in §1) and exits 0. Tests and the selftest use it. |

### Other events to panels
- `{"ev":"key","name":…}`: as in v1.
- `{"ev":"picked",…}`: see §6.
- `{"ev":"selecting","on":bool,"agent":"<name>"|null}` **new**, for v2 panels only.
- `{"ev":"error","message":"…"}` **new**.

## 5. Swift constraints (from probe T0, macOS 26.6)

- **Stage window**
  - It is borderless, ordered in with `orderFrontRegardless`, alpha 0, `ignoresMouseEvents`, and `canBecomeKey`/`canBecomeMain` false.
  - Its frame sits almost entirely off screen, overlapping only the 1x1 pt bottom-left corner of `NSScreen.screens[0]` (for example origin `(-W+1, -H+1)`).
  - Windows that are off screen or ordered out go `hidden` and get throttled timers. `inactiveSchedulingPolicy` does not help.
  - As a fallback, Swift also calls the private `_setWindowOcclusionDetectionEnabled:` with `NO` on every WKWebView. It calls it through `method(for:)` after `responds(to:)` passes, and never through KVC `setValue:`, which throws an ObjC exception.
- **Both windows** override `noResponder(for:)` with an empty body, so there is no beep.
- **Input**
  - Swift calls the view's own `mouseMoved`, `mouseDown`, `mouseUp` (and the right and other variants), `keyDown` and `keyUp`. The NSEvents carry the host window's `windowNumber`, at location `web.convert(NSPoint(x: x, y: y), to: nil)`; `WKWebView.isFlipped` is true.
  - Swift never uses `window.sendEvent`, because `OverlayWindow` activates the app on mouse-down. It never posts CGEvents, never makes a window key or main, and never activates the app.
  - Swift calls `makeFirstResponder(web)` once when a view enters a window and is not that window's contentView.
- **Context menu.** An agent right-click must not open an NSMenu. While an agent click is running and for 500 ms after it, the WKWebView subclass cancels any menu in `willOpenMenu(_:with:)` with `menu.cancelTracking()`. The page's own `contextmenu` event still fires. This is untested; T4 must verify it.
- **Editing chords** (cmd+a, cmd+z, cmd+shift+z, cmd+y) must work without the Edit menu and without a key window. T4 picks the mechanism and tests it.
- **Text** goes in with `el.focus()` and `execCommand('insertText')`, run through `callAsyncJavaScript` in the private world `WKContentWorld.world(name: "herdr-agent")`. That fires trusted beforeinput and input events.
- **Our scripts** (ax, click boxes, type, form_input, scroll, get_page_text, wait) run only in that private world. Only `javascript`, and the console and network hooks, run in `.page`. The hooks are WKUserScripts injected at document start into all frames; they post to a page-world handler that only appends to the ring.
- **Snapshots** are 2x pixels even when `snapshotWidth` is set. Swift draws them again into an `NSBitmapImageRep` whose `pixelsWide` and `pixelsHigh` equal the bounds in points.
- **Runaway JS**
  - A `while(1)` in `.page` never returns and wedges that view. Discarding the view leaves its WebContent process at 100% CPU.
  - Recovery: read the pid from the private `_webProcessIdentifier`, guarded by `responds(to:)`. If no other tab has that pid, send it `SIGKILL`. Then, in `webViewWebContentProcessDidTerminate`, reload.
  - Swift holds the reply until that reload starts.
- **Agent tabs' navigation policy.** `decidePolicyFor navigationAction` on agent-group tabs allows only http, https, about, data and blob, whoever navigates. That blocks redirects and links to `file:`. Popups load in the same tab, as in v1, and the policy applies to them.
- **Clipboard guard** (user decision 3)
  - The guard wraps every agent `click`, `key`, `type`, `form_input`, `javascript`, and `tabs` with `action:"select"`. That last one is this contract's reading of "select" in the decision; see the open questions.
  - When the first guarded action starts, Swift saves every item and type on `NSPasteboard.general`, along with its `changeCount`. Guards are reference-counted, so overlapping actions share one save.
  - When a guarded action ends, Swift waits 300 ms (async page handlers), restores the saved items if `changeCount` changed, and sends the reply. The guard itself stays open 1.5 s after the action (WebKit keeps a click's user gesture through timers of up to about 1 s), and restores again at its end. A write after that, such as a `ClipboardItem` promise that resolves later, is not undone.
  - The guard never logs or returns clipboard contents.
  - Swift's own pasteboard write (a user pick with no waiters, §6) refreshes the saved state and `changeCount` while a guard is open, so the guard never reverts it.
  - `select_element` is not guarded: a user copy during the pick wait must survive.
- **Swift-side timeouts.** These deadlines are strictly below Rust's socket wait.

| tool | Swift deadline | answer when it is reached |
|---|---|---|
| navigate | 30 s | `ok`, with the current `{url,title}` |
| wait (text) | `timeout_ms` (≤30 s) | `text not on the page after <ms> ms` |
| javascript | 12 s | see §3 |
| select_element | 120 s | `no element was picked within 120 s` |
| every other tool | 15 s | `<tool> timed out after 15 s` |

- **Rust's socket wait** per request is `timeout_for(op) + 10 s`, where `timeout_for` is navigate 35, wait 32, select_element 120, and 15 for everything else. On expiry Rust drops the connection and answers `no answer from herdr-web for <op>`.

## 6. select_element (agent pick)

1. Swift checks two things, in this order:
   - If no lease is live, the answer is `select_element needs the herdr Browser panel open: the user picks the element there`.
   - If the caller's group is not the shown group, the answer is `select_element needs the herdr Browser panel to show your tabs; it shows another browser now (it follows the herdr tab the user looks at)`.
2. Swift adds a waiter `(connection, req id, group)`. If the pick is not on yet, it turns it on: `pickActive = true`, and it runs `pickScript(true)` on `current` in `pickWorld`. If that fails, the answer is `Select element could not start`.
3. Swift sends v2 panels `{"ev":"selecting","on":true,"agent":"<name>"}`. The mod shows its Select pill as on.
4. The user picks an element (PickHandler).
   - If the shown group has waiters, every one of them gets `{xml}`, with the screenshot path filled in. **The pasteboard is not touched.** Panels get `{"ev":"picked","summary":"…","agent":"<name>"}`, and the mod toasts "Element sent to <name>".
   - If there are no waiters, the pick works as in v1: the XML goes on the pasteboard and panels get `{"ev":"picked","summary":"…"}`.
5. The waiters are cancelled with `Select element was cancelled`, and panels get `{"ev":"picked","cancel":true}`, when any of these happens:
   - the user presses Escape in the page, or a panel sends `pick {on:false}`;
   - `show` switches away from the group;
   - the group's active tab changes or closes.
6. Other endings:
   - If 120 s pass, the waiters get `no element was picked within 120 s` and the pick turns off.
   - If the group is evicted, they get `this browser was closed`.
   - If a waiter's connection closes, that waiter is dropped. When it was the last waiter of a pick an agent started, the pick turns off.
   - When the last waiter leaves without an element, v2 panels get `{"ev":"selecting","on":<is the pick still on>,"agent":null}`: a pick the user turned on stays on.
7. Only the user's input picks. The pick script ignores events that are not `isTrusted`, and while the pick is on in a tab, Swift refuses agent `click` and `key` there with `the user is selecting an element in this tab (Select is on): clicks and keys are refused until the pick ends`.
8. The `outerHTML` in the XML has no `value` on password fields (agentjs's `isPassword` rule).

## 7. Notes per builder

- **Rust**
  - These keep their exact behaviour: the TOOLS names and schemas, `render`, `page_error`, `call_output`, PAGE_NOTE, `format_ax`, `find_nodes`, `read_ring` (on a Ring built from `entries`), `png_size`, `parse_chord`, `key_ops`, `parse_mods`, `get_ref`, `normalize_url` and `agent_url_ok`.
  - Some descriptions gain a sentence; the schemas stay the same:
    - network: "In WebKit, method and status are known only for page navigations and fetch/XHR."
    - javascript: "A script still running after 12 s is stopped and the tab reloads."
    - read_page and find: "Roles and names are computed from the DOM; cross-origin iframes and closed shadow roots are not included."
  - The cookie CLI uses `role:"cookies"`. It reads the `groups` snapshot for `open_sites`, sends `cookies` to every live helper that answers hello with v2, and never spawns.
- **Mod**
  - Hello becomes `{op:"hello",token,v:2,role:"panel"}`. A reply without `v` means an old helper: the mod runs `pkill -f -- "--port-file <pf>"` and spawns again.
  - The mod builds `state.groups`, `state.group` (from `shown`) and `state.tabs` from `groups`, plus the live fields from `tab` events.
  - `syncShown` sends `{op:"show",group}` through `nraw` while `nsock` is set.
  - A new tab in an agent group is `{op:"tab",group,url:"about:blank"}` with no id. Close, select and navigate use the tab's string `id`.
  - The mod handles `selecting`, `picked.agent` and `error` (with `showError`).
  - The old Chrome profile `data/herdr-browser/profile` stays as it is.
- **Swift**
  - Remove the `?? current` fallback for agents (agent ops never fall back).
  - Move every `send(...)` that is a reply over to a per-connection reply.
  - Route events by role.
