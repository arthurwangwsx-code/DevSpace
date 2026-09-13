import AppKit
import ApplicationServices
import Foundation

let helperVersion = "0.1.0"

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
            "maxDepth": integerSchema(1, 12),
            "maxNodes": integerSchema(1, 2_000),
        ], ["bundleId"]),
        tool("desktop_activate_app", "Bring the leased application to the foreground.", [
            "bundleId": stringSchema(),
        ], ["bundleId"]),
        tool("desktop_click_point", "Click a point when the leased app is frontmost.", [
            "bundleId": stringSchema(), "x": numberSchema(), "y": numberSchema(),
        ], ["bundleId", "x", "y"]),
        tool("desktop_type_text", "Type into a verified non-secure focused field.", [
            "bundleId": stringSchema(), "text": stringSchema(),
        ], ["bundleId", "text"]),
        tool("desktop_press_key", "Press an allowlisted key in the frontmost leased app.", [
            "bundleId": stringSchema(), "key": stringSchema(),
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
        let app = try runningApplication(bundleId)
        let maxDepth = boundedInt(arguments["maxDepth"], 6, 1, 12)
        let maxNodes = boundedInt(arguments["maxNodes"], 500, 1, 2_000)
        var count = 0
        let tree = snapshot(AXUIElementCreateApplication(app.processIdentifier), 0, maxDepth, maxNodes, &count)
        return ["bundleId": bundleId, "processId": app.processIdentifier, "nodeCount": count, "tree": tree]
    case "desktop_activate_app":
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId)
        guard app.activate(options: [.activateAllWindows]) else {
            throw HelperError(message: "The leased application could not be activated.")
        }
        return ["activated": true, "bundleId": bundleId]
    case "desktop_click_point":
        try requireAccessibility()
        let bundleId = try requiredString(arguments, "bundleId")
        try requireFrontmost(bundleId)
        let point = CGPoint(x: try requiredNumber(arguments, "x"), y: try requiredNumber(arguments, "y"))
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        else { throw HelperError(message: "Could not create mouse events.") }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return ["clicked": true, "bundleId": bundleId]
    case "desktop_type_text":
        try requireAccessibility()
        let bundleId = try requiredString(arguments, "bundleId")
        try requireFrontmost(bundleId)
        try requireNonSecureFocusedElement()
        var units = Array(try requiredString(arguments, "text").utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { throw HelperError(message: "Could not create keyboard events.") }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return ["typed": true, "characters": units.count, "bundleId": bundleId]
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
    let bundleId = try requiredString(arguments, "bundleId")
    try requireFrontmost(bundleId)
    try requireNonSecureFocusedElement()
    let key = try requiredString(arguments, "key")
    let codes: [String: CGKeyCode] = [
        "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Escape": 53,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    ]
    guard let code = codes[key] else { throw HelperError(message: "Key is not allowlisted.") }
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
    return ["pressed": key, "bundleId": bundleId]
}

func requireAccessibility() throws {
    if !AXIsProcessTrusted() {
        throw HelperError(message: "Accessibility permission is required for this helper binary.")
    }
}

func runningApplication(_ bundleId: String) throws -> NSRunningApplication {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first,
          !app.isTerminated else {
        throw HelperError(message: "The leased application is not running.")
    }
    return app
}

func requireFrontmost(_ bundleId: String) throws {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId else {
        throw HelperError(message: "The leased application is not frontmost; refusing global input.")
    }
}

func requireNonSecureFocusedElement() throws {
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
    let role = attributeString(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = attributeString(element, kAXSubroleAttribute as CFString) ?? ""
    if role.localizedCaseInsensitiveContains("secure")
        || subrole.localizedCaseInsensitiveContains("secure") {
        throw HelperError(message: "Secure fields cannot receive automated input.")
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
