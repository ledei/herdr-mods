// herdr-sim: one-shot CLI for agents to see and drive an iOS Simulator.
// Lifecycle (list/boot/shutdown/launch/open-url) shells out to simctl; screenshot/input/describe use FBSimulatorControl.
// shortcut: hand-rolled argument parsing (flags may appear anywhere), no swift-argument-parser.
import AppKit
import FBControlCore
import FBSimulatorAX
import FBSimulatorControl
import FBSimulatorServices
import Foundation
import IOSurface

let usage = """
herdr-sim: see and drive an iOS Simulator from a terminal.
Coordinates are DEVICE POINTS, origin top-left (screenshot prints the point size). Screenshot after acting to see the result.
Device = UDID or name. --device is required for commands that act on a device; screenshot and describe default to the only booted one. Add --json for structured output. Errors: one line on stderr, exit 1.

  list [--json]                         devices: name, udid, runtime, state
  boot <device> | shutdown <device>
  screenshot [--device D] <out.png>     prints path and point size
  tap [--device D] <x> <y>
  swipe [--device D] <x1> <y1> <x2> <y2> [--duration s]
  button [--device D] home|lock|siri|side|volumeUp|volumeDown
  rotate [--device D] portrait|portraitUpsideDown|landscapeLeft|landscapeRight
  type [--device D] <text>              ASCII letters, digits, punctuation, space, newline
  describe [--device D] [--point x y]   accessibility tree of the front app (JSON, frames in points)
  launch [--device D] <bundle-id | App.app>     installs first if a .app path
  open-url [--device D] <url>
  serve                                 Herdr's long-lived helper (stdin/stdout protocol, see Serve.swift)
  overlay --herdr-pid P --port-file F   the simulator in a panel over stock Herdr's window (TCP protocol, see Overlay.swift)
"""

struct Fail: Error { let msg: String }
func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(Data((msg + "\n").utf8))
  exit(1)
}

// MARK: args

func num(_ s: String) -> Double {
  guard let v = Double(s) else { fail("not a number: \(s)") }
  return v
}
var positional: [String] = []
var device: String?
var json = false
var duration: Double?
var point: (Double, Double)?
do {
  var a = Array(CommandLine.arguments.dropFirst())
  func take(_ n: Int, _ flag: String) -> [String] {
    guard a.count >= n else { fail("\(flag) needs \(n) value(s)") }
    defer { a.removeFirst(n) }
    return Array(a.prefix(n))
  }
  while !a.isEmpty {
    let f = a.removeFirst()
    switch f {
    case "--device": device = take(1, f)[0]
    case "--json": json = true
    case "--duration": duration = num(take(1, f)[0])
    case "--point": let v = take(2, f); point = (num(v[0]), num(v[1]))
    case "-h", "--help", "help": print(usage); exit(0)
    default: positional.append(f)
    }
  }
}
guard let cmd = positional.first else { print(usage); exit(1) }
let args = Array(positional.dropFirst())
func nums(_ n: Int) -> [Double] {
  guard args.count == n else { fail("usage error: \(cmd) needs \(n) numeric arguments (see --help)") }
  return args.map(num)
}

// MARK: simctl + devices

@discardableResult
func simctl(_ a: [String]) throws -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  p.arguments = ["simctl"] + a
  let out = Pipe(), err = Pipe()
  p.standardOutput = out
  p.standardError = err
  try p.run()
  // shortcut: read stdout before stderr; fine for the small outputs of these commands.
  let o = out.fileHandleForReading.readDataToEndOfFile()
  let e = err.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  guard p.terminationStatus == 0 else {
    let m = String(decoding: e, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    throw Fail(msg: "simctl \(a.first ?? "") failed: \(m.split(separator: "\n").first.map(String.init) ?? "exit \(p.terminationStatus)")")
  }
  return String(decoding: o, as: UTF8.self)
}

struct Dev { let name, udid, runtime, state: String }
func devices() throws -> [Dev] {
  let raw = try simctl(["list", "devices", "available", "-j"])
  guard let d = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
    let groups = d["devices"] as? [String: [[String: Any]]]
  else { throw Fail(msg: "cannot parse simctl output") }
  return groups.flatMap { rt, list in
    list.map {
      Dev(name: $0["name"] as? String ?? "", udid: $0["udid"] as? String ?? "",
        runtime: rt.replacingOccurrences(of: "com.apple.CoreSimulator.SimRuntime.", with: ""), state: $0["state"] as? String ?? "")
    }
  }.sorted { ($0.runtime, $0.name) < ($1.runtime, $1.name) }
}
func line(_ d: Dev) -> String { "\(d.name)  \(d.udid)  \(d.runtime)  \(d.state)" }

func resolve(_ spec: String?, needBooted: Bool) throws -> Dev {
  let all = try devices()
  if let s = spec {
    let m = all.filter { $0.udid.caseInsensitiveCompare(s) == .orderedSame } + all.filter { $0.name == s }
    if m.isEmpty { throw Fail(msg: "no device matches '\(s)'; run: herdr-sim list") }
    if m.count > 1 { throw Fail(msg: "'\(s)' is ambiguous, use a UDID:\n" + m.map(line).joined(separator: "\n")) }
    if needBooted && m[0].state != "Booted" { throw Fail(msg: "\(m[0].name) is \(m[0].state); run: herdr-sim boot \(m[0].udid)") }
    return m[0]
  }
  let booted = all.filter { $0.state == "Booted" }
  if booted.count == 1 { return booted[0] }
  throw Fail(msg: booted.isEmpty ? "no booted device; run: herdr-sim boot <device>" : "several devices are booted, pass --device:\n" + booted.map(line).joined(separator: "\n"))
}

func out(_ text: String, _ obj: Any) {
  if json, let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) { print(String(decoding: d, as: UTF8.self)) } else { print(text) }
}

// MARK: FBSimulatorControl

let debug = ProcessInfo.processInfo.environment["HERDR_SIM_DEBUG"] != nil  // logs HID transport choice to stderr
let logger = ControlCoreGlobalConfiguration.systemLogger(writingToStderr: debug, debugLogging: debug)

// The Simulator holds its set weakly, so the bootstrap must outlive every use ("Simulator deallocated" otherwise).
nonisolated(unsafe) var control: SimulatorControlBootstrap?
func connect(_ udid: String) throws -> Simulator {
  if control == nil { control = try SimulatorControlBootstrap(configuration: SimulatorControlConfiguration(deviceSetPath: nil, logger: logger)) }
  guard let sim = control!.set.simulator(withUDID: udid) else { throw Fail(msg: "FBSimulatorControl cannot see \(udid)") }
  return sim
}

func pointSize(_ sim: Simulator) throws -> (w: Double, h: Double, scale: Double) {
  guard let i = sim.screenInfo, i.scale > 0 else { throw Fail(msg: "screen info unavailable (is the device fully booted?)") }
  return (Double(i.widthPixels) / Double(i.scale), Double(i.heightPixels) / Double(i.scale), Double(i.scale))
}

func send(_ udid: String, _ e: SimulatorHIDEvent) async throws {
  let sim = try connect(udid)  // keep the Simulator referenced for the whole send
  let hid = try await sim.hid.connect()
  try await hid.send(event: e, logger: logger)
}

/// The current screen as a CPU image, turned upright when the device is rotated.
func screenImage(_ sim: Simulator) async throws -> CGImage {
  let att = try await sim.framebuffer.connect().attach()
  defer { att.cancel() }
  var surface = att.initialSurface
  if surface == nil {  // surface can lag right after boot; wait up to 5s for the first one
    let t = Task<IOSurface?, Never> { for await e in att.events { if case .surfaceChanged(let s?) = e { return s } }; return nil }
    let timeout = Task { try await Task.sleep(for: .seconds(5)); t.cancel() }
    surface = await t.value
    timeout.cancel()
  }
  guard let s = surface else { throw Fail(msg: "no framebuffer surface (is the screen on?)") }
  IOSurfaceLock(s, .readOnly, nil)
  defer { IOSurfaceUnlock(s, .readOnly, nil) }
  // shortcut: CPU readback through CIImage; fine for screenshots, not for streaming (that is T2's IOSurface sharing).
  var ci = CIImage(ioSurface: s)
  if let r = try? att.initialConfiguration?.activeGeometry().rotation, r != .upright {
    ci = ci.oriented(forExifOrientation: r.exifOrientation)
  }
  guard let cg = CIContext().createCGImage(ci, from: ci.extent) else { throw Fail(msg: "could not read the screen") }
  return cg
}

func writePNG(_ cg: CGImage, _ path: String) throws {
  guard let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { throw Fail(msg: "could not encode PNG") }
  try png.write(to: URL(fileURLWithPath: path))
}

func screenshot(_ sim: Simulator, _ path: String) async throws -> String {
  let cg = try await screenImage(sim)
  try writePNG(cg, path)
  let p = try pointSize(sim)
  return "\(path) \(Int(p.w))x\(Int(p.h)) points (\(cg.width)x\(cg.height) pixels, scale \(Int(p.scale)))"
}

/// The smallest accessibility element under a point (in on-screen points), skipping the app itself.
/// Where the front app's tree has nothing there but the app (Safari's web content is not in it),
/// the deepest element a hit test finds. With `imagePath`, also writes that element's pixels there as a PNG.
func element(at x: Double, _ y: Double, in sim: Simulator, imagePath: String?) async throws -> [String: Any] {
  let ui = try sim.uiAutomation(backend: .accessibility)
  let opts = AccessibilityRequestOptions()
  func object(_ doc: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: try JSONEncoder().encode(doc)) as? [String: Any] ?? [:]
  }
  /// The element under (x, y) that ranks first: (depth, -area) for a hit test's chain, -area otherwise.
  func pick(_ json: [String: Any], deepest: Bool) -> [String: Any]? {
    var best: [String: Any]?, bestRank = (-Double.infinity, -Double.infinity)
    func visit(_ e: [String: Any], _ depth: Double) {
      if let f = e["frame"] as? [String: Double], let fx = f["x"], let fy = f["y"], let fw = f["width"], let fh = f["height"],
         e["type"] as? String != "Application", fw > 0, fh > 0, x >= fx, x < fx + fw, y >= fy, y < fy + fh {
        let rank = deepest ? (depth, -fw * fh) : (0, -fw * fh)
        if rank > bestRank { (best, bestRank) = (e, rank) }
      }
      for c in e["children"] as? [[String: Any]] ?? [] { visit(c, depth + 1) }
    }
    for e in json["elements"] as? [[String: Any]] ?? [] { visit(e, 0) }
    return best
  }
  var json = try object(try await ui.describe(.frontmost, options: opts).document)
  var best = pick(json, deepest: false)
  if best == nil, let hit = try await ui.hitTest(at: CGPoint(x: x, y: y), options: opts) {
    json = try object(hit.document)
    best = pick(json, deepest: true)
  }
  guard let e = best, let f = e["frame"] as? [String: Double] else { throw Fail(msg: "no element at (\(x), \(y))") }
  var out: [String: Any] = ["type": e["type"] ?? NSNull(), "label": e["label"] ?? NSNull(), "identifier": e["identifier"] ?? NSNull(), "frame": f]
  if let imagePath {
    let cg = try await screenImage(sim)
    let screenWidth = ((json["screen"] as? [String: Any])?["width"] as? NSNumber)?.doubleValue ?? Double(cg.width)
    let k = Double(cg.width) / screenWidth
    let rect = CGRect(x: f["x"]! * k, y: f["y"]! * k, width: f["width"]! * k, height: f["height"]! * k).integral
    guard let crop = cg.cropping(to: rect) else { throw Fail(msg: "element is off screen") }
    try writePNG(crop, imagePath)
    out["image"] = imagePath
  }
  return out
}

// HID usage page 0x07. shortcut: US layout only.
let shiftKey: UInt32 = 225
func keys(for c: Character) -> (code: UInt32, shift: Bool)? {
  guard let a = c.asciiValue else { return nil }
  switch a {
  case UInt8(ascii: "a")...UInt8(ascii: "z"): return (UInt32(a - 97) + 4, false)
  case UInt8(ascii: "A")...UInt8(ascii: "Z"): return (UInt32(a - 65) + 4, true)
  case UInt8(ascii: "1")...UInt8(ascii: "9"): return (UInt32(a - 49) + 30, false)
  case UInt8(ascii: "0"): return (39, false)
  case 10, 13: return (40, false)
  case 9: return (43, false)
  case 32: return (44, false)
  default: break
  }
  let plain = "-=[]\\;'`,./", shifted = "_+{}|:\"~<>?", sym = ")!@#$%^&*("
  if let i = plain.firstIndex(of: c) { let n = plain.distance(from: plain.startIndex, to: i); return (UInt32([45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56][n]), false) }
  if let i = shifted.firstIndex(of: c) { let n = shifted.distance(from: shifted.startIndex, to: i); return (UInt32([45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56][n]), true) }
  if let i = sym.firstIndex(of: c) { let n = sym.distance(from: sym.startIndex, to: i); return (n == 0 ? 39 : UInt32(29 + n), true) }
  return nil
}

func textEvents(_ text: String) throws -> SimulatorHIDEvent {
  var events: [SimulatorHIDEvent] = []
  var bad: [Character] = []
  for c in text {
    guard let k = keys(for: c) else { bad.append(c); continue }
    if k.shift { events.append(.keyboard(direction: .down, keyCode: shiftKey)) }
    events += [.keyboard(direction: .down, keyCode: k.code), .keyboard(direction: .up, keyCode: k.code)]
    if k.shift { events.append(.keyboard(direction: .up, keyCode: shiftKey)) }
  }
  if !bad.isEmpty { throw Fail(msg: "unsupported characters (nothing typed): " + bad.map { "'\($0)'" }.joined(separator: " ")) }
  return .composite(events)
}

func buttonNamed(_ name: String?) throws -> SimulatorHIDButton {
  switch name {
  case "home": return .homeButton
  case "lock": return .lock
  case "siri": return .siri
  case "side": return .sideButton
  case "volumeUp": return .volumeUp
  case "volumeDown": return .volumeDown
  default: throw Fail(msg: "button must be home, lock, siri, side, volumeUp or volumeDown")
  }
}

func describe(_ sim: Simulator) async throws {
  // shortcut: host-side .accessibility backend; the in-guest axBridge backend needs the bundled Resources and was not needed.
  let ui = try sim.uiAutomation(backend: .accessibility)
  let opts = AccessibilityRequestOptions()
  let resp: AccessibilityElementsResponse
  if let p = point {
    guard let r = try await ui.hitTest(at: CGPoint(x: p.0, y: p.1), options: opts) else { throw Fail(msg: "no element at (\(p.0), \(p.1))") }
    resp = r
  } else {
    resp = try await ui.describe(.frontmost, options: opts)
  }
  let enc = JSONEncoder()
  enc.outputFormatting = [.sortedKeys]
  print(String(decoding: try enc.encode(resp.document), as: UTF8.self))
}

// MARK: dispatch

do {
  switch cmd {
  case "list":
    let all = try devices()
    out(all.map(line).joined(separator: "\n"), all.map { ["name": $0.name, "udid": $0.udid, "runtime": $0.runtime, "state": $0.state] })
  case "boot", "shutdown":
    guard args.count == 1 else { fail("usage: \(cmd) <device>") }
    let d = try resolve(args[0], needBooted: false)
    if cmd == "boot" {
      if d.state != "Booted" { try simctl(["boot", d.udid]) }
      try simctl(["bootstatus", d.udid])
      print("booted \(d.name) \(d.udid)")
    } else {
      if d.state != "Shutdown" { try simctl(["shutdown", d.udid]) }
      print("shutdown \(d.name) \(d.udid)")
    }
  case "serve": try await serve()
  case "overlay": overlay(args)
  default:
    // Acting on a device nobody named could drive someone else's simulator; only reads may default.
    if device == nil && !["screenshot", "describe"].contains(cmd) {
      fail("\(cmd) acts on a device: pass --device <udid or name> (see herdr-sim list)")
    }
    let d = try resolve(device, needBooted: true)
    switch cmd {
    case "screenshot":
      guard args.count == 1 else { fail("usage: screenshot [--device D] <out.png>") }
      let sim = try connect(d.udid)
      let s = try await screenshot(sim, args[0])
      let p = try pointSize(sim)
      out(s, ["path": args[0], "pointWidth": p.w, "pointHeight": p.h, "scale": p.scale])
    case "tap":
      let n = nums(2)
      try await send(d.udid, .tapAt(x: n[0], y: n[1], duration: 0.05))
      print("tap \(n[0]) \(n[1])")
    case "swipe":
      let n = nums(4)
      try await send(d.udid, .swipe(n[0], yStart: n[1], xEnd: n[2], yEnd: n[3], delta: SimulatorHIDEvent.defaultSwipeDelta, duration: duration ?? 0.3))
      print("swipe \(n[0]),\(n[1]) -> \(n[2]),\(n[3])")
    case "button":
      guard let b = try? buttonNamed(args.first) else { fail("usage: button home|lock|siri|side|volumeUp|volumeDown") }
      try await send(d.udid, .shortButtonPress(b))
      print("button \(args[0])")
    case "rotate":
      let names = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"]
      guard args.count == 1, let o = SimulatorDeviceOrientation(rawValue: args[0]), names.contains(args[0]) else { fail("usage: rotate [--device D] portrait|portraitUpsideDown|landscapeLeft|landscapeRight") }
      let sim = try connect(d.udid)
      let cfg = try await sim.orientation.set(o, confirmingWithin: .seconds(5))
      print("rotate \(args[0]) \(cfg)")
    case "type":
      guard args.count == 1 else { fail("usage: type [--device D] <text> (quote the text)") }
      try await send(d.udid, try textEvents(args[0]))
      print("typed \(args[0].count) characters")
    case "describe": try await describe(try connect(d.udid))
    case "launch":
      guard args.count == 1 else { fail("usage: launch [--device D] <bundle-id | path/to/App.app>") }
      var id = args[0]
      if id.hasSuffix(".app") || id.contains("/") {
        let url = URL(fileURLWithPath: id)
        try simctl(["install", d.udid, id])
        guard let b = Bundle(url: url)?.bundleIdentifier else { throw Fail(msg: "cannot read bundle id from \(id)") }
        id = b
      }
      print(try simctl(["launch", d.udid, id]).trimmingCharacters(in: .whitespacesAndNewlines))
    case "open-url":
      guard args.count == 1 else { fail("usage: open-url [--device D] <url>") }
      try simctl(["openurl", d.udid, args[0]])
      print("opened \(args[0])")
    default: fail("unknown command '\(cmd)'; see --help")
    }
  }
} catch let e as Fail { fail(e.msg) } catch { fail("error: \(error.localizedDescription)") }
