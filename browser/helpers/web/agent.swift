// Agent tool requests (PROTOCOL.md §2-§6): one group's requests run one at a time, each on a tab of that group only.
import AppKit
import WebKit

let agentWorld = WKContentWorld.world(name: "herdr-agent")

struct Failure: Error { let msg: String; init(_ m: String) { msg = m } }
func jsMessage(_ e: Error) -> String { oneLine(((e as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String) ?? e.localizedDescription) }
func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

// One `req`: exactly one `res`, whatever races (a completion against its deadline).
final class Job {
  let conn: Conn
  let id: Any
  let tool: String
  let args: [String: Any]
  let arrived = Date() // the deadline counts from here, so time in the queue counts too
  weak var group: Group?
  weak var tab: Tab?
  var done = false
  var guarded = false
  var onDone: (() -> Void)?
  init(conn: Conn, id: Any, tool: String, args: [String: Any]) { self.conn = conn; self.id = id; self.tool = tool; self.args = args }
  func reply(_ data: Any) { finish(["ok": true, "data": data]) }
  func fail(_ e: String) { finish(["ok": false, "error": oneLine(e)]) }
  func drop() { done = true; onDone?(); onDone = nil } // its agent left: nobody to answer
  private func finish(_ r: [String: Any]) {
    guard !done else { return }
    done = true
    let send = { [self] in
      var m = r; m["ev"] = "res"; m["id"] = id
      conn.send(m)
      onDone?(); onDone = nil
    }
    if guarded { clipEnd(send) } else { send() }
  }
}

// MARK: clipboard guard (user decision 3): what a page writes during an agent action is undone

var clipDepth = 0
var clipSaved: [[(NSPasteboard.PasteboardType, Data)]] = []
var clipCount = 0
func clipSave() {
  let pb = NSPasteboard.general
  clipSaved = (pb.pasteboardItems ?? []).map { it in it.types.compactMap { t in it.data(forType: t).map { (t, $0) } } }
  clipCount = pb.changeCount
}
func clipBegin() { if clipDepth == 0 { clipSave() }; clipDepth += 1 }
// Restores the saved items if anything wrote the pasteboard since they were saved.
func clipRestore() {
  let pb = NSPasteboard.general
  guard pb.changeCount != clipCount else { return }
  pb.clearContents()
  let items = clipSaved.map { kept -> NSPasteboardItem in let it = NSPasteboardItem(); for (t, d) in kept { it.setData(d, forType: t) }; return it }
  if !items.isEmpty { pb.writeObjects(items) }
  clipCount = pb.changeCount // the restore is not a page's write
}
// Waits 300 ms for the page's async handlers, restores, then answers. The guard stays open 1.5 s in all: WebKit keeps
// a click's user gesture through timers of up to about 1 s, so a page's late write is undone too.
func clipEnd(_ then: @escaping () -> Void) {
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { clipRestore(); then() }
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    clipRestore()
    clipDepth -= 1
    if clipDepth == 0 { clipSaved = [] }
  }
}
// Our own write (a user's pick) during a guard is the new state to keep.
func clipRefresh() { if clipDepth > 0 { clipSave() } }

// MARK: console and network rings

final class LogHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let t = tabsById.values.first(where: { $0.web === m.webView }), let b = m.body as? [String: Any] else { return }
    // The page can post here too, so every field is checked; its entries are page data either way.
    func str(_ k: String) -> Any { (b[k] as? String).map { String($0.prefix(2048)) } ?? NSNull() }
    if b["k"] as? String == "c" {
      let level = b["level"] as? String ?? ""
      t.record(&t.consoleRing, ["level": ["log", "info", "warn", "error", "debug", "exception"].contains(level) ? level : "log",
                                "text": String((b["text"] as? String ?? "").prefix(2048)), "source": String((b["source"] as? String ?? "").prefix(2048)),
                                "time": num(b["time"]) ?? Date().timeIntervalSince1970 * 1000])
    } else {
      t.record(&t.networkRing, ["method": str("method"), "url": String((b["url"] as? String ?? "").prefix(2048)), "status": (b["status"] as? NSNumber).map { $0.intValue } ?? NSNull(),
                                "type": String((b["type"] as? String ?? "other").prefix(64)), "failed": str("failed")])
    }
  }
}
let logHandler = LogHandler()

// MARK: requests

let toolLimit: [String: Double] = ["tabs": 15, "navigate": 30, "screenshot": 15, "ax": 15, "click": 15, "type": 15, "key": 15,
                                   "form_input": 15, "scroll": 15, "get_page_text": 15, "javascript": 12, "console": 15,
                                   "network": 15, "wait": 30, "select_element": 120]
func limit(_ j: Job) -> Double { j.tool == "wait" ? min(30, max(0, num(j.args["timeout_ms"]) ?? 10000) / 1000) : toolLimit[j.tool] ?? 15 }
func secs(_ s: Double) -> String { s == s.rounded() ? "\(Int(s))" : String(format: "%g", s) }

func agentRequest(_ c: Conn, _ m: [String: Any]) {
  let tool = m["tool"] as? String ?? ""
  let j = Job(conn: c, id: m["id"] ?? NSNull(), tool: tool, args: m["args"] as? [String: Any] ?? [:])
  guard toolLimit[tool] != nil else { j.fail("unknown tool \"\(tool)\""); return }
  let g = agentGroup(c)
  g.name = c.name
  j.group = g
  if tool == "select_element" { selectElement(g, j); return } // its wait does not hold up the queue
  g.queue.append(j)
  pump(g)
}

func pump(_ g: Group) {
  while !g.running, !g.queue.isEmpty {
    let j = g.queue.removeFirst()
    guard j.conn.open else { continue } // dropped: Rust's reconnect-and-retry must never repeat a click
    let lim = limit(j), end = j.arrived.addingTimeInterval(lim)
    guard Date() < end else { timedOut(j); continue }
    g.running = true; g.inflight += 1; g.used = Date()
    j.onDone = { g.running = false; g.inflight -= 1; g.used = Date(); g.lastDone = Date(); DispatchQueue.main.async { pump(g) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + end.timeIntervalSinceNow) { if !j.done { timedOut(j) } }
    run(g, j)
  }
}

func timedOut(_ j: Job) {
  switch (j.tool, j.tab) {
  case ("navigate", let t?): j.reply(page(t))
  case ("wait", _): j.fail("text not on the page after \(Int(num(j.args["timeout_ms"]) ?? 10000)) ms")
  case ("javascript", let t?): runaway(t, j)
  default: j.fail("\(j.tool) timed out after \(secs(limit(j))) s")
  }
}

func page(_ t: Tab) -> [String: Any] { ["url": t.web.url?.absoluteString ?? "", "title": t.web.title ?? ""] }

func agentURLOK(_ u: String) -> Bool {
  let l = u.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return l == "about:blank" || l.hasPrefix("http://") || l.hasPrefix("https://") || l.hasPrefix("data:")
}
let urlRefused = "agents may open http, https, about:blank and data: pages only"
func agentURL(_ u: String) -> URL? { agentURLOK(u) ? URL(string: u.trimmingCharacters(in: .whitespacesAndNewlines)) : nil }

func run(_ g: Group, _ j: Job) {
  let a = j.args
  if j.tool == "tabs" { tabsTool(g, j); return }
  let t: Tab
  if let n = a["tab"] as? NSNumber {
    guard let x = g.tabs.first(where: { $0.num == n.intValue }) else { j.fail("no tab \(n.intValue); call tabs to list them"); return }
    t = x
  } else {
    guard let x = g.active else { j.fail("no tab is open"); return }
    t = x
  }
  j.tab = t
  if ["click", "key", "type", "form_input", "javascript"].contains(j.tool) { clipBegin(); j.guarded = true }
  switch j.tool {
  case "navigate": navigate(t, j)
  case "screenshot": screenshot(t, j)
  case "ax": lib(t, j, "ax", ["root": a["root"] ?? NSNull(), "boxes": a["boxes"] as? Bool ?? false])
  case "click": click(t, j)
  case "type": lib(t, j, "type", ["ref": a["ref"] ?? NSNull(), "text": a["text"] as? String ?? "", "clear": a["clear"] as? Bool ?? false])
  case "key": keys(t, j)
  case "form_input": lib(t, j, "form", ["ref": a["ref"] ?? NSNull(), "value": a["value"] ?? NSNull()])
  case "scroll": lib(t, j, "scroll", ["ref": a["ref"] ?? NSNull(), "x": a["x"] ?? NSNull(), "y": a["y"] ?? NSNull(), "dx": num(a["dx"]) ?? 0, "dy": num(a["dy"]) ?? 0])
  case "get_page_text": lib(t, j, "text", [:])
  case "javascript": javascript(t, j)
  case "console": j.reply(["entries": t.consoleRing]); if a["clear"] as? Bool == true { t.consoleRing = [] }
  case "network": j.reply(["entries": t.networkRing]); if a["clear"] as? Bool == true { t.networkRing = [] }
  case "wait": waitText(t, j)
  default: j.fail("unknown tool \"\(j.tool)\"")
  }
}

// Runs one agentLib function in the private world; its {error} becomes the request's error.
func lib(_ t: Tab, _ fn: String, _ a: [String: Any], _ done: @escaping (Result<[String: Any], Failure>) -> Void) {
  t.web.callAsyncJavaScript(agentLib, arguments: ["fn": fn, "A": a, "base": t.nextRef], in: nil, in: agentWorld) { r in
    switch r {
    case .failure(let e): done(.failure(Failure(jsMessage(e))))
    case .success(let v):
      guard let s = v as? String, let d = s.data(using: .utf8), var o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
        done(.failure(Failure("the page gave no answer"))); return
      }
      if let n = o.removeValue(forKey: "next") as? NSNumber { t.nextRef = max(t.nextRef, n.intValue) }
      if let e = o["error"] as? String { done(.failure(Failure(e))) } else { done(.success(o)) }
    }
  }
}
func lib(_ t: Tab, _ j: Job, _ fn: String, _ a: [String: Any]) {
  lib(t, fn, a) { r in switch r { case .success(let o): j.reply(o); case .failure(let e): j.fail(e.msg) } }
}

// A private-world round trip: WebKit sends queued input events one by one, so n of these mean n events were handled.
func barrier(_ t: Tab, _ n: Int, _ done: @escaping () -> Void) {
  guard n > 0 else { done(); return }
  t.web.callAsyncJavaScript("return 0", arguments: [:], in: nil, in: agentWorld) { _ in barrier(t, n - 1, done) }
}

// MARK: tabs and navigation

func tabsTool(_ g: Group, _ j: Job) {
  let a = j.args
  let id = (a["id"] as? NSNumber)?.intValue
  switch a["action"] as? String ?? "list" {
  case "list": break
  case "new":
    guard g.tabs.count < 9 else { j.fail("At most 9 tabs"); return }
    var url: URL?
    if let u = a["url"] as? String { guard let x = agentURL(u) else { j.fail(urlRefused); return }; url = x }
    let t = openTab(g)
    if let u = url { t.web.load(URLRequest(url: u)) } else { loadBlank(t) }
    activate(t)
  case "close":
    let n = id ?? g.active?.num ?? 0
    guard let t = g.tabs.first(where: { $0.num == n }) else { j.fail("no tab \(n)"); return }
    closeTab(t)
  case "select":
    guard let n = id else { j.fail("id is required"); return }
    guard let t = g.tabs.first(where: { $0.num == n }) else { j.fail("no tab \(n)"); return }
    clipBegin(); j.guarded = true
    activate(t)
  case let x: j.fail("action must be list, new, close or select, not \"\(x)\""); return
  }
  j.reply(g.tabs.map { ["id": $0.num, "title": $0.web.title ?? "", "url": $0.web.url?.absoluteString ?? "", "active": $0 === g.active] })
}

// Answers once the load finished or failed, or a same-document change happened; at 30 s `timedOut` answers.
func navigate(_ t: Tab, _ j: Job) {
  let w = t.web
  let start: () -> WKNavigation?
  if let s = j.args["url"] as? String {
    guard let u = agentURL(s) else { j.fail(urlRefused); return }
    start = { w.load(URLRequest(url: u)) }
  } else {
    switch j.args["action"] as? String {
    case "back"?: guard w.canGoBack else { j.fail("no page to go back to"); return }; start = { w.goBack() }
    case "forward"?: guard w.canGoForward else { j.fail("no page to go forward to"); return }; start = { w.goForward() }
    case "reload"?: start = { w.reload() }
    default: j.fail("give url, or action \"back\" | \"forward\" | \"reload\""); return
    }
  }
  // WebKit may send the title after didFinish: a round trip to the page lets it arrive before the answer reads it.
  let wait = NavWait(from: w.url) { failed in barrier(t, 1) { var d = page(t); if let f = failed { d["failed"] = f }; j.reply(d) } }
  t.navWait = wait
  wait.nav = start()
}

func screenshot(_ t: Tab, _ j: Job) {
  let w = t.web, b = w.bounds
  let cfg = WKSnapshotConfiguration()
  cfg.rect = b
  cfg.snapshotWidth = NSNumber(value: Double(b.width))
  w.takeSnapshot(with: cfg) { img, err in
    let W = Int(b.width.rounded()), H = Int(b.height.rounded())
    // Snapshots come at the screen's scale even with snapshotWidth: draw again at one pixel per CSS px.
    guard let img = img, W > 0, H > 0, let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                                                                    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
      j.fail("screenshot failed: \(err?.localizedDescription ?? "no image")"); return
    }
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    img.draw(in: NSRect(x: 0, y: 0, width: W, height: H), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { j.fail("screenshot failed: no PNG"); return }
    j.reply(["data": png.base64EncodedString(), "w": W, "h": H, "mimeType": "image/png"])
  }
}

// MARK: input: the view's own event methods, never window.sendEvent or CGEvents, and never a key window

func modFlags(_ bits: Int) -> NSEvent.ModifierFlags {
  var f: NSEvent.ModifierFlags = []
  if bits & 1 != 0 { f.insert(.option) }
  if bits & 2 != 0 { f.insert(.control) }
  if bits & 4 != 0 { f.insert(.command) }
  if bits & 8 != 0 { f.insert(.shift) }
  return f
}

// The pick takes trusted clicks and Escape: an agent's would pick (or cancel) for the user, so they wait until it ends.
func pickingOn(_ t: Tab) -> Bool { pickActive && pickTab === t }
let pickRefused = "the user is selecting an element in this tab (Select is on): clicks and keys are refused until the pick ends"

// NSEvent's factory takes no button number and WebKit reads it: a middle click must say 2.
final class MiddleButtonEvent: NSEvent { override var buttonNumber: Int { 2 } }

func click(_ t: Tab, _ j: Job) {
  let a = j.args
  let button = a["button"] as? String ?? "left"
  let clicks = max(1, min(3, (a["clicks"] as? NSNumber)?.intValue ?? 1))
  let flags = modFlags((a["mods"] as? NSNumber)?.intValue ?? 0)
  let go: (Double, Double) -> Void = { x, y in
    guard !pickingOn(t) else { j.fail(pickRefused); return }
    let w = t.web
    w.noMenuUntil = Date().addingTimeInterval(limit(j) + 0.5) // a hung page's barrier never ends: the menu must come back
    let p = w.convert(NSPoint(x: x, y: y), to: nil) // WKWebView is flipped: CSS y goes down, like the view's
    let wn = w.window?.windowNumber ?? 0
    var ts = ProcessInfo.processInfo.systemUptime
    let (down, up): (NSEvent.EventType, NSEvent.EventType) = button == "right" ? (.rightMouseDown, .rightMouseUp) : button == "middle" ? (.otherMouseDown, .otherMouseUp) : (.leftMouseDown, .leftMouseUp)
    func ev(_ type: NSEvent.EventType, _ n: Int) -> NSEvent? {
      ts += 0.01
      let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: flags, timestamp: ts, windowNumber: wn, context: nil, eventNumber: 0, clickCount: n, pressure: type == down ? 1 : 0)
      if let e = e, button == "middle", type != .mouseMoved, object_getClass(e) == NSEvent.self { object_setClass(e, MiddleButtonEvent.self) }
      return e
    }
    if let e = ev(.mouseMoved, 0) { w.mouseMoved(with: e) }
    for n in 1...clicks {
      guard let d = ev(down, n), let u = ev(up, n) else { continue }
      switch button {
      case "right": w.rightMouseDown(with: d); w.rightMouseUp(with: u)
      case "middle": w.otherMouseDown(with: d); w.otherMouseUp(with: u)
      default: w.mouseDown(with: d); w.mouseUp(with: u)
      }
    }
    barrier(t, 1 + 2 * clicks) { w.noMenuUntil = Date().addingTimeInterval(0.5); j.reply(["x": x, "y": y]) }
  }
  if let r = a["ref"] {
    lib(t, "point", ["ref": r]) { res in
      switch res {
      case .success(let o): go(num(o["x"]) ?? 0, num(o["y"]) ?? 0)
      case .failure(let e): j.fail(e.msg)
      }
    }
  } else if let x = num(a["x"]), let y = num(a["y"]) { go(x, y) }
  else { j.fail("give ref, or x and y (viewport CSS px, as in the screenshot)") }
}

// The mac virtual key for each DOM `code` herdr-browser sends (keys::named_key and char_code).
let keyCodes: [String: UInt16] = [
  "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08,
  "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11, "KeyO": 0x1F,
  "KeyU": 0x20, "KeyI": 0x22, "KeyP": 0x23, "KeyL": 0x25, "KeyJ": 0x26, "KeyK": 0x28, "KeyN": 0x2D, "KeyM": 0x2E,
  "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17, "Digit9": 0x19, "Digit7": 0x1A,
  "Digit8": 0x1C, "Digit0": 0x1D, "Equal": 0x18, "Minus": 0x1B, "BracketRight": 0x1E, "BracketLeft": 0x21, "Quote": 0x27,
  "Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "Period": 0x2F, "Backquote": 0x32, "Space": 0x31,
  "Enter": 0x24, "Tab": 0x30, "Backspace": 0x33, "Escape": 0x35, "Delete": 0x75, "Home": 0x73, "PageUp": 0x74, "End": 0x77,
  "PageDown": 0x79, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
]
func fn(_ c: Int) -> String { String(UnicodeScalar(UInt16(c)).map(Character.init) ?? " ") }
let namedChars: [String: String] = [
  "Enter": "\r", "Tab": "\t", "Escape": "\u{1b}", "Backspace": "\u{7f}", "Delete": fn(NSDeleteFunctionKey),
  "ArrowUp": fn(NSUpArrowFunctionKey), "ArrowDown": fn(NSDownArrowFunctionKey), "ArrowLeft": fn(NSLeftArrowFunctionKey),
  "ArrowRight": fn(NSRightArrowFunctionKey), "Home": fn(NSHomeFunctionKey), "End": fn(NSEndFunctionKey),
  "PageUp": fn(NSPageUpFunctionKey), "PageDown": fn(NSPageDownFunctionKey),
]

enum Chord { case selectAll, undo, redo }
// An agent's keyDown, remembered until WebKit hands it back as unused (HerdrApp.sendEvent).
final class AgentKey {
  let event: NSEvent
  weak var web: WKWebView?
  let chord: Chord?
  let at = Date()
  init(_ e: NSEvent, _ w: WKWebView, _ c: Chord?) { event = e; web = w; chord = c }
  // The page did not take an editing chord: do what the Edit menu would, on this view only.
  func unused() {
    guard let w = web, let c = chord else { return }
    switch c {
    case .selectAll: w.selectAll(nil)
    case .undo: w.undoManager?.undo()
    case .redo: w.undoManager?.redo()
    }
  }
}
var agentKeys: [AgentKey] = []

func keys(_ t: Tab, _ j: Job) {
  let ks = (j.args["keys"] as? [[String: Any]]) ?? []
  for k in ks { // a second check behind herdr-browser's
    let key = k["key"] as? String ?? "", code = k["code"] as? String ?? "", mods = (k["mods"] as? NSNumber)?.intValue ?? 0
    if mods & 6 != 0 && (["KeyC", "KeyV", "KeyX"].contains(code) || ["c", "v", "x"].contains(key.lowercased())) {
      j.fail("\"\(key)\" with cmd/ctrl is paste, copy or cut, which agents may not use: it touches the user's clipboard. Use browser_type to enter text."); return
    }
  }
  func press(_ i: Int) {
    guard i < ks.count else { j.reply([String: Any]()); return }
    guard !pickingOn(t) else { j.fail(pickRefused); return }
    let k = ks[i], w = t.web
    let key = k["key"] as? String ?? "", code = k["code"] as? String ?? "", mods = (k["mods"] as? NSNumber)?.intValue ?? 0
    var flags = modFlags(mods)
    let chars = namedChars[key] ?? k["text"] as? String ?? ""
    if namedChars[key] != nil && !["Enter", "Tab", "Escape", "Backspace"].contains(key) { flags.formUnion(key.hasPrefix("Arrow") ? [.function, .numericPad] : [.function]) }
    let lower = key.lowercased()
    let chord: Chord? = mods & 4 == 0 ? nil : lower == "a" ? .selectAll : lower == "z" ? (mods & 8 != 0 ? .redo : .undo) : lower == "y" ? .redo : nil
    let now = ProcessInfo.processInfo.systemUptime
    let wn = w.window?.windowNumber ?? 0
    func ev(_ type: NSEvent.EventType, _ ts: Double) -> NSEvent? {
      NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ts, windowNumber: wn, context: nil, characters: chars,
                       charactersIgnoringModifiers: chars.lowercased(), isARepeat: false, keyCode: keyCodes[code] ?? 0)
    }
    guard let d = ev(.keyDown, now), let u = ev(.keyUp, now + 0.03) else { press(i + 1); return }
    agentKeys.removeAll { Date().timeIntervalSince($0.at) > 10 }
    agentKeys.append(AgentKey(d, w, chord)); agentKeys.append(AgentKey(u, w, nil))
    w.keyDown(with: d); w.keyUp(with: u)
    barrier(t, 2) { press(i + 1) }
  }
  press(0)
}

// MARK: javascript, wait

func javascript(_ t: Tab, _ j: Job) {
  let code = j.args["code"] as? String ?? ""
  let live = { !j.done && t.onTerminate == nil } // a killed runaway's error is not the answer
  // An expression or statements? Asked in the agent's world, where the page cannot reach, and without running the code
  // (the function is never called). Then it runs once, in that form: no error, the page's own included, runs it again.
  let probe = "return typeof (async function () { return (" + code + "\n) })"
  t.web.callAsyncJavaScript(probe, arguments: [:], in: nil, in: agentWorld) { r in
    guard live() else { return }
    switch r {
    case .success: expression()
    case .failure(let e):
      let msg = jsMessage(e)
      if msg.hasPrefix("SyntaxError") { statements() } else { j.fail(msg) }
    }
  }
  func expression() {
    let body = "try { return {v: JSON.stringify(await (" + code + "\n))} } catch (e) { return {e: String(e)} }"
    t.web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { r in
      guard live() else { return }
      switch r {
      case .success(let v):
        let o = v as? [String: Any] ?? [:]
        if let e = o["e"] as? String { j.fail(e); return }
        guard let s = o["v"] as? String, let d = s.data(using: .utf8) else { j.reply(NSNull()); return }
        j.reply((try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])) ?? NSNull())
      case .failure(let e): j.fail(jsMessage(e))
      }
    }
  }
  func statements() {
    t.web.evaluateJavaScript(code, in: nil, in: .page) { r in
      guard live() else { return }
      switch r {
      case .success(let v):
        if v is NSNull { j.reply(NSNull()) } else if JSONSerialization.isValidJSONObject([v]) { j.reply(v) } else { j.fail("unsupported result type") }
      case .failure(let e):
        if (e as NSError).domain == WKError.errorDomain, (e as NSError).code == WKError.javaScriptResultTypeIsUnsupported.rawValue { j.reply(NSNull()) } // undefined
        else { j.fail(jsMessage(e)) }
      }
    }
  }
}

// A script still running at the deadline wedges its view, and a discarded view leaves its web process spinning, so
// the process is killed and the tab reloads. Only when no other tab shares that process; else it is killed once the
// last tab in it closes (`tabGone`).
var wedgedPids = Set<pid_t>()
func runaway(_ t: Tab, _ j: Job) {
  guard let pid = webPid(t.web), !tabsById.values.contains(where: { $0 !== t && webPid($0.web) == pid }) else {
    if let p = webPid(t.web) { wedgedPids.insert(p) }
    j.fail("javascript did not finish in 12 s and is still running; close the tab with browser_tabs"); return
  }
  let answer = { j.fail("javascript did not finish in 12 s; the tab was stopped and reloaded") }
  t.onTerminate = answer
  kill(pid, SIGKILL)
  DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if t.onTerminate != nil { t.onTerminate = nil; t.web.reload(); answer() } }
}

// After tabs closed (already out of `tabsById`): a wedged process no tab is left in is killed. `pid` is read from the
// closed view itself, so it is always a web process of ours.
func tabGone(_ pid: pid_t?) {
  guard let p = pid, wedgedPids.contains(p), !tabsById.values.contains(where: { webPid($0.web) == p }) else { return }
  wedgedPids.remove(p)
  kill(p, SIGKILL)
}

func waitText(_ t: Tab, _ j: Job) {
  let text = j.args["text"] as? String ?? ""
  func poll() {
    guard !j.done else { return }
    t.web.callAsyncJavaScript("return !!document.body && document.body.innerText.includes(text)", arguments: ["text": text], in: nil, in: agentWorld) { r in
      if case .success(let v) = r, (v as? Bool) == true { j.reply(["found": true]); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { poll() }
    }
  }
  poll()
}

// MARK: select_element (§6): the user picks in the panel, the element goes to the agent

func selectElement(_ g: Group, _ j: Job) {
  guard Date() < leaseUntil else { j.fail("select_element needs the herdr Browser panel open: the user picks the element there"); return }
  guard g.id == shownGroup, let cur = current else {
    j.fail("select_element needs the herdr Browser panel to show your tabs; it shows another browser now (it follows the herdr tab the user looks at)"); return
  }
  g.inflight += 1; g.used = Date()
  j.onDone = { g.inflight -= 1; g.used = Date(); g.lastDone = Date() }
  if pickWaiters.isEmpty { toPanels(["ev": "selecting", "on": true, "agent": j.conn.name], legacy: false) }
  pickWaiters.append(j)
  DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
    guard !j.done else { return }
    pickWaiters.removeAll { $0 === j }
    j.fail("no element was picked within 120 s")
    waiterGone(turnOff: true)
  }
  if !pickActive {
    pickByAgent = true
    setPick(cur, true) { ok in
      guard !ok, !j.done else { return }
      pickActive = false
      pickWaiters.removeAll { $0 === j }
      j.fail("Select element could not start")
      waiterGone(turnOff: false)
    }
  }
}
