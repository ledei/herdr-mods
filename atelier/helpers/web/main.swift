// atelier-web: Atelier's native WebKit overlay, a fork of herdr-web (~/.config/herdr-app/tools/herdr-web/main.swift).
// One borderless window with a WKWebView kept exactly over the Atelier panel's page area. The herdr mod sends the
// page rect (`rect`), keeps it shown (`lease`) and loads the shell page; mouse and keys go straight to the page.
// Protocol: newline-delimited JSON over 127.0.0.1 TCP. First line from the client: {op:"hello", token}.
// Every message either way carries `op`; replies to jsAsync/snapshot carry the request's `ref`.
// The helper sends {op:"ping"} every 10 s; clients ignore it.
// Pop-out: {op:"detach", frame?} makes the window a titled one of its own (frame: screen points, top-left origin) that
// ignores rect/lease/hide; {op:"attach"}, closing it, Cmd-W or the shell's {type:"dock"} bring it back. The helper
// sends {op:"mode", popped, frame?} on hello, on each change and when the popped window moves (frame: where it was
// last popped, for the mod to keep). {op:"state"} answers {popped, titled, visible, frame} (tests). {op:"front"}.
// --standalone x,y,w,h (screen points, top-left origin) skips Herdr: the window sits at that rect while a tab exists
// and the helper exits when its parent process does. Used by tests.
import AppKit
import WebKit
import Network

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
func arg(_ name: String) -> String? { if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }; return nil }
let herdrPid = arg("--herdr-pid").flatMap { pid_t($0) }
let standaloneRect: CGRect? = arg("--standalone").flatMap { s in
  let n = s.split(separator: ",").compactMap { Double($0) }
  return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
}
guard let portFile = arg("--port-file"), herdrPid != nil || standaloneRect != nil else {
  FileHandle.standardError.write("usage: atelier-web (--herdr-pid <pid> | --standalone x,y,w,h) --port-file <path> [--snap-dir <dir>]\n".data(using: .utf8)!)
  exit(2)
}
let parentPid = getppid()
// Snapshots may only be written under these folders: the port file's and an optional --snap-dir.
let snapDirs = ([URL(fileURLWithPath: portFile).deletingLastPathComponent().path] + [arg("--snap-dir")].compactMap { $0 })
  .map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path }
let token = (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()

// MARK: window

final class OverlayWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { popped }
  override func sendEvent(_ e: NSEvent) {
    if e.type == .leftMouseDown || e.type == .rightMouseDown { NSApp.activate(ignoringOtherApps: true) }
    super.sendEvent(e)
  }
}

// MARK: tabs

// The first click into the page counts while herdr has focus (the window activates on that click, not before), and
// right-click offers only text editing: no Back, Reload or Inspect Element for the shell.
final class PageView: WKWebView {
  override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
  static let keep: Set<String> = ["WKMenuItemIdentifierCopy", "WKMenuItemIdentifierPaste"]
  static let keepActions: Set<Selector> = [#selector(NSText.cut(_:)), #selector(NSText.copy(_:)), #selector(NSText.paste(_:)), #selector(NSText.selectAll(_:))]
  override func willOpenMenu(_ menu: NSMenu, with e: NSEvent) {
    for item in menu.items where !(item.identifier.map { Self.keep.contains($0.rawValue) } ?? false) && !(item.action.map { Self.keepActions.contains($0) } ?? false) {
      menu.removeItem(item)
    }
    super.willOpenMenu(menu, with: e)
  }
}

final class Tab: NSObject, WKNavigationDelegate, WKUIDelegate {
  let id: String
  let web: PageView
  var uiOrigin: String? // where herdr pointed this tab; only that origin's main frame may post to atelierShell
  var obs: [NSKeyValueObservation] = []
  init(id: String, config: WKWebViewConfiguration) {
    self.id = id
    web = PageView(frame: .zero, configuration: config)
    super.init()
    web.navigationDelegate = self
    web.uiDelegate = self
    web.autoresizingMask = [.width, .height]
    let push: () -> Void = { [weak self] in self?.emit() }
    obs = [web.observe(\.url) { _, _ in push() }, web.observe(\.title) { _, _ in push() }, web.observe(\.isLoading) { _, _ in push() }]
  }
  func emit() {
    send(["op": "tab", "id": id, "url": web.url?.absoluteString ?? "", "title": web.title ?? "", "loading": web.isLoading, "active": current === self])
  }
  // No popups: a board's window.open or target=_blank must not replace the shell.
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? { nil }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) { done() }
  // A board frame may navigate itself, never the shell's top frame.
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler done: @escaping (WKNavigationActionPolicy) -> Void) {
    let source = a.sourceFrame as WKFrameInfo? // nil for some API-started loads, despite the Swift type
    done(a.targetFrame?.isMainFrame == true && source?.isMainFrame == false ? .cancel : .allow)
  }
}

// MARK: page scripts

// In every frame at document start, page world (console is per content world, so the wrap must live there):
// forward console.error/warn, uncaught errors and unhandled rejections. The handler is captured now, so a page
// deleting window.webkit later changes nothing. Page code can post here too: console text is page-controlled
// anyway, and Swift caps it.
let consoleScript = #"""
(() => {
  const h = window.webkit && window.webkit.messageHandlers.atelierConsole;
  if (!h) return;
  const post = (m) => { try { h.postMessage(m); } catch (_) {} };
  let n = 0, t0 = 0;
  const show = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ? a.message + '\n' + a.stack : String(a);
    try { const j = JSON.stringify(a); return j === undefined ? String(a) : j; } catch (_) { return String(a); }
  };
  const report = (level, parts) => {
    const now = Date.now();
    if (now - t0 > 1000) { t0 = now; n = 0; }
    if (++n > 50) return;
    post({ level, text: parts.map(show).join(' ').slice(0, 1000) });
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...a) { report(level, a); return orig.apply(this, a); };
  }
  addEventListener('error', (e) => { if (e instanceof ErrorEvent) report('error', [e.error || e.message, `(${e.filename}:${e.lineno})`]); }, true);
  addEventListener('unhandledrejection', (e) => report('error', ['Unhandled rejection:', e.reason]));
})();
"""#

var consoleWindow = (start: Date.distantPast, count: 0)

final class ConsoleHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let tab = tabs.values.first(where: { $0.web === message.webView }), let m = message.body as? [String: Any] else { return }
    let now = Date()
    if now.timeIntervalSince(consoleWindow.start) >= 1 { consoleWindow = (now, 0) }
    consoleWindow.count += 1
    guard consoleWindow.count <= 50 else { return }
    send(["op": "console", "id": tab.id, "level": (m["level"] as? String) == "warn" ? "warn" : "error",
          "text": String((m["text"] as? String ?? "").prefix(300)), "frameUrl": message.frameInfo.request.url?.absoluteString ?? ""])
  }
}
let consoleHandler = ConsoleHandler()

// In every frame at document start, Atelier's own content world, out of page scripts' reach: announce the frame to
// FrameHandler.
let atelierWorld = WKContentWorld.world(name: "atelier")
let frameScript = #"""
window.webkit.messageHandlers.atelierFrame.postMessage(0);
"""#

// WebKit throttles requestAnimationFrame to half rate (about 30/s) in a cross-origin iframe the user has not
// interacted with. Boards are exactly that. Script run through WebKit's API counts as a user gesture for its frame,
// so each new board document gets one empty call, which lifts the throttle. Only Atelier's world can ask for it.
final class FrameHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard !message.frameInfo.isMainFrame, let web = message.webView else { return }
    web.callAsyncJavaScript("0", arguments: [:], in: message.frameInfo, in: atelierWorld) { _ in }
  }
}
let frameHandler = FrameHandler()

func origin(_ scheme: String, _ host: String, _ port: Int) -> String {
  let p = (scheme == "http" && port == 80) || (scheme == "https" && port == 443) ? 0 : port
  return "\(scheme.lowercased())://\(host.lowercased())" + (p == 0 ? "" : ":\(p)")
}

// The shell page posts events for herdr (send to agent, ...) to "atelierShell". Boards run in iframes on another
// origin and must never reach herdr, so only the main frame at the origin herdr itself loaded (tab/go) is accepted.
final class ShellHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    let f = message.frameInfo, o = f.securityOrigin
    guard f.isMainFrame, let tab = tabs.values.first(where: { $0.web === message.webView }), let ui = tab.uiOrigin,
          origin(o.protocol, o.host, o.port) == ui, let data = jsonValue(message.body),
          let bytes = try? JSONSerialization.data(withJSONObject: [data]), bytes.count <= 65536 else { return }
    send(["op": "shell", "id": tab.id, "data": data])
    if (data as? [String: Any])?["type"] as? String == "dock" { attach() } // the popped window's Dock button, mod or not
  }
}
let shellHandler = ShellHandler()

// WebKit renders pages at the display rate nearest 60 (72/s on a 144 Hz screen) unless this feature is off.
// It is private SPI (WKPreferences _features / _setEnabled:forFeature:); missing, pages keep the near-60 rate.
func renderAtDisplayRate(_ prefs: WKPreferences) {
  let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
  guard (WKPreferences.self as AnyObject).responds(to: list), prefs.responds(to: set),
        let all = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject],
        let f = all.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" }) else {
    FileHandle.standardError.write("atelier-web: no PreferPageRenderingUpdatesNear60FPSEnabled; rendering near 60/s\n".data(using: .utf8)!)
    return
  }
  typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
  unsafeBitCast(prefs.method(for: set), to: SetEnabled.self)(prefs, set, false, f)
}

// MARK: state

let config: WKWebViewConfiguration = {
  let c = WKWebViewConfiguration()
  c.websiteDataStore = .nonPersistent() // nothing shared with herdr-web or Safari, nothing kept between runs
  renderAtDisplayRate(c.preferences)
  let u = c.userContentController
  u.add(consoleHandler, contentWorld: .page, name: "atelierConsole")
  u.add(shellHandler, contentWorld: .page, name: "atelierShell")
  u.add(frameHandler, contentWorld: atelierWorld, name: "atelierFrame")
  u.addUserScript(WKUserScript(source: consoleScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
  u.addUserScript(WKUserScript(source: frameScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: atelierWorld))
  return c
}()
var tabs: [String: Tab] = [:]
var current: Tab?
var win: OverlayWindow!
var rect: (x: Double, y: Double, w: Double, h: Double, vw: Double, vh: Double)?
var leaseUntil = Date.distantPast
var hidden = false // standalone only: `hide` until the next `rect`/`lease`/`tab`
var shown = false
var themeBg = NSColor.black
var popped = false
var popFrame: CGRect? // where the window was last popped (screen points, top-left origin)

func hexColor(_ h: String) -> NSColor? {
  var t = h.trimmingCharacters(in: .whitespaces); if t.hasPrefix("#") { t.removeFirst() }
  guard t.count >= 6, let v = UInt32(t.prefix(6), radix: 16) else { return nil }
  return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
func blankHTML() -> String {
  let c = themeBg.usingColorSpace(.sRGB) ?? themeBg
  let hex = String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
  return "<html><body style=\"margin:0;background:\(hex)\"></body></html>"
}

func load(_ t: Tab, _ text: String?) {
  guard let u = pageURL(text), u.scheme != "about" else { t.uiOrigin = nil; t.web.loadHTMLString(blankHTML(), baseURL: nil); return }
  t.uiOrigin = u.host.map { origin(u.scheme!, $0, u.port ?? 0) }
  t.web.load(URLRequest(url: u))
}

func pageURL(_ text: String?) -> URL? {
  guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), let u = URL(string: t), let s = u.scheme?.lowercased(),
        ["http", "https", "about", "data"].contains(s) else { return nil }
  return u
}

func select(_ id: String) {
  guard let t = tabs[id] else { return }
  current = t
  // Every tab's view stays in the window and the others are hidden: re-attaching one painted white for a frame.
  if t.web.superview == nil { t.web.frame = win.contentView!.bounds; win.contentView!.addSubview(t.web) }
  for o in tabs.values { o.web.isHidden = o !== t }
  for o in tabs.values { o.emit() }
}

// MARK: Herdr's window

func herdrWindow(_ pid: pid_t) -> (id: Int, bounds: CGRect)? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  var best: (Int, CGRect)?
  for w in list {
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String], let r = CGRect(dictionaryRepresentation: b as! CFDictionary),
          let n = w[kCGWindowNumber as String] as? Int else { continue }
    if best == nil || r.width * r.height > best!.1.width * best!.1.height { best = (n, r) }
  }
  return best.map { (id: $0.0, bounds: $0.1) }
}

// What part of `r0` (screen points, top-left origin) no other app's window covers, as one rectangle: a window that
// covers a whole edge strip (a neighbour overlapping the panel's edge) just trims it, so we can stay above everything.
// Any other overlap returns `complex`: then we must stay just above Herdr's window so that window keeps covering us.
func visibleRect(_ pid: pid_t, _ herdrId: Int, _ r0: CGRect) -> (rect: CGRect, complex: Bool) {
  var r = r0
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let me = getpid()
  for w in list {
    guard let n = w[kCGWindowNumber as String] as? Int else { continue }
    if n == herdrId { break }
    guard (w[kCGWindowLayer as String] as? Int) == 0, let owner = w[kCGWindowOwnerPID as String] as? Int32, owner != pid, owner != me,
          let b = w[kCGWindowBounds as String], let wr = CGRect(dictionaryRepresentation: b as! CFDictionary),
          wr.width > 50, wr.height > 50, (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.01, wr.intersects(r) else { continue }
    let i = wr.intersection(r)
    if i.height >= r.height - 1 {
      if i.minX <= r.minX + 1 { r = CGRect(x: i.maxX, y: r.minY, width: r.maxX - i.maxX, height: r.height) }
      else if i.maxX >= r.maxX - 1 { r = CGRect(x: r.minX, y: r.minY, width: i.minX - r.minX, height: r.height) }
      else { return (r, true) }
    } else if i.width >= r.width - 1 {
      if i.minY <= r.minY + 1 { r = CGRect(x: r.minX, y: i.maxY, width: r.width, height: r.maxY - i.maxY) }
      else if i.maxY >= r.maxY - 1 { r = CGRect(x: r.minX, y: r.minY, width: r.width, height: i.minY - r.minY) }
      else { return (r, true) }
    } else { return (r, true) }
    if r.width < 8 || r.height < 8 { return (r, true) }
  }
  return (r, false)
}

// Screen points with a top-left origin (as CGWindowList and the protocol use) to AppKit's bottom-left, and back.
func appKit(_ v: CGRect) -> NSRect {
  let screenH = NSScreen.screens.first?.frame.height ?? 0
  return NSRect(x: v.minX.rounded(), y: (screenH - v.maxY).rounded(), width: v.width.rounded(), height: v.height.rounded())
}
func topLeft(_ f: NSRect) -> CGRect { CGRect(x: f.minX, y: (NSScreen.screens.first?.frame.height ?? 0) - f.maxY, width: f.width, height: f.height) }
func frameJSON(_ r: CGRect) -> [String: Int] { ["x": Int(r.minX.rounded()), "y": Int(r.minY.rounded()), "w": Int(r.width.rounded()), "h": Int(r.height.rounded())] }

func place(_ v: CGRect) { // v in screen points, top-left origin
  let f = appKit(v)
  if win.frame != f { win.setFrame(f, display: true); current?.web.frame = win.contentView!.bounds }
}

// MARK: pop-out

let overlayBehavior: NSWindow.CollectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]

func sendMode() { send(["op": "mode", "popped": popped].merging(popFrame.map { ["frame": frameJSON($0)] } ?? [:]) { a, _ in a }) }

// A frame the person can still reach: enough of it on a screen that is attached now.
func reachable(_ r: CGRect) -> Bool {
  r.width >= 320 && r.height >= 240 && NSScreen.screens.contains { s in let i = s.visibleFrame.intersection(appKit(r)); return i.width >= 120 && i.height >= 80 }
}
func defaultPopFrame() -> CGRect {
  let v = topLeft((NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800))
  let w = min(1200, v.width - 80), h = min(800, v.height - 80)
  return CGRect(x: v.midX - w / 2, y: v.midY - h / 2, width: w, height: h)
}

func detach(_ want: CGRect?) {
  let f = [want, popFrame].compactMap { $0 }.first(where: reachable) ?? defaultPopFrame()
  if !popped {
    popped = true
    win.styleMask = [.titled, .closable, .resizable] // no minimize: a docked overlay must not stay in the Dock
    win.title = "Atelier"
    win.hasShadow = true
    win.level = .normal
    win.collectionBehavior = [.managed, .participatesInCycle, .fullScreenNone] // green button zooms: attach can't meet a full-screen space
    win.minSize = NSSize(width: 320, height: 240)
  }
  win.setFrame(appKit(f), display: true)
  current?.web.frame = win.contentView!.bounds
  popFrame = topLeft(win.frame)
  win.makeKeyAndOrderFront(nil)
  NSApp.activate(ignoringOtherApps: true)
  if let w = current?.web { win.makeFirstResponder(w) }
  shown = true
  sendMode()
}

func attach() {
  guard popped else { return }
  popFrame = topLeft(win.frame)
  popped = false
  win.styleMask = [.borderless]
  win.hasShadow = false
  win.collectionBehavior = overlayBehavior
  win.minSize = NSSize(width: 1, height: 1)
  win.orderOut(nil)
  shown = false
  tick() // back over the panel at once when its rect and lease still hold
  sendMode()
}

// The popped window moved or was resized: say where, at most every 300 ms.
var modeQueued = false
final class WindowEvents: NSObject, NSWindowDelegate {
  func windowShouldClose(_ s: NSWindow) -> Bool { attach(); return false } // closing it docks it, never quits
  func windowDidMove(_ n: Notification) { moved() }
  func windowDidResize(_ n: Notification) { moved() }
  func moved() {
    guard popped, !modeQueued else { return }
    modeQueued = true
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300)) {
      modeQueued = false
      if popped { popFrame = topLeft(win.frame); sendMode() }
    }
  }
}
let windowEvents = WindowEvents()

func tick() {
  if let s = standaloneRect {
    if getppid() != parentPid { exit(0) } // the test runner is gone
    if popped { return } // its own window: it stays where the person put it
    if current == nil || hidden { if shown { win.orderOut(nil); shown = false }; return }
    place(s)
    if !shown { win.level = .floating; win.orderFrontRegardless(); shown = true }
    return
  }
  guard let pid = herdrPid else { return }
  if kill(pid, 0) != 0 { exit(0) } // Herdr is gone
  if popped { return }
  guard let r = rect, Date() < leaseUntil, current != nil, let h = herdrWindow(pid), r.w > 8, r.h > 8, r.vw > 0, r.vh > 0 else {
    if shown { win.orderOut(nil); shown = false }
    return
  }
  // The page rect is in Herdr's content units; scale to screen points and offset by the content origin.
  let b = h.bounds
  let sx = b.width / r.vw, top = max(0, b.height - r.vh * (b.width / r.vw))
  let x = b.minX + r.x * sx, y = b.minY + top + r.y * sx
  let vis = visibleRect(pid, h.id, CGRect(x: x, y: y, width: r.w * sx, height: r.h * sx))
  place(vis.rect)
  // Activating Herdr (a click, or tabbing to it) raises its window above ours for a frame, seen as a flash. So sit at
  // floating level, out of reach of any reordering, unless another app's window is over our area in a way we can't
  // trim around; then stay just above Herdr's window so that window keeps covering us.
  let want: NSWindow.Level = vis.complex ? .normal : .floating
  if win.level != want { win.level = want }
  win.order(.above, relativeTo: h.id)
  shown = true
}

// MARK: server

var conns: [NWConnection] = []
var authed = Set<ObjectIdentifier>()
func send(_ m: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(m), let d = try? JSONSerialization.data(withJSONObject: m) else { return }
  var line = d; line.append(10)
  for c in conns where authed.contains(ObjectIdentifier(c)) { c.send(content: line, completion: .contentProcessed { _ in }) }
}

// A JS value as JSON, or nil when it has none (NaN, Infinity, a Date): JSONSerialization raises on those, uncatchably.
func jsonValue(_ v: Any) -> Any? { JSONSerialization.isValidJSONObject([v]) ? v : nil }

func jsAsync(_ m: [String: Any], _ web: WKWebView) {
  let ref = m["ref"] ?? ""
  let ms = min(60000, max(1, (m["timeoutMs"] as? NSNumber)?.intValue ?? 10000))
  var done = false
  func reply(_ fields: [String: Any]) {
    if done { return }
    done = true
    send(["op": "js", "ref": ref].merging(fields) { a, _ in a })
  }
  // callAsyncJavaScript cannot be cancelled: on timeout the reply goes out once and the late result is dropped.
  DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { reply(["error": "timeout after \(ms) ms"]) }
  web.callAsyncJavaScript(m["code"] as? String ?? "", arguments: m["args"] as? [String: Any] ?? [:], in: nil, in: .page) { r in
    switch r {
    case .success(let v):
      if let j = jsonValue(v) { reply(["result": j]) } else { reply(["error": "result is not JSON (\(type(of: v)))"]) }
    case .failure(let e):
      let info = (e as NSError).userInfo
      reply(["error": (info["WKJavaScriptExceptionMessage"] as? String) ?? e.localizedDescription])
    }
  }
}

// An absolute .png path inside a snapshot folder, with symlinks resolved, or nil.
func snapPath(_ p: String?) -> URL? {
  guard let p = p, p.hasPrefix("/"), p.lowercased().hasSuffix(".png") else { return nil }
  let u = URL(fileURLWithPath: p).standardizedFileURL
  var dir = u.deletingLastPathComponent() // the nearest existing folder, real path
  while !FileManager.default.fileExists(atPath: dir.path) { dir = dir.deletingLastPathComponent() }
  let real = dir.resolvingSymlinksInPath().path + u.deletingLastPathComponent().path.dropFirst(dir.path.count) + "/"
  return snapDirs.contains { real.hasPrefix($0 + "/") } ? u : nil
}

func snapshot(_ m: [String: Any], _ web: WKWebView) {
  let ref = m["ref"] ?? ""
  guard let url = snapPath(m["path"] as? String) else {
    send(["op": "snapshot", "ref": ref, "error": "path must be an absolute .png path under \(snapDirs.joined(separator: " or "))"]); return
  }
  let cfg = WKSnapshotConfiguration()
  if let r = m["rect"] as? [String: Any] {
    func n(_ k: String) -> CGFloat { CGFloat((r[k] as? NSNumber)?.doubleValue ?? 0) }
    cfg.rect = CGRect(x: n("x"), y: n("y"), width: max(1, n("w")), height: max(1, n("h")))
  }
  cfg.afterScreenUpdates = true
  web.takeSnapshot(with: cfg) { img, err in
    do {
      // The image is sized in points and holds pixels at the window's scale; ask for that many.
      let scale = web.window?.backingScaleFactor ?? 1
      guard let img = img else { throw err ?? NSError(domain: "snapshot", code: 1) }
      var px = CGRect(x: 0, y: 0, width: img.size.width * scale, height: img.size.height * scale)
      guard let cg = img.cgImage(forProposedRect: &px, context: nil, hints: nil),
            let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { throw NSError(domain: "png encode", code: 2) }
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try png.write(to: url, options: .atomic)
      send(["op": "snapshot", "ref": ref, "path": url.path, "w": cg.width, "h": cg.height])
    } catch {
      send(["op": "snapshot", "ref": ref, "error": "\(error.localizedDescription)"])
    }
  }
}

func handle(_ m: [String: Any]) {
  guard let op = m["op"] as? String else { return }
  let id = (m["id"] as? String) ?? "t0"
  let target = tabs[id] ?? current
  switch op {
  case "rect":
    func n(_ k: String) -> Double { (m[k] as? NSNumber)?.doubleValue ?? 0 }
    rect = (n("x"), n("y"), n("w"), n("h"), n("vw"), n("vh"))
    leaseUntil = Date().addingTimeInterval(0.7); hidden = false
  case "theme":
    if let c = (m["bg"] as? String).flatMap(hexColor) {
      themeBg = c; win.backgroundColor = c
      for t in tabs.values { t.web.underPageBackgroundColor = c }
    }
  case "lease": leaseUntil = Date().addingTimeInterval(0.7); hidden = false
  case "hide": rect = nil; leaseUntil = .distantPast; hidden = true
  case "tab":
    if tabs[id] == nil {
      let t = Tab(id: id, config: config); tabs[id] = t
      t.web.underPageBackgroundColor = themeBg
      load(t, m["url"] as? String)
    }
    hidden = false
    select(id)
  case "detach":
    let f = m["frame"] as? [String: Any], v = ["x", "y", "w", "h"].compactMap { (f?[$0] as? NSNumber)?.doubleValue }
    detach(v.count == 4 ? CGRect(x: v[0], y: v[1], width: v[2], height: v[3]) : nil)
  case "attach": attach()
  case "front": if popped { win.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
  case "state":
    send(["op": "state", "ref": m["ref"] ?? "", "popped": popped, "titled": win.styleMask.contains(.titled), "visible": win.isVisible,
          "frame": frameJSON(topLeft(win.frame))])
  case "select": select(id)
  case "close":
    if let t = tabs.removeValue(forKey: id) { if current === t { current = nil }; t.web.removeFromSuperview(); t.web.stopLoading() }
  case "go": if let t = target, pageURL(m["url"] as? String) != nil { load(t, m["url"] as? String) }
  case "reload": target?.web.reload()
  case "reloadHard": target?.web.reloadFromOrigin()
  case "jsAsync":
    if let web = target?.web { jsAsync(m, web) } else { send(["op": "js", "ref": m["ref"] ?? "", "error": "no tab"]) }
  case "snapshot":
    if let web = target?.web { snapshot(m, web) } else { send(["op": "snapshot", "ref": m["ref"] ?? "", "error": "no tab"]) }
  default: break
  }
}

func serve(_ c: NWConnection) {
  conns.append(c)
  var buf = Data()
  func read() {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, err in
      if let d = data { buf.append(d) }
      if !authed.contains(ObjectIdentifier(c)) && buf.count > 4096 { c.cancel(); return } // no hello, no big buffer
      while let i = buf.firstIndex(of: 10) {
        let line = buf.subdata(in: buf.startIndex..<i); buf.removeSubrange(buf.startIndex...i)
        DispatchQueue.main.async {
          guard let m = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
          if !authed.contains(ObjectIdentifier(c)) {
            if m["op"] as? String == "hello", m["token"] as? String == token { authed.insert(ObjectIdentifier(c)); send(["op": "hello"]); sendMode(); for t in tabs.values { t.emit() } } else { c.cancel() }
            return
          }
          handle(m)
        }
      }
      if done || err != nil { DispatchQueue.main.async { authed.remove(ObjectIdentifier(c)); conns.removeAll { $0 === c } }; c.cancel(); return }
      read()
    }
  }
  c.start(queue: .main)
  read()
}

// MARK: keys and menu

// An accessory app has no menu bar, so without these items cmd-c, cmd-v, cmd-x, cmd-a and cmd-z do nothing in the page.
func installMenu() {
  let main = NSMenu()
  main.addItem(NSMenuItem()) // the app menu slot
  let editItem = NSMenuItem()
  let edit = NSMenu(title: "Edit")
  edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
  let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
  redo.keyEquivalentModifierMask = [.command, .shift]
  edit.addItem(.separator())
  edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  editItem.submenu = edit
  main.addItem(editItem)
  NSApp.mainMenu = main
}

// Atelier's keys while the page has the keyboard: Cmd-R reloads (Cmd-Shift-R from origin), Cmd-W docks a
// popped window and else does nothing.
func installKeys() {
  NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
    let f = e.modifierFlags
    guard e.window === win, f.contains(.command), !f.contains(.control), !f.contains(.option) else { return e }
    switch e.charactersIgnoringModifiers?.lowercased() ?? "" {
    case "r": if f.contains(.shift) { current?.web.reloadFromOrigin() } else { current?.web.reload() }; return nil
    case "w": if popped { win.performClose(nil) }; return nil
    default: return e
    }
  }
}

// MARK: main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
win = OverlayWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
win.isOpaque = true
win.hasShadow = false
win.backgroundColor = themeBg
win.isReleasedWhenClosed = false
win.collectionBehavior = overlayBehavior
win.delegate = windowEvents
win.contentView = NSView(frame: win.contentRect(forFrameRect: win.frame))
installMenu()
installKeys()

let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
let listener = try! NWListener(using: params)
listener.newConnectionHandler = { serve($0) }
listener.stateUpdateHandler = { st in
  if case .ready = st, let p = listener.port {
    let text = "\(p.rawValue)\n\(token)"
    let url = URL(fileURLWithPath: portFile)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: portFile, contents: text.data(using: .utf8), attributes: [.posixPermissions: 0o600])
    print("atelier-web listening on \(p.rawValue)")
  }
}
listener.start(queue: .main)
Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in tick() }
// herdr's `net` socket fails a read that sees no bytes for 30 s, which ended the mod's session: say something every 10 s.
Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in send(["op": "ping"]) }
app.run()
