// Skyline menu bar app: a status-bar icon that opens the full web city in a panel.
// The web app (../skyline) is copied into the bundle by build.sh and runs unchanged
// inside a WKWebView, so every click, panel and modal keeps working.
import AppKit
import WebKit

/// Owns the one WKWebView. It moves between the popover and the window, so the city
/// keeps its state (selection, drafts, demo clock) when you switch.
final class SkylineWeb: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    /// The live server (server/, `npm start`). When it's running the app uses it, so LIVE mode works;
    /// otherwise it falls back to the copy of the web app inside the bundle (DEMO only).
    static let liveURL = URL(string: "http://localhost:8787/")!

    let webView: WKWebView
    var onFires: ((Int) -> Void)?

    override init() {
        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 780), configuration: config)
        super.init()
        config.userContentController.add(self, name: "skyline")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        load()
    }

    func load() {
        var probe = URLRequest(url: SkylineWeb.liveURL.appendingPathComponent("api/snapshot"))
        probe.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: probe) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self?.webView.load(URLRequest(url: SkylineWeb.liveURL))
                } else {
                    self?.loadBundled()
                }
            }
        }.resume()
    }

    func loadBundled() {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("web"),
              FileManager.default.fileExists(atPath: dir.appendingPathComponent("index.html").path) else {
            webView.loadHTMLString("<body style='font:15px system-ui;padding:24px'><h2>Skyline web files are missing</h2><p>Run <code>macos/build.sh</code> again.</p></body>", baseURL: nil)
            return
        }
        webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
    }

    // app.js posts { fires } after each render; the count shows next to the menu bar icon.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], let fires = body["fires"] as? Int { onFires?(fires) }
    }

    // Links that leave the app (mailto:, Outlook, Slack) open in the default handler, not in the panel.
    // Sign-in redirects (Microsoft login) stay inside so the server can finish connecting.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url, url.scheme != "file", url.scheme != "about", url.host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // window.open (the web app's "Open in Outlook") goes to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let web = SkylineWeb()
    var statusItem: NSStatusItem!
    let popover = NSPopover()
    let panel = NSViewController()
    var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = editMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "building.2.fill", accessibilityDescription: "Skyline")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.toolTip = "Skyline"
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        panel.view = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 780))
        attachWeb(to: panel.view)
        popover.contentViewController = panel
        popover.contentSize = NSSize(width: 1200, height: 780)
        popover.behavior = .transient

        web.onFires = { [weak self] n in self?.showFires(n) }
    }

    func attachWeb(to host: NSView) {
        web.webView.removeFromSuperview()
        web.webView.frame = host.bounds
        web.webView.autoresizingMask = [.width, .height]
        host.addSubview(web.webView)
    }

    func showFires(_ n: Int) {
        statusItem.button?.title = n > 0 ? " \(n)" : ""
        statusItem.button?.toolTip = n > 0 ? "Skyline · \(n) fire\(n == 1 ? "" : "s") in your region" : "Skyline · no fires"
    }

    /// Left click: open or close the panel. Right click (or control-click): the menu.
    @objc func statusClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showMenu()
            return
        }
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func showMenu() {
        let menu = NSMenu()
        let toggle = NSMenuItem(title: window == nil ? "Open in Window" : "Back to Menu Bar Panel", action: #selector(toggleWindow), keyEquivalent: "n")
        let reload = NSMenuItem(title: "Reload Skyline", action: #selector(reloadWeb), keyEquivalent: "r")
        [toggle, reload].forEach { $0.target = self; menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Skyline", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    /// A full-size, resizable window for when the panel feels cramped. While it is open
    /// Skyline shows in the Dock and Cmd-Tab; closing it puts the city back in the panel.
    @objc func toggleWindow() {
        if let w = window { w.close(); return }
        popover.performClose(nil)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Skyline"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.minSize = NSSize(width: 720, height: 520)
        w.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
        attachWeb(to: w.contentView!)
        w.center()
        window = w
        NSApp.setActivationPolicy(.regular)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        attachWeb(to: panel.view)
        window = nil
        NSApp.setActivationPolicy(.accessory)
    }

    @objc func reloadWeb() { web.load() }

    /// No visible menu bar, but this gives text fields Cmd-C / Cmd-V / Cmd-Z / Cmd-A.
    func editMenu() -> NSMenu {
        let main = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only: no Dock icon until a window opens
app.run()
