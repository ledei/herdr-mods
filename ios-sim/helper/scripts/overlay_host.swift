// Stand-in for Herdr in overlay_check.py: a plain window in a process of its own, never activated
// (accessory app, ordered to the back). One command per stdin line, one JSON line back:
//   frame x y w h             move/resize the window (CG global, top-left origin)
//   hide | show               order the window out / back in
//   where <pid>               the window's CG frame, <pid>'s on-screen windows, and the window directly above ours
//   diff <a.png> <b.png> turns x y w h   mean difference of a's crop (pixels) against b turned clockwise
//                                        `turns` quarter turns, and against b turned the other way
//   quit
// Build: swiftc -O overlay_host.swift -o overlay_host
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 700, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
w.title = "overlay_check host"
w.backgroundColor = .systemTeal
w.isReleasedWhenClosed = false
w.orderBack(nil)
let primary = NSScreen.screens[0].frame.height

func reply(_ o: Any) { print(String(decoding: try! JSONSerialization.data(withJSONObject: o), as: UTF8.self)) }
func bounds(_ d: [String: Any]) -> [Double] {
  let b = CGRect(dictionaryRepresentation: d[kCGWindowBounds as String] as! CFDictionary) ?? .null
  return [b.minX, b.minY, b.width, b.height]
}
func info(_ o: CGWindowListOption, _ rel: CGWindowID) -> [[String: Any]] { CGWindowListCopyWindowInfo(o, rel) as? [[String: Any]] ?? [] }

/// 32x32 grayscale samples of an image (or a crop of it).
func samples(_ path: String, crop: CGRect?, turns: Int) -> [Double]? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), var img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
  if let crop, let c = img.cropping(to: crop) { img = c }
  let n = 32
  var px = [UInt8](repeating: 0, count: n * n)
  let ctx = CGContext(data: &px, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
  ctx.translateBy(x: CGFloat(n) / 2, y: CGFloat(n) / 2)
  ctx.rotate(by: -CGFloat(turns) * .pi / 2)  // clockwise in a y-up context
  ctx.translateBy(x: -CGFloat(n) / 2, y: -CGFloat(n) / 2)
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))
  return px.map { Double($0) }
}

Thread.detachNewThread {
  reply(["ready": true, "pid": Int(getpid()), "window": w.windowNumber])
  while let line = readLine() {
    let p = line.split(separator: " ").map(String.init)
    DispatchQueue.main.sync {
      switch p.first {
      case "frame":
        let n = p.dropFirst().compactMap { Double($0) }
        w.setFrame(NSRect(x: n[0], y: primary - n[1] - n[3], width: n[2], height: n[3]), display: true)
        reply(["ok": true])
      case "hide": w.orderOut(nil); reply(["ok": true])
      case "show": w.orderBack(nil); reply(["ok": true])
      case "where":
        let pid = Int(p[1])!
        let me = CGWindowID(w.windowNumber)
        let all = info([.optionOnScreenOnly], kCGNullWindowID)
        let host = all.first { ($0[kCGWindowNumber as String] as? Int) == Int(me) }
        let theirs = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid }
        let above = info([.optionOnScreenAboveWindow], me).last?[kCGWindowNumber as String] as? Int
        reply(["host": host.map { bounds($0) as Any } ?? NSNull(), "windows": theirs.map { ["id": $0[kCGWindowNumber as String] as! Int, "bounds": bounds($0)] },
               "above": above.map { $0 as Any } ?? NSNull()])
      case "diff":
        let n = p.suffix(4).compactMap { Double($0) }
        let crop = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
        let turns = Int(p[3])!
        guard let a = samples(p[1], crop: crop, turns: 0), let b = samples(p[2], crop: nil, turns: turns),
              let b2 = samples(p[2], crop: nil, turns: turns + 2) else { reply(["error": "cannot read images"]); return }
        func d(_ x: [Double], _ y: [Double]) -> Double { zip(x, y).map { abs($0 - $1) }.reduce(0, +) / Double(x.count) }
        reply(["same": d(a, b), "turned": d(a, b2)])
      case "quit": exit(0)
      default: reply(["error": "unknown \(line)"])
      }
    }
  }
  exit(0)
}
app.run()
