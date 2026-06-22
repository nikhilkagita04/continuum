// Stage 1 — event-driven capture helper (replaces the 9s polling loop).
//
// Holds a run loop with NSWorkspace + per-pid AXObserver + a 1s pasteboard poll, and
// emits normalized CaptureEvents as NDJSON on stdout:
//   {t, source, app, window_id, url_host?, title?, text, secure?}
//
// Build:  swiftc daemon/stage1/capture.swift -o daemon/stage1/capture
// Run:    ./daemon/stage1/capture | node daemon/pipeline.mjs
// Needs Accessibility permission (System Settings → Privacy → Accessibility).
import Foundation
import AppKit
import ApplicationServices

func attr(_ el: AXUIElement, _ a: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success ? v : nil
}
func axStr(_ el: AXUIElement, _ a: String) -> String? { attr(el, a) as? String }
func axEl(_ el: AXUIElement, _ a: String) -> AXUIElement? {
  guard let v = attr(el, a), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
func axKids(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

func isSecure(_ el: AXUIElement) -> Bool {
  axStr(el, kAXRoleAttribute as String) == "AXSecureTextField" ||
  axStr(el, kAXSubroleAttribute as String) == "AXSecureTextField"
}

// UI-chrome roles whose own labels are noise (buttons, menus, toolbars, tabs). We still
// descend into them — a container may wrap real content — but don't collect their text.
let CHROME_ROLES: Set<String> = [
  "AXButton", "AXMenuButton", "AXPopUpButton", "AXMenuBar", "AXMenuBarItem", "AXMenu",
  "AXMenuItem", "AXToolbar", "AXTabGroup", "AXRadioButton", "AXCheckBox", "AXImage",
  "AXScrollBar", "AXSlider", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
  "AXBusyIndicator", "AXProgressIndicator", "AXValueIndicator",
]

// Collect *meaningful* text from a focused element / window subtree: skip chrome roles,
// dedup exact repeats, and keep only substantial strings (UI labels are 1–2 words; the
// content you actually read is prose). This is what separates signal from window furniture.
func extract(_ el: AXUIElement, depth: Int, budget: inout Int, seen: inout Set<String>, out: inout [String]) {
  if budget <= 0 || depth > 16 { return }
  let role = axStr(el, kAXRoleAttribute as String) ?? ""
  if !CHROME_ROLES.contains(role), let v = attr(el, kAXValueAttribute as String) as? String {
    let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
    let words = t.split(whereSeparator: { $0 == " " || $0 == "\n" }).count
    if (words >= 3 || t.count >= 24), t.count <= 5000, !seen.contains(t) {
      seen.insert(t); out.append(t); budget -= t.count
    }
  }
  for k in axKids(el) { if budget <= 0 { break }; extract(k, depth: depth + 1, budget: &budget, seen: &seen, out: &out) }
}

func extractText(_ el: AXUIElement, budget: Int) -> String {
  var b = budget, seen = Set<String>(), out = [String]()
  extract(el, depth: 0, budget: &b, seen: &seen, out: &out)
  return out.joined(separator: " ")
}

func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  print(s); fflush(stdout)
}
func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

final class Capture {
  var observer: AXObserver?
  var appEl: AXUIElement?
  var pid: pid_t = 0
  var appName = ""
  var lastEmit: [String: Int] = [:]      // per-window coalescing (≤1 emit / 400ms)
  var lastClip = ""
  var clipCount = NSPasteboard.general.changeCount

  func start() {
    let nc = NSWorkspace.shared.notificationCenter
    nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
      if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { self?.retarget(app) }
    }
    if let app = NSWorkspace.shared.frontmostApplication { retarget(app) }
    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.pollClipboard() }
  }

  // AXObserver is per-process: tear down and rebuild for the newly-focused app.
  func retarget(_ app: NSRunningApplication) {
    if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode) }
    observer = nil
    pid = app.processIdentifier
    appName = app.localizedName ?? "App"
    let el = AXUIElementCreateApplication(pid)
    appEl = el
    var obs: AXObserver?
    let cb: AXObserverCallback = { _, element, _, ctx in
      Unmanaged<Capture>.fromOpaque(ctx!).takeUnretainedValue().captureFocused()
    }
    if AXObserverCreate(pid, cb, &obs) == .success, let o = obs {
      observer = o
      let ctx = Unmanaged.passUnretained(self).toOpaque()
      for n in [kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification,
                kAXValueChangedNotification, kAXTitleChangedNotification, kAXMainWindowChangedNotification] as [String] {
        AXObserverAddNotification(o, el, n as CFString, ctx)
      }
      CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
    }
    captureFocused()
  }

  func captureFocused() {
    guard let app = appEl else { return }
    let focused = axEl(app, kAXFocusedUIElementAttribute as String)
    if let f = focused, isSecure(f) { return }                  // never read secure fields
    let win = axEl(app, kAXFocusedWindowAttribute as String)
    let title = win.flatMap { axStr($0, kAXTitleAttribute as String) } ?? ""
    let text = extractText(focused ?? win ?? app, budget: 6000).trimmingCharacters(in: .whitespacesAndNewlines)
    if text.count < 20 { return }                               // skip windows with no real content
    let windowId = "\(appName)|\(title)"
    let t = nowMs()
    if let last = lastEmit[windowId], t - last < 400 { return }  // coalesce keystroke bursts
    lastEmit[windowId] = t
    var obj: [String: Any] = ["t": t, "source": "ax", "app": appName, "window_id": windowId, "text": text]
    if !title.isEmpty { obj["title"] = title }
    emit(obj)
  }

  // Clipboard has no notification API — a cheap 1s changeCount poll is the documented path.
  func pollClipboard() {
    let pb = NSPasteboard.general
    guard pb.changeCount != clipCount else { return }
    clipCount = pb.changeCount
    if let s = pb.string(forType: .string), s != lastClip, s.count >= 3 {
      lastClip = s
      emit(["t": nowMs(), "source": "clipboard", "app": "Clipboard", "window_id": "Clipboard", "text": s])
    }
  }
}

let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(opts) {
  FileHandle.standardError.write("capture: grant Accessibility (System Settings → Privacy → Accessibility), then re-run.\n".data(using: .utf8)!)
}
let cap = Capture()
cap.start()
CFRunLoopRun()
