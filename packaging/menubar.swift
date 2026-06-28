// Continuum menu-bar app (LSUIElement). A thin GUI shell around the capture→pipeline:
// it lives in the menu bar, starts/stops the local daemon, and stays out of the way.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  var task: Process?

  func applicationDidFinishLaunching(_ note: Notification) {
    item.button?.title = "◌"
    item.button?.toolTip = "Continuum"
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Start capture", action: #selector(start), keyEquivalent: "s"))
    menu.addItem(NSMenuItem(title: "Stop", action: #selector(stop), keyEquivalent: "x"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Open data folder", action: #selector(openData), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Quit Continuum", action: #selector(quit), keyEquivalent: "q"))
    item.menu = menu
  }

  // Run the bundled capture helper piped into the bundled Node pipeline.
  @objc func start() {
    guard task == nil else { return }
    let res = Bundle.main.resourcePath ?? "."
    let t = Process()
    t.executableURL = URL(fileURLWithPath: "/bin/zsh")
    t.arguments = ["-lc", "\"\(res)/screen\" | /usr/bin/env node \"\(res)/daemon/pipeline.mjs\""]
    do { try t.run(); task = t; item.button?.title = "●" } catch { item.button?.title = "⚠" }
  }

  @objc func stop() { task?.terminate(); task = nil; item.button?.title = "◌" }
  @objc func openData() { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.continuum")) }
  @objc func quit() { stop(); NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu-bar only, no Dock icon
app.run()
