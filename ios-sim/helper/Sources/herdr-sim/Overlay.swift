// `herdr-sim overlay`: the simulator for stock Herdr, which cannot draw an IOSurface itself. The mod
// draws an empty docked block; this helper shows the framebuffer in its own borderless, non-activating
// panel kept over that block, and turns mouse and trackpad input on the panel into touches.
//
// Transport: TCP on 127.0.0.1 (random port), newline-delimited JSON both ways; `<port>\n<token>\n` goes
// to --port-file (0600). A client's first line must be {"op":"hello","token":T}, else it is closed.
// mod -> helper: attach {udid} | detach | listDevices | edges {tag, seq, left, top, right, bottom: [a, o], radius}
//   (edge = host size * a + o points; host = Herdr's window incl. titlebar, top-left origin) | lease {tag}
//   | hide {tag} | key {code, down} | text {text} | button {name, phase?} | rotate {dir: left|right}
//   | annotate {on} | quit
// helper -> mod: ping (every 5 s) | devices {devices} | attached {udid, width, height, scale} (portrait
//   points; a rotation event follows) | rotation {value} | streamEnded | pick {label, type, id,
//   frame: [x, y, w, h], imagePath} | error {message}
// Each mod copy has its own tag. The panel follows the copy that sent edges last while that copy's
// lease holds (an edges or lease line in the last 600 ms) and it has not said hide; stale seqs are dropped.
// Exits when the Herdr pid dies, on quit, or after 10 s without a client.
//
// Test hook: with HERDR_SIM_TEST_INPUT=<fifo>, lines `down|drag|up|move x y` and
// `scroll x y dx dy began|changed|ended|wheel` (panel points, top-left origin) become synthetic events
// on the panel, so tests never send real input.
import AppKit
import FBSimulatorControl
import Foundation
import IOSurface
import QuartzCore

private func olog(_ s: String) { FileHandle.standardError.write(Data("herdr-sim overlay: \(s)\n".utf8)) }
private func now() -> Double { CACurrentMediaTime() }

private let rotations = ["upright", "clockwise", "upsideDown", "counterclockwise"]
/// Index = clockwise quarter turns, matching `rotations` (rotate right goes clockwise, like Simulator.app's Cmd-Right).
private let orientations = ["portrait", "landscapeRight", "portraitUpsideDown", "landscapeLeft"]

// MARK: host window

// CGWindowListCreate is marked unavailable in Swift; it returns bare CGWindowIDs, front to back.
@_silgen_name("CGWindowListCreate") private func _CGWindowListCreate(_ o: UInt32, _ w: UInt32) -> Unmanaged<CFArray>?
private func windowIDsAbove(_ w: CGWindowID) -> [CGWindowID] {
  guard let a = _CGWindowListCreate(CGWindowListOption.optionOnScreenAboveWindow.rawValue, w)?.takeRetainedValue() else { return [] }
  return (0..<CFArrayGetCount(a)).map { CGWindowID(UInt(bitPattern: CFArrayGetValueAtIndex(a, $0))) }
}

private func cgBounds(_ d: [String: Any]) -> CGRect {
  (d[kCGWindowBounds as String]).flatMap { CGRect(dictionaryRepresentation: $0 as! CFDictionary) } ?? .null
}

/// A window's on-screen flag and CG bounds (global, top-left origin); nil once it is gone.
private func describeWindow(_ id: CGWindowID) -> (on: Bool, frame: CGRect)? {
  var raw = UnsafeRawPointer(bitPattern: UInt(id))
  guard let d = (CGWindowListCreateDescriptionFromArray(CFArrayCreate(nil, &raw, 1, nil)) as? [[String: Any]])?.first else { return nil }
  return ((d[kCGWindowIsOnscreen as String] as? Bool) == true, cgBounds(d))
}

/// The pid's largest on-screen normal-level window. window.bounds() inside Herdr is not where it really is.
private func mainWindow(of pid: pid_t) -> CGWindowID? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  func area(_ d: [String: Any]) -> CGFloat { let b = cgBounds(d); return b.width * b.height }
  return list.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .max { area($0) < area($1) }
    .flatMap { $0[kCGWindowNumber as String] as? CGWindowID }
}

// MARK: clients

final class Client: @unchecked Sendable {
  let fd: Int32
  let out = DispatchQueue(label: "herdr-sim.overlay.client")  // writes stay in order and off the main thread
  var authed = false  // main thread only
  init(fd: Int32) { self.fd = fd }
  func send(_ obj: [String: Any]) {
    guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    d.append(10)
    out.async { [fd] in
      d.withUnsafeBytes { p in
        var off = 0
        while off < p.count {
          let w = write(fd, p.baseAddress! + off, p.count - off)
          if w < 0 && errno == EINTR { continue }
          if w <= 0 { return }
          off += w
        }
      }
    }
  }
  /// The reader then sees end of input and drops the client.
  func close() { shutdown(fd, SHUT_RDWR) }
}

private func listenTCP(portFile: String, token: String, _ o: Overlay) {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  var a = sockaddr_in()
  a.sin_family = sa_family_t(AF_INET)
  a.sin_addr.s_addr = inet_addr("127.0.0.1")
  var len = socklen_t(MemoryLayout<sockaddr_in>.size)
  let bound = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 } }
  guard fd >= 0, bound, Darwin.listen(fd, 8) == 0 else { fail("overlay: cannot listen on 127.0.0.1") }
  let tmp = portFile + ".tmp"
  let f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  let text = "\(UInt16(bigEndian: a.sin_port))\n\(token)\n"
  guard f >= 0, fchmod(f, 0o600) == 0, write(f, text, text.utf8.count) == text.utf8.count, Darwin.close(f) == 0, rename(tmp, portFile) == 0 else {
    fail("overlay: cannot write \(portFile)")
  }
  olog("listening on 127.0.0.1:\(UInt16(bigEndian: a.sin_port))")
  Thread.detachNewThread {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 { continue }
      var one: Int32 = 1
      setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, 4)
      setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, 4)
      let client = Client(fd: c)
      DispatchQueue.main.async { o.connected(client) }
      Thread.detachNewThread {
        var buf = [UInt8](repeating: 0, count: 65536), pending = Data()
        while pending.count < 1 << 20 {
          let k = read(c, &buf, buf.count)
          if k < 0 && errno == EINTR { continue }
          if k <= 0 { break }
          pending.append(contentsOf: buf[0..<k])
          while let i = pending.firstIndex(of: 10) {
            let line = String(decoding: pending[pending.startIndex..<i], as: UTF8.self)
            pending = Data(pending[(i + 1)...])
            DispatchQueue.main.async { o.line(client, line) }
          }
        }
        DispatchQueue.main.async { o.gone(client) }
        client.out.async { Darwin.close(c) }
      }
    }
  }
}

// MARK: device input

enum Touch: Equatable { case down(CGPoint), move(CGPoint), up(CGPoint) }

/// Everything sent to the device, one at a time and in order. Each HID send takes ~90 ms, so while one
/// is in flight the next moves fold into one (the latest point wins); downs, ups and other jobs are never
/// dropped. A failed job drops the waiting moves (stale).
@MainActor final class HIDQueue {
  private enum Job { case touch(Touch), work(() async throws -> Void, quiet: Bool, then: (() -> Void)?) }
  let dev: Device
  let onError: (String) -> Void
  private var jobs: [Job] = []
  private var busy = false
  init(_ dev: Device, onError: @escaping (String) -> Void) { self.dev = dev; self.onError = onError }

  var idle: Bool { !busy && jobs.isEmpty }

  func touch(_ t: Touch) {
    if case .move = t, case .touch(.move)? = jobs.last { jobs.removeLast() }
    jobs.append(.touch(t))
    pump()
  }

  /// `quiet`: a failure is not reported (a hover over nothing). `then` runs on the main thread either way.
  func run(quiet: Bool = false, _ job: @escaping () async throws -> Void, then: (() -> Void)? = nil) {
    jobs.append(.work(job, quiet: quiet, then: then))
    pump()
  }

  private func pump() {
    guard !busy, !jobs.isEmpty else { return }
    busy = true
    let job = jobs.removeFirst()
    Task { @MainActor in
      var failed = false
      do {
        switch job {
        case .touch(.down(let p)), .touch(.move(let p)): try await dev.touch("down", p.x, p.y)
        case .touch(.up(let p)): try await dev.touch("up", p.x, p.y)
        case .work(let w, _, _): try await w()
        }
      } catch {
        failed = true
        if case .work(_, true, _) = job {} else { onError((error as? Fail)?.msg ?? "\(error)") }
      }
      if case .work(_, _, let then?) = job { then() }
      busy = false
      if failed { jobs.removeAll { if case .touch(.move) = $0 { return true } else { return false } } }
      pump()
    }
  }
}

private func inset(_ p: CGPoint, _ s: CGSize) -> CGPoint {
  // A finger near an edge could start a system gesture (the home bar's swipe up).
  CGPoint(x: min(max(p.x, s.width * 0.1), s.width * 0.9), y: min(max(p.y, s.height * 0.1), s.height * 0.9))
}

/// A trackpad gesture as one finger on the device, so iOS scrolls it like a drag and decelerates it
/// itself (macOS momentum is ignored). The finger goes down on the first movement, re-grips where it
/// started when it hits the screen edge, and is lifted when the gesture goes quiet without an end.
struct TrackpadFinger {
  private var armed: CGPoint?
  private var grip: (start: CGPoint, total: CGVector, at: CGPoint)?
  private var last = 0.0
  var isDown: Bool { grip != nil }

  mutating func feed(_ phase: NSEvent.Phase, at: CGPoint?, _ d: CGVector, _ size: CGSize) -> [Touch] {
    var out = liftIfQuiet().map { [$0] } ?? []
    last = now()
    if phase.contains(.began) || phase.contains(.mayBegin) {
      if grip == nil { armed = at }
    } else if phase.contains(.changed), d != .zero, grip != nil || armed != nil {
      if let from = armed {
        let s = inset(from, size)
        grip = (s, .zero, s)
        out.append(.down(s))
        armed = nil
      }
      var g = grip!
      g.total.dx += d.dx; g.total.dy += d.dy
      let to = CGPoint(x: g.start.x + g.total.dx, y: g.start.y + g.total.dy)
      let held = CGPoint(x: min(max(to.x, 0), size.width), y: min(max(to.y, 0), size.height))
      out.append(.move(held))
      g.at = held
      if held != to {  // the edge: lift and grip again where it started, so a long scroll goes on
        out += [.up(held), .down(g.start)]
        g.total = .zero
        g.at = g.start
      }
      grip = g
    } else if phase.contains(.ended) || phase.contains(.cancelled) {
      armed = nil
      if let g = grip { out.append(.up(g.at)); grip = nil }
    }
    return out
  }

  mutating func liftIfQuiet() -> Touch? {
    guard let g = grip, now() - last >= 0.5 else { return nil }
    armed = g.start
    grip = nil
    return .up(g.at)
  }

  /// A click takes the finger: where to lift it, if it was down.
  mutating func cancel() -> CGPoint? {
    armed = nil
    defer { grip = nil }
    return grip?.at
  }
}

// MARK: panel

final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }  // never takes keyboard focus from Herdr
  override var canBecomeMain: Bool { false }
}

@MainActor final class SimView: NSView {
  weak var overlay: Overlay?
  let screen = CALayer()
  let hover = CAShapeLayer()
  let picks = CALayer()
  var points = CGSize.zero { didSet { relayout() } }  // portrait device points
  var turns = 0 { didSet { relayout() } }  // clockwise quarter turns that draw the portrait surface upright
  var annotate = false { didSet { hoverFrame = nil; pickFrames = []; hoverAt = nil } }
  var hoverFrame: CGRect? { didSet { relayout() } }  // device points
  var pickFrames: [CGRect] = [] { didSet { relayout() } }
  private var finger: CGPoint?
  private var pad = TrackpadFinger()
  private var liftTimer: Timer?
  private var wheel = (pending: CGVector.zero, at: CGPoint.zero, last: 0.0, busy: false)
  private var hoverAt: CGPoint?
  private var hoverBusy = false
  private var rest: Timer?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer!.backgroundColor = NSColor.black.cgColor
    layer!.masksToBounds = true
    screen.contentsGravity = .resize
    screen.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "transform": NSNull()]
    hover.fillColor = NSColor.systemBlue.withAlphaComponent(0.15).cgColor
    hover.strokeColor = NSColor.systemBlue.cgColor
    hover.lineWidth = 2
    for l in [screen, picks, hover] { layer!.addSublayer(l) }
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect], owner: self))
  }
  required init?(coder: NSCoder) { fatalError() }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }  // the first click touches, it does not just focus
  override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); relayout() }

  private var onScreen: CGSize { turns % 2 == 1 ? CGSize(width: points.height, height: points.width) : points }

  /// Where the turned screen draws: centered, aspect kept.
  private func fitted() -> CGRect? {
    let s = onScreen
    guard s.width > 0, s.height > 0, bounds.width > 0, bounds.height > 0 else { return nil }
    let k = min(bounds.width / s.width, bounds.height / s.height)
    return CGRect(x: bounds.midX - s.width * k / 2, y: bounds.midY - s.height * k / 2, width: s.width * k, height: s.height * k)
  }

  private func relayout() {
    guard let f = fitted() else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    screen.bounds = turns % 2 == 1 ? CGRect(x: 0, y: 0, width: f.height, height: f.width) : CGRect(origin: .zero, size: f.size)
    screen.position = CGPoint(x: f.midX, y: f.midY)
    screen.transform = CATransform3DMakeRotation(-CGFloat(turns) * .pi / 2, 0, 0, 1)  // negative: clockwise in a y-up layer
    hover.path = hoverFrame.map { CGPath(rect: toView($0, f), transform: nil) }
    picks.sublayers = pickFrames.map {
      let l = CAShapeLayer()
      l.path = CGPath(rect: toView($0, f), transform: nil)
      l.fillColor = NSColor.systemOrange.withAlphaComponent(0.2).cgColor
      l.strokeColor = NSColor.systemOrange.cgColor
      l.lineWidth = 2
      return l
    }
    CATransaction.commit()
  }

  /// On-screen device points (top-left origin) to view points.
  private func toView(_ r: CGRect, _ f: CGRect) -> CGRect {
    let kx = f.width / onScreen.width, ky = f.height / onScreen.height
    return CGRect(x: f.minX + r.minX * kx, y: f.maxY - r.maxY * ky, width: r.width * kx, height: r.height * ky)
  }

  /// A view point as on-screen device points. Outside the screen: nil, or the nearest edge with `clamp`.
  func toDevice(_ p: NSPoint, clamp: Bool) -> CGPoint? {
    guard let f = fitted() else { return nil }
    let fx = (p.x - f.minX) / f.width, fy = (f.maxY - p.y) / f.height
    if !clamp && !((0...1).contains(fx) && (0...1).contains(fy)) { return nil }
    return CGPoint(x: min(max(fx, 0), 1) * onScreen.width, y: min(max(fy, 0), 1) * onScreen.height)
  }

  private func loc(_ e: NSEvent) -> NSPoint {
    if e.window === window { return convert(e.locationInWindow, from: nil) }
    // A test-hook scroll is built from a CGEvent and carries only a global location.
    let g = e.cgEvent?.location ?? .zero
    return convert(window!.convertPoint(fromScreen: NSPoint(x: g.x, y: NSScreen.screens[0].frame.height - g.y)), from: nil)
  }

  private func push(_ t: Touch) { overlay?.hid?.touch(t) }

  override func mouseDown(with e: NSEvent) {
    guard let p = toDevice(loc(e), clamp: false) else { return }
    if annotate { overlay?.pick(p); return }
    if let up = pad.cancel() { push(.up(up)) }
    finger = p
    push(.down(p))
  }

  override func mouseDragged(with e: NSEvent) {
    guard finger != nil, let p = toDevice(loc(e), clamp: true), p != finger else { return }
    finger = p
    push(.move(p))
  }

  override func mouseUp(with e: NSEvent) {
    guard let last = finger else { return }
    finger = nil
    let p = toDevice(loc(e), clamp: true) ?? last
    if p != last { push(.move(p)) }
    push(.up(p))
  }

  override func scrollWheel(with e: NSEvent) {
    guard !annotate, finger == nil, e.momentumPhase.isEmpty, let f = fitted() else { return }
    let at = toDevice(loc(e), clamp: false)
    if e.phase.isEmpty {  // a mouse wheel: swipes of the scrolled distance
      guard let at else { return }
      let k = e.hasPreciseScrollingDeltas ? onScreen.width / f.width : 40
      scrollBySwipes(at, CGVector(dx: e.scrollingDeltaX * k, dy: e.scrollingDeltaY * k))
      return
    }
    let k = onScreen.width / f.width
    for t in pad.feed(e.phase, at: at, CGVector(dx: e.scrollingDeltaX * k, dy: e.scrollingDeltaY * k), onScreen) { push(t) }
    if pad.isDown && liftTimer == nil {
      liftTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] t in
        MainActor.assumeIsolated {
          guard let self else { return t.invalidate() }
          if let up = self.pad.liftIfQuiet() { self.push(up) }
          if !self.pad.isDown { t.invalidate(); self.liftTimer = nil }
        }
      }
    }
  }

  /// One swipe at a time (the device is busy while it runs), in whole 24-point steps so a tail never becomes a tap.
  private func scrollBySwipes(_ at: CGPoint, _ d: CGVector) {
    if now() - wheel.last >= 0.3 { wheel.pending = .zero }
    wheel.last = now()
    wheel.at = at
    wheel.pending.dx += d.dx; wheel.pending.dy += d.dy
    swipeIfReady()
  }

  private func swipeIfReady() {
    guard !wheel.busy, hypot(wheel.pending.dx, wheel.pending.dy) >= 24, finger == nil, !pad.isDown,
          let q = overlay?.hid, q.idle else { return }
    let s = onScreen, from = inset(wheel.at, s)
    let to = CGPoint(x: min(max(from.x + wheel.pending.dx, 0), s.width), y: min(max(from.y + wheel.pending.dy, 0), s.height))
    wheel.pending = .zero
    wheel.busy = true
    let dev = q.dev
    q.run({ try await dev.send(.swipe(from.x, yStart: from.y, xEnd: to.x, yEnd: to.y, delta: SimulatorHIDEvent.defaultSwipeDelta, duration: 0.1)) }) { [weak self] in
      guard let self else { return }
      self.wheel.busy = false
      if now() - self.wheel.last >= 0.3 { self.wheel.pending = .zero }
      self.swipeIfReady()
    }
  }

  // Annotate: what is under the pointer once it rests 80 ms, one question at a time.
  override func mouseMoved(with e: NSEvent) {
    guard annotate else { return }
    hoverAt = toDevice(loc(e), clamp: false)
    if hoverAt == nil { hoverFrame = nil }
    rest?.invalidate()
    rest = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.askHover() } }
  }

  override func mouseExited(with e: NSEvent) { hoverAt = nil; hoverFrame = nil }

  private func askHover() {
    guard annotate, !hoverBusy, let at = hoverAt, let q = overlay?.hid else { return }
    hoverBusy = true
    let sim = q.dev.sim
    q.run(quiet: true, {
      let el = try await element(at: at.x, at.y, in: sim, imagePath: nil)
      await MainActor.run { if self.annotate && self.hoverAt != nil { self.hoverFrame = frameOf(el) } }
    }) { [weak self] in
      guard let self else { return }
      self.hoverBusy = false
      if self.hoverAt != nil && self.hoverAt != at { self.askHover() }
    }
  }
}

private func frameOf(_ el: [String: Any]) -> CGRect? {
  guard let f = el["frame"] as? [String: Double], let x = f["x"], let y = f["y"], let w = f["width"], let h = f["height"] else { return nil }
  return CGRect(x: x, y: y, width: w, height: h)
}

// MARK: overlay

@MainActor final class Overlay: NSObject {
  let pid: pid_t
  let token: String
  let panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  let view = SimView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
  private var clients: [ObjectIdentifier: Client] = [:]
  private var lastClient = now()
  private var link: CADisplayLink?
  // Herdr's window
  private var target: CGWindowID = 0
  private var host = CGRect.null
  private var hostOn = false
  private var resizedAt = -1.0
  private var genie = false  // the window changed size with no corner kept: minimize or restore is playing
  private var lastFind = 0.0
  // the mod's copies
  private struct Copy { var seq = -Double.infinity, edges: [Double]?, live = 0.0, hidden = false }
  private var copies: [String: Copy] = [:]
  private var lastTag: String?
  private var shown = false
  // the device
  private(set) var hid: HIDQueue?
  private var udid: String?
  private var stream = 0  // bumped on every attach and detach: events from an older stream are ignored
  private var rotation = "upright"
  private var asked: (next: Int, seen: Int)?  // the last orientation asked for, and the rotation then
  private var pickCount = 0
  private lazy var pickDir: String = {
    let d = NSHomeDirectory() + "/Library/Caches/herdr-sim/overlay-\(getpid())-\(Int(Date().timeIntervalSince1970))"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return d
  }()
  private var exitWatch: DispatchSourceProcess?

  init(pid: pid_t, token: String) {
    self.pid = pid
    self.token = token
    super.init()
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.animationBehavior = .none  // the default scale-in would put the panel off its block while it plays
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.acceptsMouseMovedEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    view.overlay = self
    panel.contentView = view

    exitWatch = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    exitWatch!.setEventHandler { olog("Herdr (\(pid)) exited"); exit(0) }
    exitWatch!.resume()
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
      // Herdr coming to the front lifts its window over the panel: put the panel back at once, not on the next tick.
      guard (n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == pid else { return }
      MainActor.assumeIsolated { if let self, self.shown { self.panel.order(.above, relativeTo: Int(self.target)) } }
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.emit(["ev": "ping"]) } }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        if self.clients.values.contains(where: { $0.authed }) { self.lastClient = now() }
        if now() - self.lastClient > 10 { olog("no client for 10 s; exiting"); exit(0) }
      }
    }
    link = NSScreen.screens[0].displayLink(target: self, selector: #selector(tick))
    link!.add(to: .main, forMode: .common)
    link!.isPaused = true
  }

  // MARK: clients

  func connected(_ c: Client) { clients[ObjectIdentifier(c)] = c }
  func gone(_ c: Client) { clients[ObjectIdentifier(c)] = nil }
  func emit(_ obj: [String: Any]) { for c in clients.values where c.authed { c.send(obj) } }
  private func error(_ m: String) { emit(["ev": "error", "message": m]) }

  func line(_ c: Client, _ s: String) {
    let r = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    let op = r["op"] as? String ?? ""
    guard c.authed else {
      if op == "hello" && r["token"] as? String == token { c.authed = true } else { c.close() }
      return
    }
    func num(_ k: String) -> Double? { (r[k] as? NSNumber)?.doubleValue }
    func pair(_ k: String) -> [Double]? {
      guard let a = r[k] as? [NSNumber], a.count == 2 else { return nil }
      return a.map(\.doubleValue)
    }
    let tag = r["tag"] as? String
    switch op {
    case "listDevices":
      Task.detached {
        do {
          let list = try devices().map { ["udid": $0.udid, "name": $0.name, "runtime": $0.runtime, "state": $0.state] }
          c.send(["ev": "devices", "devices": list])
        } catch { c.send(["ev": "error", "message": (error as? Fail)?.msg ?? "\(error)"]) }
      }
    case "attach":
      guard let u = r["udid"] as? String else { return error("attach: missing udid") }
      Task { await attach(u) }
    case "detach": detach()
    case "edges":
      guard let tag, let seq = num("seq"), let l = pair("left"), let t = pair("top"), let rt = pair("right"), let b = pair("bottom") else {
        return error("edges: needs tag, seq, left, top, right, bottom")
      }
      var cp = copies[tag] ?? Copy()
      guard seq > cp.seq else { return }  // an older layout pass that arrived late
      cp.seq = seq
      cp.edges = l + t + rt + b
      cp.live = now()
      cp.hidden = false
      copies[tag] = cp
      lastTag = tag
      if let radius = num("radius") { view.layer!.cornerRadius = radius }
      apply()
    case "lease":
      guard let tag, copies[tag] != nil else { return }
      copies[tag]!.live = now()
      apply()
    case "hide":
      guard let tag else { return }
      copies[tag, default: Copy()].hidden = true
      apply()
    case "key":
      guard let code = num("code") else { return error("key: missing code") }
      let down = r["down"] as? Bool ?? true
      device { d in try await d.send(.keyboard(direction: down ? .down : .up, keyCode: UInt32(code))) }
    case "text":
      guard let text = r["text"] as? String else { return error("text: missing text") }
      device { d in try await d.send(try textEvents(text)) }
    case "button":
      let name = r["name"] as? String, phase = r["phase"] as? String
      device { d in try await d.button(name, phase: phase) }
    case "rotate": rotate(right: r["dir"] as? String != "left")
    case "annotate": view.annotate = r["on"] as? Bool ?? false
    case "quit":
      olog("quit")
      exit(0)
    default: error("unknown op '\(op)'")
    }
  }

  private func device(_ job: @escaping (Device) async throws -> Void) {
    guard let q = hid else { return error("no device attached") }
    let d = q.dev
    q.run { try await job(d) }
  }

  // MARK: device

  private func attach(_ u: String) async {
    detach()
    let mine = stream
    do {
      let d = Device(try connect(u))
      let att = try await d.sim.framebuffer.connect().attach()
      guard stream == mine else { att.cancel(); return }  // detached or attached again meanwhile
      d.attachment = att
      let p = try pointSize(d.sim)
      udid = u
      hid = HIDQueue(d) { [weak self] in self?.error($0) }
      rotation = (try? att.initialConfiguration?.activeGeometry()).map { "\($0.rotation)" } ?? "upright"
      asked = nil
      view.points = CGSize(width: p.w, height: p.h)
      view.turns = max(0, rotations.firstIndex(of: rotation) ?? 0)
      view.screen.contents = att.initialSurface
      emit(["ev": "attached", "udid": u, "width": p.w, "height": p.h, "scale": p.scale])
      emit(["ev": "rotation", "value": rotation])
      link?.isPaused = false
      olog("attached \(u)")
      hid!.run { if d.hid == nil { d.hid = try await d.sim.hid.connect() } }  // ~0.5 s: not on the first touch
      Task.detached { [weak self] in
        for await e in att.events {
          switch e {
          case .surfaceChanged(let s?): DispatchQueue.main.async { if self?.stream == mine { self?.view.screen.contents = s } }
          case .frameRendered:
            DispatchQueue.main.async {
              guard let self, self.stream == mine else { return }
              CATransaction.begin()
              CATransaction.setDisableActions(true)
              self.view.screen.perform(Selector(("setContentsChanged")))
              CATransaction.commit()
            }
          case .configurationChanged(let cfg):
            if cfg.phase == .settled, let g = try? cfg.activeGeometry() {
              let r = "\(g.rotation)"
              DispatchQueue.main.async { if self?.stream == mine { self?.rotated(r) } }
            }
          case .ended(let why):
            DispatchQueue.main.async {
              guard let self, self.stream == mine else { return }
              olog("stream ended: \(why)")
              self.detach()
              self.emit(["ev": "streamEnded"])
            }
            return
          default: break
          }
        }
      }
    } catch {
      if stream == mine { self.error("attach \(u): \((error as? Fail)?.msg ?? "\(error)")") }
    }
  }

  private func detach() {
    stream += 1
    hid?.dev.attachment?.cancel()
    hid = nil
    udid = nil
    view.screen.contents = nil
    view.annotate = false
    link?.isPaused = true
    apply()
  }

  private func rotated(_ r: String) {
    guard r != rotation else { return }
    rotation = r
    view.turns = max(0, rotations.firstIndex(of: r) ?? 0)
    view.pickFrames = []
    view.hoverFrame = nil
    emit(["ev": "rotation", "value": r])
  }

  private func rotate(right: Bool) {
    let seen = max(0, rotations.firstIndex(of: rotation) ?? 0)
    // An orientation the app ignored (most skip upside down) leaves the rotation where it was: go on from the one asked for.
    let base = asked.flatMap { $0.seen == seen ? $0.next : nil } ?? seen
    let next = (base + (right ? 1 : 3)) % 4
    asked = (next, seen)
    let mine = stream
    device { d in
      let r = try await d.rotate(orientations[next])
      await MainActor.run { if self.stream == mine { self.rotated(r) } }
    }
  }

  func pick(_ at: CGPoint) {
    guard let q = hid else { return }
    pickCount += 1
    let path = "\(pickDir)/pick-\(pickCount).png", sim = q.dev.sim
    q.run {
      let el = try await element(at: at.x, at.y, in: sim, imagePath: path)
      await MainActor.run {
        guard self.view.annotate, let f = frameOf(el) else { return }
        self.view.pickFrames.append(f)
        self.emit(["ev": "pick", "label": el["label"] ?? NSNull(), "type": el["type"] ?? NSNull(), "id": el["identifier"] ?? NSNull(),
                   "frame": [f.minX, f.minY, f.width, f.height], "imagePath": path])
      }
    }
  }

  // MARK: placement

  @objc func tick(_ l: CADisplayLink) {
    let t = now()
    var d = describeWindow(target)
    if d?.on != true && t - lastFind > 0.5 {  // gone or hidden: Herdr may have another window now
      lastFind = t
      if let w = mainWindow(of: pid), w != target {
        target = w
        d = describeWindow(w)
        olog("following window \(w)")
      }
    }
    let on = d?.on == true, b = d?.frame ?? .null
    if on && !host.isNull && b.size != host.size {
      // A live resize keeps the opposite corner where it was; the genie moves all four. Only the genie hides the panel,
      // so a resize the mod sends no edges for (its block keeps its size) is followed by the anchored edges alone.
      let corners = { (r: CGRect) in [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.maxX, y: r.maxY)] }
      if !corners(b).contains(where: corners(host).contains) { genie = true }
      resizedAt = t
    }
    if genie && t - resizedAt >= 0.15 { genie = false }
    hostOn = on
    if on { host = b }
    apply()
  }

  /// Shows the panel where the current copy's edges put it, or hides it.
  private func apply() {
    let t = now()
    let live = copies.filter { !$0.value.hidden && $0.value.edges != nil && t - $0.value.live < 0.6 }
    let tag = lastTag.flatMap { live[$0] != nil ? $0 : nil } ?? live.max { $0.value.live < $1.value.live }?.key
    var want: CGRect?
    if let tag, let e = copies[tag]?.edges, hostOn, !genie, hid != nil {
      let x0 = host.width * e[0] + e[1], y0 = host.height * e[2] + e[3]
      let x1 = host.width * e[4] + e[5], y1 = host.height * e[6] + e[7]
      if x1 - x0 >= 1 && y1 - y0 >= 1 { want = CGRect(x: host.minX + x0, y: host.minY + y0, width: x1 - x0, height: y1 - y0) }
    }
    guard let g = want else {
      if shown { panel.orderOut(nil); shown = false }
      return
    }
    let frame = NSRect(x: g.minX, y: NSScreen.screens[0].frame.height - g.maxY, width: g.width, height: g.height)
    if panel.frame != frame { panel.setFrame(frame, display: false) }
    if !shown || windowIDsAbove(target).last.map(Int.init) != panel.windowNumber {
      panel.order(.above, relativeTo: Int(target))
      shown = true
    }
  }

  // MARK: test hook

  func inject(_ line: String) {
    let p = line.split(separator: " ").map(String.init)
    guard p.count >= 3, let x = Double(p[1]), let y = Double(p[2]) else { return olog("test input: bad line '\(line)'") }
    let wp = NSPoint(x: x, y: view.bounds.height - y)
    let types: [String: NSEvent.EventType] = ["down": .leftMouseDown, "drag": .leftMouseDragged, "up": .leftMouseUp, "move": .mouseMoved]
    if let type = types[p[0]] {
      guard let e = NSEvent.mouseEvent(with: type, location: wp, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
      // A moved event reaches tracking-area owners, not through sendEvent's hit test.
      if type == .mouseMoved { view.mouseMoved(with: e) } else { panel.sendEvent(e) }
      return
    }
    guard p[0] == "scroll", p.count == 6, let dx = Int32(p[3]), let dy = Int32(p[4]) else { return olog("test input: bad line '\(line)'") }
    let phases: [String: Int64] = ["began": 1, "changed": 2, "ended": 4, "wheel": 0]
    guard let phase = phases[p[5]], let ev = CGEvent(scrollWheelEvent2Source: nil, units: phase == 0 ? .line : .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
    let s = panel.convertPoint(toScreen: wp)
    ev.location = CGPoint(x: s.x, y: NSScreen.screens[0].frame.height - s.y)
    if phase != 0 {
      ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      ev.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      ev.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy))
      ev.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(dx))
    }
    if let e = NSEvent(cgEvent: ev) { view.scrollWheel(with: e) }
  }
}

private func readTestInput(_ path: String, _ o: Overlay) {
  Thread.detachNewThread {
    while true {
      guard let f = fopen(path, "r") else { sleep(1); continue }  // blocks until a writer opens the fifo
      var buf: UnsafeMutablePointer<CChar>?, cap = 0
      while getline(&buf, &cap, f) > 0 {
        let line = String(cString: buf!).trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.main.async { MainActor.assumeIsolated { o.inject(line) } }
      }
      free(buf)
      fclose(f)
    }
  }
}

func overlay(_ args: [String]) -> Never {
  func opt(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
  guard let pid = opt("--herdr-pid").flatMap({ pid_t($0) }), let portFile = opt("--port-file") else {
    fail("usage: herdr-sim overlay --herdr-pid <pid> --port-file <path>")
  }
  guard kill(pid, 0) == 0 || errno == EPERM else { fail("overlay: no process \(pid)") }
  signal(SIGPIPE, SIG_IGN)  // a client gone mid-write must not kill the helper
  var bytes = [UInt8](repeating: 0, count: 16)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fail("overlay: no random token") }
  let token = bytes.map { String(format: "%02x", $0) }.joined()
  return MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)  // no Dock icon, and never the active app
    let o = Overlay(pid: pid, token: token)
    listenTCP(portFile: portFile, token: token, o)
    if let fifo = ProcessInfo.processInfo.environment["HERDR_SIM_TEST_INPUT"] { readTestInput(fifo, o) }
    app.run()
    exit(0)
  }
}
