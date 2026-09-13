import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

let helperVersion = "0.3.0"
let userActivityYieldSeconds = 1.0

struct HelperError: Error {
    let message: String
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = message["id"] else { continue }
    let method = message["method"] as? String ?? ""
    do {
        if method == "initialize" {
            let params = message["params"] as? [String: Any]
            let version = params?["protocolVersion"] as? String ?? "2025-06-18"
            respond(id, [
                "protocolVersion": version,
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": "devspace-desktop-helper", "version": helperVersion],
            ])
        } else if method == "ping" {
            respond(id, [:])
        } else if method == "tools/list" {
            respond(id, ["tools": toolDefinitions()])
        } else if method == "tools/call" {
            let params = message["params"] as? [String: Any] ?? [:]
            let name = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            respond(id, toolResult(try callTool(name, arguments)))
        } else {
            respondError(id, -32601, "Method not found")
        }
    } catch let error as HelperError {
        respond(id, toolError(error.message))
    } catch {
        respond(id, toolError("Desktop helper operation failed."))
    }
}

func toolDefinitions() -> [[String: Any]] {
    return [
        tool("desktop_status", "Read macOS automation permission state.", [:], []),
        tool("desktop_list_apps", "List running GUI applications without window titles.", [:], []),
        tool("desktop_snapshot_app", "Read a bounded accessibility tree for one application.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
            "maxDepth": integerSchema(1, 12),
            "maxNodes": integerSchema(1, 2_000),
        ], ["bundleId"]),
        tool("desktop_screenshot_app", "Capture only the largest visible window of one application.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
            "maxWidth": integerSchema(64, 4_096),
            "maxHeight": integerSchema(64, 4_096),
        ], ["bundleId"]),
        tool("desktop_activate_app", "Bring the leased application to the foreground.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
        ], ["bundleId"]),
        tool("desktop_click_point", "Click a point when the leased app is frontmost.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "x": numberSchema(), "y": numberSchema(),
        ], ["bundleId", "x", "y"]),
        tool("desktop_type_text", "Type into the leased application's focused field.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "text": stringSchema(),
        ], ["bundleId", "text"]),
        tool("desktop_press_key", "Press an allowlisted key in the frontmost leased app.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "key": stringSchema(),
        ], ["bundleId", "key"]),
    ]
}

func tool(_ name: String, _ description: String, _ properties: [String: Any], _ required: [String]) -> [String: Any] {
    return [
        "name": name,
        "description": description,
        "inputSchema": [
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        ],
    ]
}

func stringSchema() -> [String: Any] { ["type": "string", "minLength": 1] }
func numberSchema() -> [String: Any] { ["type": "number"] }
func integerSchema(_ minimum: Int, _ maximum: Int) -> [String: Any] {
    ["type": "integer", "minimum": minimum, "maximum": maximum]
}

func callTool(_ name: String, _ arguments: [String: Any]) throws -> [String: Any] {
    switch name {
    case "desktop_status":
        return desktopStatus()
    case "desktop_list_apps":
        return ["apps": listApps()]
    case "desktop_snapshot_app":
        try requireAccessibility()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        let maxDepth = boundedInt(arguments["maxDepth"], 6, 1, 12)
        let maxNodes = boundedInt(arguments["maxNodes"], 500, 1, 2_000)
        var count = 0
        let tree = snapshot(AXUIElementCreateApplication(app.processIdentifier), 0, maxDepth, maxNodes, &count)
        return ["bundleId": bundleId, "processId": app.processIdentifier, "nodeCount": count, "tree": tree]
    case "desktop_screenshot_app":
        try requireScreenCapture()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        return try screenshotApplication(
            app,
            bundleId,
            boundedInt(arguments["maxWidth"], 1_280, 64, 4_096),
            boundedInt(arguments["maxHeight"], 900, 64, 4_096)
        )
    case "desktop_activate_app":
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        guard app.activate(options: [.activateAllWindows]) else {
            throw HelperError(message: "The leased application could not be activated.")
        }
        return ["activated": true, "bundleId": bundleId, "processId": app.processIdentifier]
    case "desktop_click_point":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        let point = CGPoint(x: try requiredNumber(arguments, "x"), y: try requiredNumber(arguments, "y"))
        try requirePointInApplicationWindow(app, point)
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        else { throw HelperError(message: "Could not create mouse events.") }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return ["clicked": true, "bundleId": bundleId, "processId": app.processIdentifier]
    case "desktop_type_text":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        try requireFocusedElementOwnedByProcess(app.processIdentifier)
        var units = Array(try requiredString(arguments, "text").utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { throw HelperError(message: "Could not create keyboard events.") }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return [
            "typed": true,
            "characters": units.count,
            "bundleId": bundleId,
            "processId": app.processIdentifier,
        ]
    case "desktop_press_key":
        return try pressKey(arguments)
    default:
        throw HelperError(message: "Unknown desktop tool.")
    }
}

func desktopStatus() -> [String: Any] {
    [
        "platform": "macOS",
        "accessibilityTrusted": AXIsProcessTrusted(),
        "screenCaptureGranted": CGPreflightScreenCaptureAccess(),
        "userIdleSeconds": userIdleSeconds(),
        "userActivityYieldSeconds": userActivityYieldSeconds,
        "processId": ProcessInfo.processInfo.processIdentifier,
        "version": helperVersion,
    ]
}

func listApps() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && !$0.isTerminated }
        .compactMap { app in
            guard let bundleId = app.bundleIdentifier else { return nil }
            return [
                "bundleId": bundleId,
                "name": app.localizedName ?? "",
                "processId": app.processIdentifier,
                "frontmost": app.isActive,
            ] as [String: Any]
        }
        .sorted { ($0["bundleId"] as? String ?? "") < ($1["bundleId"] as? String ?? "") }
}

func pressKey(_ arguments: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUserIdle()
    let bundleId = try requiredString(arguments, "bundleId")
    let app = try runningApplication(bundleId, expectedProcessId(arguments))
    try requireFrontmost(app)
    try requireFocusedElementOwnedByProcess(app.processIdentifier)
    let key = try requiredString(arguments, "key")
    let codes: [String: CGKeyCode] = [
        "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Escape": 53,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    ]
    guard let code = codes[key] else { throw HelperError(message: "Key is not allowlisted.") }
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
    return ["pressed": key, "bundleId": bundleId, "processId": app.processIdentifier]
}

func requireAccessibility() throws {
    if !AXIsProcessTrusted() {
        throw HelperError(message: "Accessibility permission is required for this helper binary.")
    }
}

func requireScreenCapture() throws {
    if !CGPreflightScreenCaptureAccess() {
        throw HelperError(message: "Screen capture permission is required for this helper binary.")
    }
}

func userIdleSeconds() -> Double {
    let inputEvents: [CGEventType] = [
        .keyDown, .keyUp,
        .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp, .mouseMoved,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
    ]
    return inputEvents
        .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
        .min() ?? .infinity
}

func requireUserIdle() throws {
    if userIdleSeconds() < userActivityYieldSeconds {
        throw HelperError(message: "User input is active; desktop automation is yielding.")
    }
}

func screenshotApplication(
    _ app: NSRunningApplication,
    _ bundleId: String,
    _ maxWidth: Int,
    _ maxHeight: Int
) throws -> [String: Any] {
    let shareable = try shareableContent()
    let candidates = shareable.windows.filter { window in
        window.owningApplication?.processID == app.processIdentifier
            && window.windowLayer == 0
            && window.isOnScreen
            && window.frame.width > 1
            && window.frame.height > 1
    }
    guard let selected = candidates.max(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
    }) else {
        throw HelperError(message: "The leased application has no visible capturable window.")
    }
    let scale = min(
        1,
        min(Double(maxWidth) / selected.frame.width, Double(maxHeight) / selected.frame.height)
    )
    let width = max(1, Int((selected.frame.width * scale).rounded(.down)))
    let height = max(1, Int((selected.frame.height * scale).rounded(.down)))
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.capturesAudio = false
    let image = try captureImage(SCContentFilter(desktopIndependentWindow: selected), configuration)
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw HelperError(message: "The screenshot could not be encoded.")
    }
    if png.count > 2_500_000 {
        throw HelperError(message: "The screenshot output is too large; use smaller maximum dimensions.")
    }
    return [
        "bundleId": bundleId,
        "processId": app.processIdentifier,
        "windowId": selected.windowID,
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "data": png.base64EncodedString(),
    ]
}

func shareableContent() throws -> SCShareableContent {
    let semaphore = DispatchSemaphore(value: 0)
    var captured: SCShareableContent?
    var capturedError: Error?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
        captured = content
        capturedError = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        throw HelperError(message: "Timed out while enumerating capturable application windows.")
    }
    if capturedError != nil {
        throw HelperError(message: "Visible application windows could not be enumerated.")
    }
    guard let captured else {
        throw HelperError(message: "Visible application windows could not be enumerated.")
    }
    return captured
}

func captureImage(_ filter: SCContentFilter, _ configuration: SCStreamConfiguration) throws -> CGImage {
    let semaphore = DispatchSemaphore(value: 0)
    var captured: CGImage?
    var capturedError: Error?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
        captured = image
        capturedError = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        throw HelperError(message: "Timed out while capturing the leased application window.")
    }
    if capturedError != nil {
        throw HelperError(message: "The leased application window could not be captured.")
    }
    guard let captured else {
        throw HelperError(message: "The leased application window could not be captured.")
    }
    return captured
}

func runningApplication(_ bundleId: String, _ expectedProcessId: pid_t? = nil) throws -> NSRunningApplication {
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        .filter { !$0.isTerminated }
    guard let app = expectedProcessId == nil
        ? applications.first
        : applications.first(where: { $0.processIdentifier == expectedProcessId }) else {
        if expectedProcessId != nil {
            throw HelperError(message: "The leased application process is no longer running.")
        }
        throw HelperError(message: "The leased application is not running.")
    }
    return app
}

func expectedProcessId(_ arguments: [String: Any]) throws -> pid_t? {
    guard let value = arguments["processId"] else { return nil }
    guard let number = value as? NSNumber else {
        throw HelperError(message: "processId must be a positive integer.")
    }
    let integer = number.int64Value
    guard integer > 0, integer <= Int64(Int32.max), number.doubleValue == Double(integer) else {
        throw HelperError(message: "processId must be a positive integer.")
    }
    return pid_t(integer)
}

func requireFrontmost(_ app: NSRunningApplication) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
        throw HelperError(message: "The leased application is not frontmost; refusing global input.")
    }
}

func requirePointInApplicationWindow(_ app: NSRunningApplication, _ point: CGPoint) throws {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement],
          windows.contains(where: { window in
              guard let position = pointAttribute(window, kAXPositionAttribute as CFString),
                    let size = sizeAttribute(window, kAXSizeAttribute as CFString) else { return false }
              return CGRect(origin: position, size: size).contains(point)
          }) else {
        throw HelperError(message: "The click point is outside the leased application's windows.")
    }
}

func requireFocusedElementOwnedByProcess(_ processId: pid_t) throws {
    let system = AXUIElementCreateSystemWide()
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        system,
        kAXFocusedUIElementAttribute as CFString,
        &value
    ) == .success, let focused = value else {
        throw HelperError(message: "The focused field cannot be verified.")
    }
    let element = unsafeBitCast(focused, to: AXUIElement.self)
    var focusedProcessId: pid_t = 0
    guard AXUIElementGetPid(element, &focusedProcessId) == .success,
          focusedProcessId == processId else {
        throw HelperError(message: "The focused element does not belong to the leased application.")
    }
}

func snapshot(
    _ element: AXUIElement,
    _ depth: Int,
    _ maxDepth: Int,
    _ maxNodes: Int,
    _ count: inout Int
) -> [String: Any] {
    if count >= maxNodes { return ["truncated": true] }
    count += 1
    let role = attributeString(element, kAXRoleAttribute as CFString) ?? "unknown"
    let subrole = attributeString(element, kAXSubroleAttribute as CFString)
    var node: [String: Any] = ["role": role]
    if let subrole { node["subrole"] = subrole }
    if let title = attributeString(element, kAXTitleAttribute as CFString), !title.isEmpty {
        node["title"] = title
    }
    if let description = attributeString(element, kAXDescriptionAttribute as CFString),
       !description.isEmpty {
        node["description"] = description
    }
    let secure = role.localizedCaseInsensitiveContains("secure")
        || (subrole ?? "").localizedCaseInsensitiveContains("secure")
    if !secure, let value = attributeString(element, kAXValueAttribute as CFString), !value.isEmpty {
        node["value"] = String(value.prefix(1_000))
    }
    if let point = pointAttribute(element, kAXPositionAttribute as CFString) {
        node["position"] = ["x": point.x, "y": point.y]
    }
    if let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        node["size"] = ["width": size.width, "height": size.height]
    }
    if depth < maxDepth && count < maxNodes, let children = childrenAttribute(element) {
        node["children"] = children.prefix(maxNodes - count).map {
            snapshot($0, depth + 1, maxDepth, maxNodes, &count)
        }
    } else if depth >= maxDepth {
        node["truncated"] = true
    }
    return node
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func attributeString(_ element: AXUIElement, _ name: CFString) -> String? {
    attribute(element, name) as? String
}

func childrenAttribute(_ element: AXUIElement) -> [AXUIElement]? {
    attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}

func requiredString(_ arguments: [String: Any], _ name: String) throws -> String {
    guard let value = arguments[name] as? String, !value.isEmpty else {
        throw HelperError(message: "\(name) must be a non-empty string.")
    }
    return value
}

func requiredNumber(_ arguments: [String: Any], _ name: String) throws -> Double {
    guard let value = arguments[name] as? NSNumber else {
        throw HelperError(message: "\(name) must be a number.")
    }
    return value.doubleValue
}

func boundedInt(_ value: Any?, _ fallback: Int, _ minimum: Int, _ maximum: Int) -> Int {
    let number = (value as? NSNumber)?.intValue ?? fallback
    return min(max(number, minimum), maximum)
}

func toolResult(_ value: [String: Any]) -> [String: Any] {
    [
        "content": [["type": "text", "text": jsonString(value)]],
        "structuredContent": value,
    ]
}

func toolError(_ message: String) -> [String: Any] {
    ["content": [["type": "text", "text": message]], "isError": true]
}

func respond(_ id: Any, _ result: [String: Any]) {
    writeJson(["jsonrpc": "2.0", "id": id, "result": result])
}

func respondError(_ id: Any, _ code: Int, _ message: String) {
    writeJson(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]])
}

func writeJson(_ value: [String: Any]) {
    let data = (jsonString(value) + "\n").data(using: .utf8)!
    FileHandle.standardOutput.write(data)
}

func jsonString(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        return "{}"
    }
    return String(data: data, encoding: .utf8) ?? "{}"
}
