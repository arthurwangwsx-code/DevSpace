import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var statusTimer: Timer?
    private var statusMenuItem: NSMenuItem!
    private var controlProcess: Process?
    private var readinessTimer: Timer?
    private let port = Int(ProcessInfo.processInfo.environment["DEVSPACE_CONTROL_PORT"] ?? "7680") ?? 7680
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        buildStatusItem()
        startControlCenter()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        readinessTimer?.invalidate()
        statusTimer?.invalidate()
        if let process = controlProcess, process.isRunning {
            process.terminate()
        }
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: "DevSpace status")
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.contentTintColor = .systemGray

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "DevSpace starting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Show Control Center", action: #selector(showControlCenter), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Start Service", action: #selector(startService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Service", action: #selector(restartService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop Service", action: #selector(stopService), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Refresh Status", action: #selector(refreshStatus), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit DevSpace", action: #selector(quitApp), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu

        statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func showControlCenter() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func startService() { callControlAction("service.start") }
    @objc private func restartService() { callControlAction("service.restart") }
    @objc private func stopService() { callControlAction("service.stop") }
    @objc private func quitApp() { NSApp.terminate(nil) }

    @objc private func refreshStatus() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/status") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self,
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let health = object["health"] as? [String: Any] else { return }
            let running = (health["ok"] as? Bool) == true
            DispatchQueue.main.async {
                self.statusMenuItem.title = running ? "DevSpace service running" : "DevSpace service stopped"
                self.statusItem.button?.contentTintColor = running ? .systemGreen : .systemGray
            }
        }.resume()
    }

    private func callControlAction(_ action: String) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/actions/\(action)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self?.refreshStatus()
            }
        }.resume()
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "DevSpace"
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        webView.loadHTMLString("<html><body style='font:15px -apple-system;padding:32px'>Starting DevSpace Control Center…</body></html>", baseURL: nil)
    }

    private func startControlCenter() {
        guard let resources = Bundle.main.resourceURL else {
            showFailure("Unable to locate DevSpace application resources.")
            return
        }
        let node = resources.appendingPathComponent("runtime/node")
        let cli = resources.appendingPathComponent("devspace/dist/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            showFailure("The bundled DevSpace runtime is incomplete. Reinstall the application.")
            return
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [cli.path, "control-center", "--host", "127.0.0.1", "--port", String(port), "--no-open"]
        var env = ProcessInfo.processInfo.environment
        env["DEVSPACE_CONTROL_TOKEN"] = token
        process.environment = env
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                if process.terminationStatus != 0 {
                    self?.showFailure("DevSpace Control Center stopped unexpectedly (exit \(process.terminationStatus)).")
                }
            }
        }
        do {
            try process.run()
            controlProcess = process
            beginReadinessProbe()
        } catch {
            showFailure("Unable to launch the bundled runtime: \(error.localizedDescription)")
        }
    }

    private func beginReadinessProbe() {
        let url = URL(string: "http://127.0.0.1:\(port)/?token=\(token)")!
        var attempts = 0
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] timer in
            attempts += 1
            var request = URLRequest(url: url)
            request.timeoutInterval = 0.4
            URLSession.shared.dataTask(with: request) { _, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) else {
                    if attempts > 75 {
                        DispatchQueue.main.async {
                            timer.invalidate()
                            self?.showFailure("DevSpace Control Center did not become ready.")
                        }
                    }
                    return
                }
                DispatchQueue.main.async {
                    timer.invalidate()
                    self?.webView.load(URLRequest(url: url))
                    self?.refreshStatus()
                }
            }.resume()
        }
    }

    private func showFailure(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView?.loadHTMLString("<html><body style='font:15px -apple-system;padding:32px'><h2>DevSpace could not start</h2><p>\(escaped)</p></body></html>", baseURL: nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
