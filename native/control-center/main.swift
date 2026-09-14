import AppKit
import SwiftUI

// MARK: - Native control model

@MainActor
final class DevSpaceControlModel: ObservableObject {
    @Published var backendReady = false
    @Published var configExists = false
    @Published var busy = false
    @Published var serviceRunning = false
    @Published var startAtLogin = false
    @Published var statusMessage = "Starting DevSpace…"
    @Published var diagnosticOutput = ""
    @Published var tunnelOutput = ""
    @Published var browserOutput = ""
    @Published var permissionOutput = ""
    @Published var updateOutput = ""
    @Published var tunnelConfigured = false
    @Published var tunnelEnabled = false
    @Published var tunnelPublicURL = ""
    @Published var browserReady = false
    @Published var browserExtensionPath = ""
    @Published var computerUseReady = false
    @Published var accessibilityGranted = false
    @Published var screenRecordingGranted = false
    @Published var fullDiskAccessVerified: Bool? = nil
    @Published var setupReady = false
    @Published var setupBlockers: [String] = []
    @Published var nodeVersion = "—"
    @Published var architecture = "—"

    @Published var allowedRoots: [String] = []
    @Published var mcpPort = 7676
    @Published var publicBaseURL = ""

    @Published var tunnelPreset = "tunnel-client"
    @Published var tunnelID = ""
    @Published var tunnelRuntimeAPIKey = ""
    @Published var tunnelAPIKeyFile = ""
    @Published var tunnelCommand = ""
    @Published var tunnelArguments = ""
    @Published var tunnelWorkingDirectory = ""
    @Published var tunnelAutoStart = true
    @Published var tunnelRestart = true

    let port: Int
    let token: String

    init(port: Int, token: String) {
        self.port = port
        self.token = token
    }

    var localMCPURL: String { "http://127.0.0.1:\(mcpPort)/mcp" }
    var publicMCPURL: String {
        let base = tunnelPublicURL.isEmpty ? publicBaseURL : tunnelPublicURL
        guard !base.isEmpty else { return "Not configured" }
        return base.hasSuffix("/mcp") ? base : base + "/mcp"
    }

    var setupProgress: Int {
        var value = 0
        if !allowedRoots.isEmpty { value += 1 }
        if tunnelConfigured || !tunnelEnabled { value += 1 }
        if browserReady { value += 1 }
        if computerUseReady { value += 1 }
        if startAtLogin && serviceRunning { value += 1 }
        return value
    }

    func refresh() {
        guard backendReady else { return }
        Task {
            do {
                async let statusTask = api(path: "/status")
                async let configTask = api(path: "/config")
                let (status, configEnvelope) = try await (statusTask, configTask)
                applyStatus(status)
                if let config = configEnvelope["config"] as? [String: Any] { applyConfig(config) }
                statusMessage = setupReady ? "DevSpace is ready" : serviceRunning ? "Setup needs attention" : "Core service is stopped"
            } catch {
                statusMessage = error.localizedDescription
            }
        }
    }

    func refreshReadiness() {
        guard backendReady else { return }
        Task {
            do {
                let readiness = try await action("setup.status")
                consumeActionResult("setup.status", envelope: readiness)
                statusMessage = setupReady ? "DevSpace is ready" : serviceRunning ? "Setup needs attention" : "Core service is stopped"
            } catch {
                diagnosticOutput = error.localizedDescription
            }
        }
    }

    func saveConfiguration(restart: Bool = false) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let tunnel: [String: Any] = [
                    "enabled": tunnelEnabled,
                    "autoStart": tunnelAutoStart,
                    "preset": tunnelPreset,
                    "tunnelId": tunnelID.isEmpty ? NSNull() : tunnelID,
                    "apiKeyFile": tunnelAPIKeyFile.isEmpty ? NSNull() : tunnelAPIKeyFile,
                    "command": tunnelCommand.isEmpty ? NSNull() : tunnelCommand,
                    "args": tunnelArguments.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
                    "cwd": tunnelWorkingDirectory.isEmpty ? NSNull() : tunnelWorkingDirectory,
                    "publicBaseUrl": publicBaseURL.isEmpty ? NSNull() : publicBaseURL,
                    "restartOnExit": tunnelRestart,
                ]
                let body: [String: Any] = [
                    "allowedRoots": allowedRoots,
                    "port": mcpPort,
                    "publicBaseUrl": publicBaseURL.isEmpty ? NSNull() : publicBaseURL,
                    "tunnel": tunnel,
                ]
                _ = try await api(path: "/config", method: "PUT", body: body)
                if restart { _ = try await action("service.restart") }
                diagnosticOutput = restart ? "Configuration saved and service restart requested." : "Configuration saved."
                refresh()
            } catch {
                diagnosticOutput = error.localizedDescription
            }
        }
    }

    func run(_ actionName: String, destination: OutputDestination = .diagnostics) {
        Task {
            busy = true
            defer { busy = false }
            setOutput("Running…", destination)
            do {
                let result = try await action(actionName)
                consumeActionResult(actionName, envelope: result)
                setOutput(pretty(result), destination)
                refresh()
                if actionName != "setup.status" { refreshReadiness() }
            } catch {
                setOutput(error.localizedDescription, destination)
            }
        }
    }

    func saveTunnelRuntimeAPIKey() {
        Task {
            busy = true
            defer { busy = false }
            tunnelOutput = "Saving protected Runtime API key…"
            do {
                let response = try await action("tunnel.saveApiKey", body: ["apiKey": tunnelRuntimeAPIKey])
                if let result = response["result"] as? [String: Any], let path = result["path"] as? String {
                    tunnelAPIKeyFile = path
                    tunnelRuntimeAPIKey = ""
                    tunnelOutput = "Runtime API key saved to DevSpace's protected secrets directory."
                } else {
                    tunnelOutput = pretty(response)
                }
            } catch {
                tunnelOutput = error.localizedDescription
            }
        }
    }

    func addWorkspaceFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Allow Folder"
        panel.message = "Choose folders DevSpace is allowed to expose to AI clients."
        if panel.runModal() == .OK {
            for url in panel.urls where !allowedRoots.contains(url.path) { allowedRoots.append(url.path) }
        }
    }

    func chooseTunnelAPIKeyFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Credential File"
        panel.message = "DevSpace stores only this protected file path, not the credential contents."
        if panel.runModal() == .OK { tunnelAPIKeyFile = panel.url?.path ?? "" }
    }

    func chooseTunnelExecutable() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Executable"
        if panel.runModal() == .OK { tunnelCommand = panel.url?.path ?? "" }
    }

    func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    func openWebControlCenter() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/?token=\(token)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func action(_ name: String, body: [String: Any] = [:]) async throws -> [String: Any] {
        try await api(path: "/actions/\(name)", method: "POST", body: body)
    }

    private func api(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api\(path)") else { throw ControlError("Invalid local Control Center URL") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ControlError("Invalid Control Center response") }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if !(200..<300).contains(http.statusCode) || object["ok"] as? Bool == false {
            throw ControlError(object["error"] as? String ?? "Control Center returned HTTP \(http.statusCode)")
        }
        return object
    }

    private func applyStatus(_ value: [String: Any]) {
        configExists = value["configExists"] as? Bool == true
        if let health = value["health"] as? [String: Any] { serviceRunning = health["ok"] as? Bool == true }
        if let service = value["service"] as? [String: Any] { startAtLogin = service["startAtLogin"] as? Bool == true }
        if let tunnel = value["tunnel"] as? [String: Any] {
            tunnelConfigured = tunnel["configured"] as? Bool == true
            tunnelEnabled = tunnel["enabled"] as? Bool == true
            tunnelPublicURL = tunnel["publicBaseUrl"] as? String ?? ""
        }
        nodeVersion = value["node"] as? String ?? nodeVersion
        architecture = value["arch"] as? String ?? architecture
    }

    private func consumeActionResult(_ action: String, envelope: [String: Any]) {
        guard let result = envelope["result"] else { return }
        if action == "setup.status", let payload = result as? [String: Any] {
            setupReady = payload["ready"] as? Bool == true
            setupBlockers = payload["blockers"] as? [String] ?? []
            if let browser = payload["browser"] as? [String: Any] {
                browserReady = browser["healthy"] as? Bool == true
            }
            if let desktop = payload["desktop"] as? [String: Any] {
                computerUseReady = desktop["permissionsReady"] as? Bool == true
                if let permissions = desktop["permissions"] as? [String: Any] {
                    accessibilityGranted = permissions["accessibilityTrusted"] as? Bool == true
                    screenRecordingGranted = permissions["screenCaptureGranted"] as? Bool == true
                }
            }
            if let disk = payload["fullDiskAccess"] as? [String: Any] {
                fullDiskAccessVerified = disk["verified"] as? Bool
            }
            if let service = payload["service"] as? [String: Any] {
                startAtLogin = service["startAtLogin"] as? Bool == true
            }
            return
        }
        if action == "tunnel.installClient",
           let command = result as? [String: Any],
           let stdout = command["stdout"] as? String,
           let data = stdout.data(using: .utf8),
           let installed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            tunnelCommand = installed["installPath"] as? String ?? tunnelCommand
            return
        }
        if action == "browser.prepare" || action == "browser.revealExtension",
           let payload = result as? [String: Any],
           let extensionInfo = payload["extension"] as? [String: Any] {
            browserExtensionPath = extensionInfo["unpackedPath"] as? String ?? browserExtensionPath
            return
        }
        if action == "permissions.fullDiskAccessStatus", let status = result as? [String: Any] {
            fullDiskAccessVerified = status["verified"] as? Bool
            return
        }
        guard let command = result as? [String: Any], let stdout = command["stdout"] as? String,
              let data = stdout.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if action == "browser.doctor" { browserReady = parsed["healthy"] as? Bool == true }
        if action == "desktop.doctor" || action == "desktop.permissions" {
            computerUseReady = parsed["permissionsReady"] as? Bool == true
            if let permissions = parsed["permissions"] as? [String: Any] {
                accessibilityGranted = permissions["accessibilityTrusted"] as? Bool == true
                screenRecordingGranted = permissions["screenCaptureGranted"] as? Bool == true
            }
        }
    }

    private func applyConfig(_ value: [String: Any]) {
        allowedRoots = value["allowedRoots"] as? [String] ?? allowedRoots
        if let port = value["port"] as? Int { mcpPort = port }
        publicBaseURL = value["publicBaseUrl"] as? String ?? publicBaseURL
        guard let tunnel = value["tunnel"] as? [String: Any] else { return }
        tunnelEnabled = tunnel["enabled"] as? Bool ?? tunnelEnabled
        tunnelAutoStart = tunnel["autoStart"] as? Bool ?? tunnelAutoStart
        tunnelPreset = tunnel["preset"] as? String ?? tunnelPreset
        tunnelID = tunnel["tunnelId"] as? String ?? tunnelID
        tunnelAPIKeyFile = tunnel["apiKeyFile"] as? String ?? tunnelAPIKeyFile
        tunnelCommand = tunnel["command"] as? String ?? tunnelCommand
        tunnelArguments = (tunnel["args"] as? [String] ?? []).joined(separator: "\n")
        tunnelWorkingDirectory = tunnel["cwd"] as? String ?? tunnelWorkingDirectory
        tunnelRestart = tunnel["restartOnExit"] as? Bool ?? tunnelRestart
    }

    private func pretty(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return String(describing: value) }
        return text
    }

    private func setOutput(_ value: String, _ destination: OutputDestination) {
        switch destination {
        case .tunnel: tunnelOutput = value
        case .browser: browserOutput = value
        case .permissions: permissionOutput = value
        case .updates: updateOutput = value
        case .diagnostics: diagnosticOutput = value
        }
    }
}

enum OutputDestination { case tunnel, browser, permissions, updates, diagnostics }

struct ControlError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - Native UI

enum DevSpacePage: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case setup = "Setup"
    case settings = "Settings"
    case workspaces = "Workspaces"
    case tunnel = "Tunnel"
    case browser = "Browser"
    case permissions = "Permissions"
    case startup = "Startup"
    case updates = "Updates"
    case diagnostics = "Diagnostics"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .setup: "checklist"
        case .settings: "gearshape"
        case .workspaces: "folder"
        case .tunnel: "point.3.connected.trianglepath.dotted"
        case .browser: "safari"
        case .permissions: "lock.shield"
        case .startup: "power"
        case .updates: "arrow.triangle.2.circlepath"
        case .diagnostics: "stethoscope"
        }
    }
}

struct DevSpaceRootView: View {
    @ObservedObject var model: DevSpaceControlModel
    @State private var page: DevSpacePage = .overview

    var body: some View {
        NavigationSplitView {
            List(selection: $page) {
                Section {
                    nav(.overview)
                    nav(.setup)
                    nav(.settings)
                }
                Section("Configuration") {
                    nav(.workspaces)
                    nav(.tunnel)
                }
                Section("Capabilities") {
                    nav(.browser)
                    nav(.permissions)
                }
                Section("System") {
                    nav(.startup)
                    nav(.updates)
                    nav(.diagnostics)
                }
            }
            .navigationTitle("DevSpace")
            .listStyle(.sidebar)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 8) {
                    Circle().fill(model.serviceRunning ? Color.green : Color.secondary).frame(width: 8, height: 8)
                    Text(model.serviceRunning ? "Service running" : "Service stopped").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(12)
            }
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch page {
                    case .overview: OverviewView(model: model, page: $page)
                    case .setup: SetupView(model: model, page: $page)
                    case .settings: SettingsView(model: model, page: $page)
                    case .workspaces: WorkspacesView(model: model)
                    case .tunnel: TunnelView(model: model)
                    case .browser: BrowserView(model: model)
                    case .permissions: PermissionsView(model: model)
                    case .startup: StartupView(model: model)
                    case .updates: UpdatesView(model: model)
                    case .diagnostics: DiagnosticsView(model: model)
                    }
                }
                .frame(maxWidth: 900, alignment: .leading)
                .padding(32)
            }
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(minWidth: 980, minHeight: 680)
        .onAppear { model.refresh() }
        .onChange(of: model.backendReady) { ready in if ready && !model.configExists { page = .setup } }
        .onChange(of: model.configExists) { exists in if model.backendReady && !exists { page = .setup } }
    }

    private func nav(_ item: DevSpacePage) -> some View {
        Label(item.rawValue, systemImage: item.icon).tag(item)
    }
}

struct SettingsView: View {
    @ObservedObject var model: DevSpaceControlModel
    @Binding var page: DevSpacePage

    var body: some View {
        PageHeader(title: "Settings", subtitle: "Common configuration and system access in one place.")
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Workspace & service").font(.headline)
                StatusRow(title: "Allowed folders", value: model.allowedRoots.isEmpty ? "Not configured" : "\(model.allowedRoots.count) folder(s)", ok: !model.allowedRoots.isEmpty)
                StatusRow(title: "Local MCP", value: model.localMCPURL, ok: model.serviceRunning)
                HStack { Spacer(); Button("Configure Workspaces") { page = .workspaces } }
            }
        }
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Remote access").font(.headline)
                StatusRow(title: "Tunnel", value: model.tunnelEnabled ? (model.tunnelConfigured ? "Configured" : "Needs setup") : "Disabled", ok: model.tunnelEnabled ? model.tunnelConfigured : nil)
                StatusRow(title: "Remote MCP", value: model.publicMCPURL, ok: model.tunnelEnabled ? model.tunnelConfigured : nil)
                HStack { Spacer(); Button("Configure Tunnel") { page = .tunnel } }
            }
        }
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Permissions").font(.headline)
                StatusRow(title: "Accessibility", value: model.accessibilityGranted ? "Allowed" : "Permission required", ok: model.accessibilityGranted)
                StatusRow(title: "Screen Recording", value: model.screenRecordingGranted ? "Allowed" : "Permission required", ok: model.screenRecordingGranted)
                StatusRow(title: "Full Disk Access", value: model.fullDiskAccessVerified == true ? "Verified" : "Optional / not verified", ok: model.fullDiskAccessVerified)
                HStack { Spacer(); Button("Review Permissions") { page = .permissions } }
            }
        }
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Startup").font(.headline)
                StatusRow(title: "Start at login", value: model.startAtLogin ? "Enabled" : "Disabled", ok: model.startAtLogin)
                StatusRow(title: "Core service", value: model.serviceRunning ? "Running" : "Stopped", ok: model.serviceRunning)
                HStack { Spacer(); Button("Configure Startup") { page = .startup } }
            }
        }
    }
}

struct PageHeader: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 28, weight: .bold))
            Text(subtitle).font(.body).foregroundStyle(.secondary)
        }
    }
}

struct NativeCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.07)))
    }
}

struct StatusRow: View {
    let title: String
    let value: String
    let ok: Bool?
    var body: some View {
        HStack {
            if let ok { Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill").foregroundStyle(ok ? .green : .orange) }
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).textSelection(.enabled)
        }.padding(.vertical, 3)
    }
}

struct OverviewView: View {
    @ObservedObject var model: DevSpaceControlModel
    @Binding var page: DevSpacePage
    var body: some View {
        PageHeader(title: "DevSpace", subtitle: "Your local Agent gateway for workspaces, browser and Computer Use.")
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: model.setupReady ? "checkmark.seal.fill" : model.serviceRunning ? "exclamationmark.triangle.fill" : "pause.circle.fill")
                        .font(.system(size: 34)).foregroundStyle(model.setupReady ? .green : .orange)
                    VStack(alignment: .leading) {
                        Text(model.setupReady ? "DevSpace is ready" : model.serviceRunning ? "Setup needs attention" : "Core service is stopped").font(.title3.bold())
                        Text(model.statusMessage).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Restart") { model.run("service.restart") }.disabled(model.busy)
                    Button(model.serviceRunning ? "Stop" : "Start") { model.run(model.serviceRunning ? "service.stop" : "service.start") }.disabled(model.busy)
                }
                Divider()
                StatusRow(title: "Local MCP", value: model.localMCPURL, ok: model.serviceRunning)
                StatusRow(title: "Remote MCP", value: model.publicMCPURL, ok: model.tunnelEnabled ? model.tunnelConfigured : nil)
                StatusRow(title: "Browser", value: model.browserReady ? "Connected" : "Needs setup", ok: model.browserReady)
                StatusRow(title: "Computer Use", value: model.computerUseReady ? "Ready" : "Needs permission", ok: model.computerUseReady)
                StatusRow(title: "Start at login", value: model.startAtLogin ? "Enabled" : "Disabled", ok: model.startAtLogin)
                if !model.setupBlockers.isEmpty {
                    Divider()
                    Text("Needs attention: \(model.setupBlockers.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        HStack(spacing: 14) {
            NativeCard { shortcut("Setup", "Complete first-run configuration", "checklist") { page = .setup } }
            NativeCard { shortcut("Browser", "Install and verify Chrome control", "safari") { page = .browser } }
            NativeCard { shortcut("Permissions", "Review Computer Use access", "lock.shield") { page = .permissions } }
        }
        NativeCard {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Runtime").font(.headline)
                    Text("Node \(model.nodeVersion) · \(model.architecture)").foregroundStyle(.secondary)
                }
                Spacer()
                Button("Copy Local MCP") { model.copy(model.localMCPURL) }
                if model.publicMCPURL != "Not configured" { Button("Copy Remote MCP") { model.copy(model.publicMCPURL) } }
            }
        }
    }

    private func shortcut(_ title: String, _ subtitle: String, _ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.title2).frame(width: 30).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) { Text(title).font(.headline); Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
        }.buttonStyle(.plain)
    }
}

struct SetupView: View {
    @ObservedObject var model: DevSpaceControlModel
    @Binding var page: DevSpacePage
    var body: some View {
        PageHeader(title: "Setup Assistant", subtitle: "Complete these steps once on a new Mac. DevSpace handles everything up to macOS and Chrome security confirmations.")
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(model.setupReady ? "Ready" : "Setup progress").font(.headline)
                    Spacer()
                    Button("Recheck") { model.refreshReadiness() }.disabled(model.busy)
                }
                ProgressView(value: Double(model.setupProgress), total: 5)
                Text(model.setupReady ? "All required setup checks passed." : "\(model.setupProgress) of 5 core steps ready").font(.caption).foregroundStyle(.secondary)
            }
        }
        setupStep(1, "Choose workspace folders", "Limit AI access to explicit project roots.", !model.allowedRoots.isEmpty, "Configure") { page = .workspaces }
        setupStep(2, "Configure remote Tunnel", "Enter Tunnel ID and credential file, or use a custom tunnel command.", model.tunnelConfigured || !model.tunnelEnabled, "Configure") { page = .tunnel }
        setupStep(3, "Set up Browser", "Install the bundled Chrome bridge and verify the signed-in profile.", model.browserReady, "Continue") { page = .browser }
        setupStep(4, "Grant Computer Use permissions", "Authorize Accessibility and Screen Recording, then verify the Desktop Host.", model.computerUseReady, "Continue") { page = .permissions }
        setupStep(5, "Start automatically", "Keep DevSpace available after login and verify the Core service.", model.startAtLogin && model.serviceRunning, "Configure") { page = .startup }
        if model.setupReady {
            NativeCard {
                HStack(spacing: 14) {
                    Image(systemName: "checkmark.seal.fill").font(.title).foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Ready to use").font(.headline)
                        Text("DevSpace passed the workspace, Browser, Computer Use and startup checks.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Copy MCP URL") { model.copy(model.publicMCPURL == "Not configured" ? model.localMCPURL : model.publicMCPURL) }
                }
            }
        }
    }

    private func setupStep(_ number: Int, _ title: String, _ subtitle: String, _ done: Bool, _ button: String, action: @escaping () -> Void) -> some View {
        NativeCard {
            HStack(spacing: 14) {
                ZStack { Circle().fill(done ? Color.green : Color.accentColor.opacity(0.12)).frame(width: 36, height: 36); Text(done ? "✓" : "\(number)").font(.headline).foregroundStyle(done ? Color.white : Color.accentColor) }
                VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline); Text(subtitle).foregroundStyle(.secondary) }
                Spacer(); Button(button, action: action)
            }
        }
    }
}

struct WorkspacesView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Workspaces", subtitle: "Only these folders are exposed to MCP clients. Full Disk Access never widens this list.")
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Allowed folders").font(.headline); Spacer(); Button("Add Folder…") { model.addWorkspaceFolder() } }
                if model.allowedRoots.isEmpty { Text("No folders selected.").foregroundStyle(.secondary) }
                ForEach(model.allowedRoots, id: \.self) { root in
                    HStack { Image(systemName: "folder.fill").foregroundStyle(.tint); Text(root).textSelection(.enabled); Spacer(); Button { model.allowedRoots.removeAll { $0 == root } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless) }
                }
            }
        }
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Local service").font(.headline)
                HStack { Text("MCP Port"); Spacer(); TextField("7676", value: $model.mcpPort, format: .number).frame(width: 100).textFieldStyle(.roundedBorder) }
                StatusRow(title: "Endpoint", value: model.localMCPURL, ok: nil)
            }
        }
        HStack { Spacer(); Button("Save & Restart") { model.saveConfiguration(restart: true) }.buttonStyle(.borderedProminent).disabled(model.allowedRoots.isEmpty || model.busy) }
    }
}

struct TunnelView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Remote Tunnel", subtitle: "Configure remote MCP access without editing shell commands for the common tunnel-client flow.")
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                Toggle("Enable managed Tunnel", isOn: $model.tunnelEnabled)
                Picker("Mode", selection: $model.tunnelPreset) { Text("DevSpace tunnel-client").tag("tunnel-client"); Text("Custom command").tag("custom") }.pickerStyle(.segmented)
                if model.tunnelPreset == "tunnel-client" {
                    field("Tunnel ID", text: $model.tunnelID, placeholder: "tunnel_…")
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Runtime API key").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            SecureField("Paste Runtime API key", text: $model.tunnelRuntimeAPIKey).textFieldStyle(.roundedBorder)
                            Button("Save Key") { model.saveTunnelRuntimeAPIKey() }.disabled(model.tunnelRuntimeAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                        }
                        Text("The key is written to DevSpace's local secrets directory with mode 0600; normal configuration stores only the file path.").font(.caption2).foregroundStyle(.secondary)
                    }
                    HStack { field("API-key file", text: $model.tunnelAPIKeyFile, placeholder: "~/.config/devspace/tunnel-api-key"); Button("Choose…") { model.chooseTunnelAPIKeyFile() } }
                    HStack { field("Tunnel executable", text: $model.tunnelCommand, placeholder: "Auto-detect tunnel-client"); Button("Choose…") { model.chooseTunnelExecutable() } }
                    HStack {
                        Text("Install or update OpenAI's official tunnel-client and verify its published SHA-256 checksum.").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Install / Update tunnel-client") { model.run("tunnel.installClient", destination: .tunnel) }.disabled(model.busy)
                    }
                } else {
                    HStack { field("Command", text: $model.tunnelCommand, placeholder: "/usr/local/bin/cloudflared"); Button("Choose…") { model.chooseTunnelExecutable() } }
                    VStack(alignment: .leading) { Text("Arguments, one per line").font(.caption).foregroundStyle(.secondary); TextEditor(text: $model.tunnelArguments).font(.system(.body, design: .monospaced)).frame(minHeight: 100).padding(5).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8)) }
                }
                field("Public base URL", text: $model.publicBaseURL, placeholder: "https://devspace.example.com")
                Toggle("Connect when DevSpace starts", isOn: $model.tunnelAutoStart)
                Toggle("Reconnect automatically", isOn: $model.tunnelRestart)
            }
        }
        HStack { Button("Copy Local MCP") { model.copy(model.localMCPURL) }; Spacer(); Button("Save & Restart") { model.saveConfiguration(restart: true) }.buttonStyle(.borderedProminent).disabled(model.busy) }
        if !model.tunnelOutput.isEmpty { DiagnosticBox(text: model.tunnelOutput) }
    }

    private func field(_ title: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(title).font(.caption).foregroundStyle(.secondary); TextField(placeholder, text: text).textFieldStyle(.roundedBorder) }.frame(maxWidth: .infinity)
    }
}

struct BrowserView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Browser", subtitle: "DevSpace ships its Chrome extension inside the App and automates setup up to Chrome's security confirmation.")
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Browser Bridge", systemImage: "safari").font(.headline)
                    Spacer()
                    Label(model.browserReady ? "Connected" : "Needs verification", systemImage: model.browserReady ? "checkmark.circle.fill" : "clock.badge.exclamationmark")
                        .foregroundStyle(model.browserReady ? .green : .orange)
                }
                Text("Set Up Browser installs the Native Messaging Host, reveals the bundled extension folder, and opens chrome://extensions. In Chrome, enable Developer mode → Load unpacked → select the revealed folder.").foregroundStyle(.secondary)
                HStack {
                    Button("Set Up Browser") { model.run("browser.prepare", destination: .browser) }.buttonStyle(.borderedProminent)
                    Button("Reveal Extension") { model.run("browser.revealExtension", destination: .browser) }
                    Button("Open Chrome Extensions") { model.run("browser.openExtensions", destination: .browser) }
                    Button("Run Doctor") { model.run("browser.doctor", destination: .browser) }
                }
                if !model.browserExtensionPath.isEmpty {
                    Divider()
                    HStack { Text("Bundled extension").foregroundStyle(.secondary); Spacer(); Text(model.browserExtensionPath).font(.caption.monospaced()).textSelection(.enabled); Button("Copy") { model.copy(model.browserExtensionPath) } }
                }
            }
        }
        instruction(1, "Chrome opens its Extensions page")
        instruction(2, "Turn on Developer mode")
        instruction(3, "Click Load unpacked and select the DevSpace folder revealed in Finder")
        instruction(4, "Return here and run Browser Doctor")
        if !model.browserOutput.isEmpty { DiagnosticBox(text: model.browserOutput) }
    }
    private func instruction(_ number: Int, _ text: String) -> some View { HStack { Text("\(number)").font(.headline).frame(width: 28, height: 28).background(Color.accentColor.opacity(0.12), in: Circle()); Text(text); Spacer() }.padding(.horizontal, 4) }
}

struct PermissionsView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Permissions", subtitle: "macOS owns these confirmations. DevSpace opens the correct Settings page and verifies the result; it never bypasses TCC.")
        permissionCard("Accessibility", "Required for semantic UI inspection and input control.", "figure.walk.motion", "permissions.openAccessibility", model.accessibilityGranted)
        permissionCard("Screen Recording", "Required for window and screen capture used by Computer Use.", "rectangle.dashed.badge.record", "permissions.openScreenRecording", model.screenRecordingGranted)
        NativeCard {
            HStack(spacing: 14) {
                Image(systemName: "externaldrive.badge.timemachine").font(.title2).foregroundStyle(.tint).frame(width: 34)
                VStack(alignment: .leading, spacing: 4) { HStack { Text("Full Disk Access").font(.headline); if let verified = model.fullDiskAccessVerified { Label(verified ? "Verified" : "Not verified", systemImage: verified ? "checkmark.circle.fill" : "questionmark.circle").font(.caption).foregroundStyle(verified ? .green : .orange) } }; Text("Optional. Use it only when your allowed workspace roots include macOS privacy-protected locations. The workspace allowlist still applies.").foregroundStyle(.secondary) }
                Spacer()
                Button("Open Settings") { model.run("permissions.openFullDiskAccess", destination: .permissions) }
                Button("Verify") { model.run("permissions.fullDiskAccessStatus", destination: .permissions) }
            }
        }
        NativeCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) { Text("Computer Use Host").font(.headline); Text("Install the stable signed helper, request permissions, then verify both grants.").foregroundStyle(.secondary) }
                Spacer()
                Button("Install Host") { model.run("desktop.install", destination: .permissions) }
                Button("Request Permissions") { model.run("desktop.permissions", destination: .permissions) }.buttonStyle(.borderedProminent)
                Button("Check Again") { model.run("desktop.doctor", destination: .permissions) }
            }
        }
        if !model.permissionOutput.isEmpty { DiagnosticBox(text: model.permissionOutput) }
    }

    private func permissionCard(_ title: String, _ subtitle: String, _ icon: String, _ action: String, _ granted: Bool) -> some View {
        NativeCard { HStack(spacing: 14) { Image(systemName: icon).font(.title2).foregroundStyle(.tint).frame(width: 34); VStack(alignment: .leading, spacing: 4) { HStack { Text(title).font(.headline); Label(granted ? "Allowed" : "Permission required", systemImage: granted ? "checkmark.circle.fill" : "exclamationmark.circle").font(.caption).foregroundStyle(granted ? .green : .orange) }; Text(subtitle).foregroundStyle(.secondary) }; Spacer(); Button("Open System Settings") { model.run(action, destination: .permissions) }; Button("Check Again") { model.run("desktop.doctor", destination: .permissions) } } }
    }
}

struct StartupView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Startup", subtitle: "Keep DevSpace available after login without keeping the Control Center window open.")
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                StatusRow(title: "Start at login", value: model.startAtLogin ? "Enabled" : "Disabled", ok: model.startAtLogin)
                StatusRow(title: "Core service", value: model.serviceRunning ? "Running" : "Stopped", ok: model.serviceRunning)
                HStack {
                    Button("Enable & Start") { model.run("service.start") }.buttonStyle(.borderedProminent)
                    Button("Restart") { model.run("service.restart") }
                    Button("Stop") { model.run("service.stop") }
                    Button("Disable Login Start") { model.run("service.disableLogin") }
                    Spacer(); Button("Service Doctor") { model.run("service.doctor") }
                }
            }
        }
    }
}

struct UpdatesView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Updates", subtitle: "Verified releases install transactionally and keep the previous App for rollback.")
        NativeCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) { Text("Stable channel").font(.headline); Text("Downloads are SHA-256 verified before installation.").foregroundStyle(.secondary) }
                Spacer()
                Button("Check for Updates") { model.run("update.check", destination: .updates) }
                Button("Update Now") { model.run("update.install", destination: .updates) }.buttonStyle(.borderedProminent)
                Button("Rollback") { model.run("update.rollback", destination: .updates) }
            }
        }
        if !model.updateOutput.isEmpty { DiagnosticBox(text: model.updateOutput) }
    }
}

struct DiagnosticsView: View {
    @ObservedObject var model: DevSpaceControlModel
    var body: some View {
        PageHeader(title: "Diagnostics", subtitle: "Inspect the system without making the Web UI the primary product surface.")
        NativeCard {
            HStack { Button("Core Doctor") { model.run("service.doctor") }; Button("Browser Doctor") { model.run("browser.doctor") }; Button("Computer Use Doctor") { model.run("desktop.doctor") }; Spacer(); Button("Open Web Control Center") { model.openWebControlCenter() } }
        }
        if !model.diagnosticOutput.isEmpty { DiagnosticBox(text: model.diagnosticOutput) }
    }
}

struct DiagnosticBox: View {
    let text: String
    var body: some View { ScrollView { Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(14) }.frame(maxHeight: 280).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 12, style: .continuous)) }
}

// MARK: - App lifecycle and menu bar

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var statusTimer: Timer?
    private var statusMenuItem: NSMenuItem!
    private var tunnelMenuItem: NSMenuItem!
    private var browserMenuItem: NSMenuItem!
    private var computerUseMenuItem: NSMenuItem!
    private var controlProcess: Process?
    private var readinessTimer: Timer?
    private let port = Int(ProcessInfo.processInfo.environment["DEVSPACE_CONTROL_PORT"] ?? "7680") ?? 7680
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private lazy var model = DevSpaceControlModel(port: port, token: token)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        buildStatusItem()
        startControlCenter()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        readinessTimer?.invalidate(); statusTimer?.invalidate()
        if let process = controlProcess, process.isRunning { process.terminate() }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard model.backendReady else { return }
        model.refresh()
        model.refreshReadiness()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.updateMenuState() }
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "DevSpace"
        window.titlebarAppearsTransparent = true
        window.center()
        window.contentViewController = NSHostingController(rootView: DevSpaceRootView(model: model))
        window.makeKeyAndOrderFront(nil)
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
        tunnelMenuItem = NSMenuItem(title: "Tunnel: checking…", action: nil, keyEquivalent: "")
        browserMenuItem = NSMenuItem(title: "Browser: checking…", action: nil, keyEquivalent: "")
        computerUseMenuItem = NSMenuItem(title: "Computer Use: checking…", action: nil, keyEquivalent: "")
        for item in [tunnelMenuItem!, browserMenuItem!, computerUseMenuItem!] {
            item.isEnabled = false
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Show DevSpace", action: #selector(showControlCenter), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Start Service", action: #selector(startService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Service", action: #selector(restartService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop Service", action: #selector(stopService), keyEquivalent: ""))
        menu.addItem(.separator()); menu.addItem(NSMenuItem(title: "Refresh Status", action: #selector(refreshStatus), keyEquivalent: "")); menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit DevSpace", action: #selector(quitApp), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
    }

    @objc private func showControlCenter() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func startService() { callControlAction("service.start") }
    @objc private func restartService() { callControlAction("service.restart") }
    @objc private func stopService() { callControlAction("service.stop") }
    @objc private func quitApp() { NSApp.terminate(nil) }
    @objc private func refreshStatus() { Task { @MainActor in model.refresh(); updateMenuState() } }

    private func updateMenuState() {
        if model.setupReady {
            statusMenuItem.title = "DevSpace ready"
            statusItem.button?.contentTintColor = .systemGreen
        } else if model.serviceRunning {
            statusMenuItem.title = "DevSpace needs setup"
            statusItem.button?.contentTintColor = .systemOrange
        } else {
            statusMenuItem.title = "DevSpace service stopped"
            statusItem.button?.contentTintColor = .systemGray
        }
        tunnelMenuItem.title = model.tunnelEnabled ? "Tunnel: \(model.tunnelConfigured ? "configured" : "needs setup")" : "Tunnel: disabled"
        browserMenuItem.title = "Browser: \(model.browserReady ? "connected" : "needs setup")"
        computerUseMenuItem.title = "Computer Use: \(model.computerUseReady ? "ready" : "needs permission")"
    }

    private func callControlAction(_ action: String) {
        Task { @MainActor in
            model.run(action)
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            model.refresh(); updateMenuState()
        }
    }

    private func startControlCenter() {
        guard let resources = Bundle.main.resourceURL else { showFailure("Unable to locate DevSpace application resources."); return }
        let node = resources.appendingPathComponent("runtime/node")
        let cli = resources.appendingPathComponent("devspace/dist/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else { showFailure("The bundled DevSpace runtime is incomplete. Reinstall the application."); return }
        let process = Process(); process.executableURL = node; process.arguments = [cli.path, "control-center", "--host", "127.0.0.1", "--port", String(port), "--no-open"]
        var env = ProcessInfo.processInfo.environment; env["DEVSPACE_CONTROL_TOKEN"] = token; process.environment = env
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] process in DispatchQueue.main.async { if process.terminationStatus != 0 { self?.showFailure("DevSpace Control Center stopped unexpectedly (exit \(process.terminationStatus)).") } } }
        do { try process.run(); controlProcess = process; beginReadinessProbe() } catch { showFailure("Unable to launch the bundled runtime: \(error.localizedDescription)") }
    }

    private func beginReadinessProbe() {
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        var attempts = 0
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] timer in
            attempts += 1
            var request = URLRequest(url: url); request.timeoutInterval = 0.4
            URLSession.shared.dataTask(with: request) { _, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) else {
                    if attempts > 75 { DispatchQueue.main.async { timer.invalidate(); self?.showFailure("DevSpace Control Center did not become ready.") } }
                    return
                }
                DispatchQueue.main.async {
                    timer.invalidate()
                    self?.model.backendReady = true
                    self?.model.statusMessage = "Control Center ready"
                    self?.model.refresh()
                    self?.model.refreshReadiness()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self?.updateMenuState() }
                }
            }.resume()
        }
    }

    private func showFailure(_ message: String) {
        Task { @MainActor in model.statusMessage = message; model.diagnosticOutput = message }
        let alert = NSAlert(); alert.messageText = "DevSpace could not start"; alert.informativeText = message; alert.alertStyle = .critical; alert.runModal()
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
