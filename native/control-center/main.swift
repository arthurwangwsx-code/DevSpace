import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var controlProcess: Process?
    private var readinessTimer: Timer?
    private let port = Int(ProcessInfo.processInfo.environment["DEVSPACE_CONTROL_PORT"] ?? "7680") ?? 7680
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        startControlCenter()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        readinessTimer?.invalidate()
        if let process = controlProcess, process.isRunning {
            process.terminate()
        }
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
