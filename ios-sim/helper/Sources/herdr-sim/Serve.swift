// `herdr-sim serve`: the long-lived helper Herdr starts, one per app.
//
// Control channel on stdin/stdout. Frame = u32 LE length (of tag + body), 1 tag byte, body.
//   'J' request  (Herdr -> helper): {id, op, ...}
//   'J' reply    (helper -> Herdr): {id, ok: true, result} | {id, ok: false, error}
//   'E' event    (helper -> Herdr): {event: "streamEnded", udid, stream, reason}
//                                     {event: "rotation", udid, stream, rotation: upright|clockwise|upsideDown|counterclockwise}
// Ops (coordinates in device points): listDevices, attach {udid, stream}, detach {udid},
//   tap {udid, x, y}, touch {udid, phase: down|move|up, x, y}, swipe {udid, x1, y1, x2, y2, duration?},
//   key {udid, code, down}, text {udid, text}, button {udid, name: home|lock|siri|side|volumeUp|volumeDown, phase?: down|up},
//   rotate {udid, orientation: portrait|portraitUpsideDown|landscapeLeft|landscapeRight},
//   elementAt {udid, x, y, imagePath?} -> {type, label, identifier, frame: {x, y, width, height}, image?}.
// Rotation: the surface keeps its portrait pixel size with the content turned inside it; Herdr draws it
// turned back by `rotation`. Touch coordinates are in the rotated (on-screen) points.
//
// Screen: Mach messages to the bootstrap service named in $HERDR_IOSIM_SERVICE (Herdr checked it in),
// laid out as src/ios_sim.rs `decode` reads them (u32 words):
//   1 SURFACE: complex header, 1 port descriptor (the IOSurface's port), width, height, format, generation, stream
//   2 FRAME:   simple header, generation, seq, stream; sent with a zero timeout, so a full queue drops it (coalescing)
// Exits when stdin closes (Herdr quit) or the service is gone.
import FBSimulatorControl
import FBSimulatorServices
import Foundation
import IOSurface

@_silgen_name("bootstrap_look_up")
private func bootstrap_look_up(_ bp: mach_port_t, _ name: UnsafePointer<CChar>, _ sp: UnsafeMutablePointer<mach_port_t>) -> kern_return_t

let tagJSON = UInt8(ascii: "J"), tagEvent = UInt8(ascii: "E")
let maxFrame = 16 << 20

/// One frame: u32 LE length of tag + body, the tag, the body.
func encodeFrame(_ tag: UInt8, _ body: Data) -> Data {
  var n = UInt32(body.count + 1).littleEndian
  var d = Data(bytes: &n, count: 4)
  d.append(tag)
  d.append(body)
  return d
}

/// Reads one frame from `fd`; nil at end of input.
func readFrame(_ fd: Int32) throws -> (UInt8, Data)? {
  func exactly(_ n: Int) -> Data? {
    var d = Data(count: n), got = 0
    while got < n {
      let r = d.withUnsafeMutableBytes { read(fd, $0.baseAddress! + got, n - got) }
      if r < 0 && errno == EINTR { continue }
      if r <= 0 { return nil }
      got += r
    }
    return d
  }
  guard let len = exactly(4) else { return nil }
  let n = Int(len.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) })
  guard n >= 1 && n <= maxFrame else { throw Fail(msg: "bad frame length \(n)") }
  guard let f = exactly(n) else { return nil }
  return (f[f.startIndex], f.dropFirst())
}

/// Writes frames to Herdr from any thread.
final class Wire: @unchecked Sendable {
  let fd: Int32
  let lock = NSLock()
  init(fd: Int32) { self.fd = fd }
  func send(_ tag: UInt8, _ obj: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
    let d = encodeFrame(tag, body)
    lock.lock()
    defer { lock.unlock() }
    d.withUnsafeBytes { p in
      var off = 0
      while off < p.count {
        let w = write(fd, p.baseAddress! + off, p.count - off)
        if w < 0 && errno == EINTR { continue }
        if w <= 0 { exit(0) }  // Herdr closed our stdout: it is gone
        off += w
      }
    }
  }
}

/// The send right to Herdr's receive port.
final class Surfaces: @unchecked Sendable {
  let dest: mach_port_t
  init?() {
    guard let name = ProcessInfo.processInfo.environment["HERDR_IOSIM_SERVICE"] else { return nil }
    var p: mach_port_t = 0
    let kr = bootstrap_look_up(bootstrap_port, name, &p)
    guard kr == KERN_SUCCESS else {
      FileHandle.standardError.write(Data("herdr-sim serve: bootstrap_look_up(\(name)) failed: \(kr)\n".utf8))
      return nil
    }
    dest = p
  }

  private func send(_ words: [UInt32], timeout: mach_msg_timeout_t) -> kern_return_t {
    var w = words
    let kr = w.withUnsafeMutableBytes { p in
      mach_msg(p.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self), MACH_SEND_MSG | MACH_SEND_TIMEOUT, UInt32(p.count), 0, 0, timeout, 0)
    }
    if kr == MACH_SEND_INVALID_DEST { exit(0) }  // Herdr's port is gone
    return kr
  }

  func surface(_ s: IOSurface, generation: UInt32, stream: UInt32) -> kern_return_t {
    let port = IOSurfaceCreateMachPort(s)
    defer { mach_port_deallocate(mach_task_self_, port) }  // COPY_SEND below: ours stays ours
    let copySend: UInt32 = 19, complex: UInt32 = 0x8000_0000
    let kr = send([copySend | complex, 60, dest, 0, 0, 1,
                   1, port, 0, copySend << 16,  // body: 1 descriptor; name, pad, disposition << 16 | type (port) << 24
                   UInt32(IOSurfaceGetWidth(s)), UInt32(IOSurfaceGetHeight(s)), IOSurfaceGetPixelFormat(s), generation, stream],
                  timeout: 1000)
    // A timed-out send hands the copied right back to us (pseudo-receive): drop that extra reference too.
    if kr == MACH_SEND_TIMED_OUT { mach_port_deallocate(mach_task_self_, port) }
    return kr
  }

  /// False when Herdr's queue was full and the tick was dropped.
  func frame(generation: UInt32, seq: UInt32, stream: UInt32) -> Bool {
    send([19, 36, dest, 0, 0, 2, generation, seq, stream], timeout: 0) == KERN_SUCCESS
  }
}

func log(_ s: String) { FileHandle.standardError.write(Data("herdr-sim serve: \(s)\n".utf8)) }

/// Opt-in op timing (HERDR_SIM_TIMING=1), measurement only: one stderr line per op with Unix-epoch
/// times (received on the stdin thread, started, finished), the queue behind it, and a p50/p95
/// summary per op every 5 s.
final class Timing: @unchecked Sendable {
  static let on = ProcessInfo.processInfo.environment["HERDR_SIM_TIMING"] == "1"
  let lock = NSLock()
  var received = 0, finished = 0, maxQueue = 0
  var waits: [String: [Double]] = [:], runs: [String: [Double]] = [:]
  var since = Date()
  static func now() -> Double { Date().timeIntervalSince1970 }
  func got() { lock.lock(); received += 1; lock.unlock() }
  func done(_ r: [String: Any], started: Double, ended: Double) {
    let op = (r["op"] as? String ?? "?") + ((r["phase"] as? String).map { ":" + $0 } ?? "")
    let rx = r["_rx"] as? Double ?? started
    lock.lock()
    finished += 1
    let queue = received - finished  // still waiting after this one
    maxQueue = max(maxQueue, queue)
    let (wait, run) = ((started - rx) * 1000, (ended - started) * 1000)
    waits[op, default: []].append(wait)
    runs[op, default: []].append(run)
    var summary: String?
    if since.timeIntervalSinceNow < -5 {
      func pct(_ a: [Double], _ p: Double) -> Double { let s = a.sorted(); return s[min(s.count - 1, Int(Double(s.count) * p))] }
      summary = runs.keys.sorted().map { k in
        String(format: "%@ n=%d run p50 %.1f p95 %.1f max %.1f wait p50 %.1f p95 %.1f max %.1f", k, runs[k]!.count,
               pct(runs[k]!, 0.5), pct(runs[k]!, 0.95), runs[k]!.max()!, pct(waits[k]!, 0.5), pct(waits[k]!, 0.95), waits[k]!.max()!)
      }.joined(separator: "; ") + " | queue max \(maxQueue)"
      (waits, runs, maxQueue, since) = ([:], [:], 0, Date())
    }
    lock.unlock()
    log(String(format: "timing id=%@ op=%@ rx=%.6f start=%.6f end=%.6f wait_ms=%.2f run_ms=%.2f queue=%d",
               "\(r["id"] ?? "?")", op, rx, started, ended, wait, run, queue))
    if let summary { log("timing 5s: \(summary)") }
  }
}
let timing = Timing()

/// Per-device state, touched only by the serve loop. The Simulator is held for the whole
/// session (HID fails with "Simulator deallocated" otherwise).
final class Device {
  let sim: Simulator
  var hid: SimulatorHID?
  var attachment: FramebufferAttachment?
  init(_ sim: Simulator) { self.sim = sim }

  func send(_ e: SimulatorHIDEvent, drain: SimulatorHIDDrain = .perEvent) async throws {
    if hid == nil { hid = try await sim.hid.connect() }
    do { try await hid!.send(event: e, logger: logger, drain: drain) } catch {
      hid = nil  // reconnect on the next event
      throw error
    }
  }

  /// A finger step: "move" is a touch-down at the new point, as FBSimulatorControl's own swipe does.
  /// Not drained per event (that waits ~90 ms each): callers send one touch at a time, so a drag tracks the pointer.
  func touch(_ phase: String, _ x: Double, _ y: Double) async throws {
    try await send(.touch(direction: phase == "up" ? .up : .down, x: x, y: y), drain: .onClose)
  }

  /// With a phase the caller holds the button (side held = Siri); without one it is a short press.
  func button(_ name: String?, phase: String?) async throws {
    let b = try buttonNamed(name)
    switch phase {
    case nil: try await send(.shortButtonPress(b))
    case "down": try await send(.button(direction: .down, button: b))
    case "up": try await send(.button(direction: .up, button: b))
    case let other?: throw Fail(msg: "button: phase must be down or up, not '\(other)'")
    }
  }

  /// Turns the device; the rotation once settled (upright|clockwise|upsideDown|counterclockwise).
  func rotate(_ name: String) async throws -> String {
    guard ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"].contains(name),
          let o = SimulatorDeviceOrientation(rawValue: name) else { throw Fail(msg: "rotate: unknown orientation '\(name)'") }
    try await sim.orientation.set(o)
    // The config `set(_:confirmingWithin:)` returns can be the one from before the turn; ask again once settled.
    try await Task.sleep(for: .milliseconds(400))
    return "\(try await sim.displays.configuration().activeGeometry().rotation)"
  }
}

func serve() async throws -> Never {
  // Frames go to the original stdout; anything else a library prints lands on stderr.
  let wire = Wire(fd: dup(1))
  dup2(2, 1)
  let surfaces = Surfaces()
  if surfaces == nil { log("no HERDR_IOSIM_SERVICE: input works, attach does not") }

  let (requests, input) = AsyncStream<[String: Any]>.makeStream()
  Thread.detachNewThread {
    while true {
      do {
        guard let (tag, body) = try readFrame(0) else { break }
        if tag == tagJSON, var r = try JSONSerialization.jsonObject(with: body) as? [String: Any] {
          if Timing.on { r["_rx"] = Timing.now(); timing.got() }
          input.yield(r)
        }
        else { log("ignored a frame with tag \(tag)") }
      } catch {
        log("bad input: \(error); stopping")
        break
      }
    }
    input.finish()
  }

  var devices: [String: Device] = [:]
  func device(_ udid: String) throws -> Device {
    if let d = devices[udid] { return d }
    let d = Device(try connect(udid))
    devices[udid] = d
    return d
  }

  // shortcut: one request at a time, in order (keeps touch down/move/up ordered); a swipe blocks the loop for its duration.
  for await r in requests {
    let id = r["id"] ?? NSNull()
    let started = Timing.now()
    do {
      let result = try await handle(r, device, surfaces, wire)
      wire.send(tagJSON, ["id": id, "ok": true, "result": result])
    } catch {
      wire.send(tagJSON, ["id": id, "ok": false, "error": (error as? Fail)?.msg ?? "\(error)"])
    }
    if Timing.on { timing.done(r, started: started, ended: Timing.now()) }
    // HID connects in ~0.5 s: do it after the attach reply, so the first touch doesn't pay for it.
    if r["op"] as? String == "attach", let udid = r["udid"] as? String, let d = devices[udid], d.hid == nil {
      d.hid = try? await d.sim.hid.connect()
    }
  }
  for d in devices.values { d.attachment?.cancel() }
  log("stdin closed; exiting")
  exit(0)
}

private func handle(_ r: [String: Any], _ device: (String) throws -> Device, _ surfaces: Surfaces?, _ wire: Wire) async throws -> Any {
  func str(_ k: String) throws -> String {
    guard let v = r[k] as? String else { throw Fail(msg: "\(r["op"] ?? "?"): missing string '\(k)'") }
    return v
  }
  func num(_ k: String) throws -> Double {
    guard let v = (r[k] as? NSNumber)?.doubleValue else { throw Fail(msg: "\(r["op"] ?? "?"): missing number '\(k)'") }
    return v
  }
  let op = try str("op")
  if op == "listDevices" {
    return try devices().map { ["name": $0.name, "udid": $0.udid, "runtime": $0.runtime, "state": $0.state] }
  }
  let udid = try str("udid")
  let d = try device(udid)
  switch op {
  case "attach":
    guard let surfaces else { throw Fail(msg: "attach: no surface service (HERDR_IOSIM_SERVICE)") }
    let stream = UInt32(try num("stream"))
    d.attachment?.cancel()
    let att = try await d.sim.framebuffer.connect().attach()
    d.attachment = att
    forward(att, udid: udid, stream: stream, surfaces, wire)
    log("attached \(udid) as stream \(stream)")
    var result: [String: Any] = ["stream": stream]
    if let p = try? pointSize(d.sim) { result.merge(["pointWidth": p.w, "pointHeight": p.h, "scale": p.scale]) { $1 } }
    if let g = try? att.initialConfiguration?.activeGeometry() { result["rotation"] = "\(g.rotation)" }
    return result
  case "detach":
    d.attachment?.cancel()
    d.attachment = nil
    log("detached \(udid)")
  case "tap": try await d.send(.tapAt(x: try num("x"), y: try num("y"), duration: 0.05))
  case "touch": try await d.touch(try str("phase"), try num("x"), try num("y"))
  case "swipe":
    try await d.send(.swipe(try num("x1"), yStart: try num("y1"), xEnd: try num("x2"), yEnd: try num("y2"),
                            delta: SimulatorHIDEvent.defaultSwipeDelta, duration: (r["duration"] as? NSNumber)?.doubleValue ?? 0.3))
  case "key":
    try await d.send(.keyboard(direction: (r["down"] as? Bool ?? true) ? .down : .up, keyCode: UInt32(try num("code"))))
  case "text": try await d.send(try textEvents(try str("text")))
  case "button": try await d.button(r["name"] as? String, phase: r["phase"] as? String)
  case "elementAt":
    return try await element(at: try num("x"), try num("y"), in: d.sim, imagePath: r["imagePath"] as? String)
  case "rotate": return ["rotation": try await d.rotate(try str("orientation"))]
  default: throw Fail(msg: "unknown op '\(op)'")
  }
  return NSNull()
}

/// Forwards one attachment's surfaces and frame ticks to Herdr until it is cancelled or ends.
private func forward(_ att: FramebufferAttachment, udid: String, stream: UInt32, _ surfaces: Surfaces, _ wire: Wire) {
  Task.detached {
    var generation: UInt32 = 0, seq: UInt32 = 0, sent = 0, dropped = 0, since = Date()
    var rotation = (try? att.initialConfiguration?.activeGeometry())?.rotation ?? .upright
    // A surface Herdr has not received yet. Frame ticks for its generation are useless until it lands,
    // so it is resent on the next tick instead.
    var unsent: IOSurface?
    func send(_ s: IOSurface) {
      let kr = surfaces.surface(s, generation: generation, stream: stream)
      unsent = kr == KERN_SUCCESS ? nil : s
      log("stream \(stream): surface \(generation) \(IOSurfaceGetWidth(s))x\(IOSurfaceGetHeight(s)) kr=\(kr)")
    }
    func surface(_ s: IOSurface) {
      generation += 1
      send(s)
    }
    if let s = att.initialSurface { surface(s) }
    for await e in att.events {
      switch e {
      case .surfaceChanged(let s?): surface(s)
      case .surfaceChanged(nil): log("stream \(stream): surface gone")
      case .frameRendered:
        if let s = unsent { send(s); if unsent != nil { continue } }
        seq &+= 1
        if surfaces.frame(generation: generation, seq: seq, stream: stream) { sent += 1 } else { dropped += 1 }
        if since.timeIntervalSinceNow < -5 {
          log("stream \(stream): \(sent) frames sent, \(dropped) dropped in \(String(format: "%.1f", -since.timeIntervalSinceNow))s")
          (sent, dropped, since) = (0, 0, Date())
        }
      case .configurationChanged(let cfg):
        if cfg.phase == .settled, let g = try? cfg.activeGeometry(), g.rotation != rotation {
          rotation = g.rotation
          wire.send(tagEvent, ["event": "rotation", "udid": udid, "stream": stream, "rotation": "\(g.rotation)"])
        }
      case .ended(let why):
        wire.send(tagEvent, ["event": "streamEnded", "udid": udid, "stream": stream, "reason": "\(why)"])
        return
      @unknown default: break
      }
    }
  }
}
