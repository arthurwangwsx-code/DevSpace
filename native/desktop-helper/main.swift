import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

let helperVersion = "0.4.2"
let userActivityYieldSeconds = 1.0
let snapshotMaxAgeSeconds = 30.0
let snapshotCacheLimit = 16

struct HelperError: Error {
    let message: String
}

struct SnapshotEntry {
    let bundleId: String
    let processId: pid_t
    let createdAt: Date
    let elements: [String: AXUIElement]
}

var snapshotCache: [String: SnapshotEntry] = [:]

if CommandLine.arguments.contains("--permission-status") {
    emitPermissionResult(desktopStatus())
    exit(0)
}

if CommandLine.arguments.contains("--request-permissions") {
    let accessibilityOptions = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
    ] as CFDictionary
    let accessibilityTrusted = AXIsProcessTrustedWithOptions(accessibilityOptions)
    let screenCaptureGranted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    let result: [String: Any] = [
        "platform": "macOS",
        "accessibilityTrusted": accessibilityTrusted,
        "screenCaptureGranted": screenCaptureGranted,
        "requested": true,
        "version": helperVersion,
    ]
    emitPermissionResult(result)
    exit(accessibilityTrusted && screenCaptureGranted ? 0 : 2)
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
        tool("desktop_list_windows", "List visible windows owned by the leased application process.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
        ], ["bundleId"]),
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
        tool("desktop_screenshot_window", "Capture one exact visible window owned by the leased application.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
            "windowId": integerSchema(1, Int(Int32.max)),
            "maxWidth": integerSchema(64, 4_096),
            "maxHeight": integerSchema(64, 4_096),
        ], ["bundleId", "windowId"]),
        tool("desktop_activate_app", "Bring the leased application to the foreground.", [
            "bundleId": stringSchema(),
            "processId": integerSchema(1, Int(Int32.max)),
        ], ["bundleId"]),
        tool("desktop_click_point", "Click a point when the leased app is frontmost.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "x": numberSchema(), "y": numberSchema(),
            "button": stringSchema(), "clickCount": integerSchema(1, 2),
        ], ["bundleId", "x", "y"]),
        tool("desktop_click_element", "Press a versioned accessibility element from the latest application snapshot.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "snapshotId": stringSchema(), "elementId": stringSchema(),
        ], ["bundleId", "snapshotId", "elementId"]),
        tool("desktop_focus_element", "Focus a versioned accessibility element from the latest application snapshot.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "snapshotId": stringSchema(), "elementId": stringSchema(),
        ], ["bundleId", "snapshotId", "elementId"]),
        tool("desktop_scroll", "Scroll at a point inside the leased application window.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "x": numberSchema(), "y": numberSchema(),
            "deltaX": numberSchema(), "deltaY": numberSchema(),
        ], ["bundleId", "x", "y", "deltaY"]),
        tool("desktop_drag", "Drag between two points inside the leased application's windows.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "fromX": numberSchema(), "fromY": numberSchema(),
            "toX": numberSchema(), "toY": numberSchema(),
            "durationMs": integerSchema(50, 5_000),
        ], ["bundleId", "fromX", "fromY", "toX", "toY"]),
        tool("desktop_type_text", "Type into the leased application's focused field.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "text": stringSchema(),
        ], ["bundleId", "text"]),
        tool("desktop_press_key", "Press an allowlisted key in the frontmost leased app.", [
            "bundleId": stringSchema(), "processId": integerSchema(1, Int(Int32.max)),
            "key": stringSchema(), "modifiers": stringArraySchema(),
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
func stringArraySchema() -> [String: Any] { ["type": "array", "items": stringSchema(), "maxItems": 4] }
func integerSchema(_ minimum: Int, _ maximum: Int) -> [String: Any] {
    ["type": "integer", "minimum": minimum, "maximum": maximum]
}

func callTool(_ name: String, _ arguments: [String: Any]) throws -> [String: Any] {
    switch name {
    case "desktop_status":
        return desktopStatus()
    case "desktop_list_apps":
        return ["apps": listApps()]
    case "desktop_list_windows":
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        return [
            "bundleId": bundleId,
            "processId": app.processIdentifier,
            "windows": windowList(app.processIdentifier),
        ]
    case "desktop_snapshot_app":
        try requireAccessibility()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        let maxDepth = boundedInt(arguments["maxDepth"], 6, 1, 12)
        let maxNodes = boundedInt(arguments["maxNodes"], 500, 1, 2_000)
        var count = 0
        var elements: [String: AXUIElement] = [:]
        let snapshotId = UUID().uuidString.lowercased()
        let tree = snapshot(
            AXUIElementCreateApplication(app.processIdentifier),
            "0",
            0,
            maxDepth,
            maxNodes,
            &count,
            &elements
        )
        pruneSnapshotCache()
        snapshotCache[snapshotId] = SnapshotEntry(
            bundleId: bundleId,
            processId: app.processIdentifier,
            createdAt: Date(),
            elements: elements
        )
        return [
            "bundleId": bundleId,
            "processId": app.processIdentifier,
            "snapshotId": snapshotId,
            "snapshotExpiresInSeconds": Int(snapshotMaxAgeSeconds),
            "nodeCount": count,
            "tree": tree,
        ]
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
    case "desktop_screenshot_window":
        try requireScreenCapture()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        let windowId = try requiredInt(arguments, "windowId", 1, Int(Int32.max))
        return try screenshotWindow(
            app,
            bundleId,
            CGWindowID(windowId),
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
        let button = optionalString(arguments, "button") ?? "left"
        let clickCount = boundedInt(arguments["clickCount"], 1, 1, 2)
        try postMouseClick(point, button, clickCount)
        return [
            "clicked": true,
            "button": button,
            "clickCount": clickCount,
            "bundleId": bundleId,
            "processId": app.processIdentifier,
        ]
    case "desktop_click_element":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        let (snapshotId, elementId, element) = try cachedElement(arguments, app, bundleId)
        var actions: CFArray?
        let actionStatus = AXUIElementCopyActionNames(element, &actions)
        let actionNames = actionStatus == .success ? (actions as? [String] ?? []) : []
        if actionNames.contains(kAXPressAction as String) {
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
                throw HelperError(message: "The accessibility element rejected AXPress.")
            }
            return [
                "clicked": true, "verified": true, "method": "AXPress",
                "snapshotId": snapshotId, "elementId": elementId,
                "bundleId": bundleId, "processId": app.processIdentifier,
            ]
        }
        guard let position = pointAttribute(element, kAXPositionAttribute as CFString),
              let size = sizeAttribute(element, kAXSizeAttribute as CFString) else {
            throw HelperError(message: "The accessibility element has no actionable position.")
        }
        let point = CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
        try requirePointInApplicationWindow(app, point)
        try postMouseClick(point, "left", 1)
        return [
            "clicked": true, "verified": false, "method": "coordinate-fallback",
            "snapshotId": snapshotId, "elementId": elementId,
            "bundleId": bundleId, "processId": app.processIdentifier,
        ]
    case "desktop_focus_element":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        let (snapshotId, elementId, element) = try cachedElement(arguments, app, bundleId)
        guard AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        ) == .success else {
            throw HelperError(message: "The accessibility element could not be focused.")
        }
        try requireFocusedElementOwnedByProcess(app.processIdentifier)
        return [
            "focused": true, "verified": true,
            "snapshotId": snapshotId, "elementId": elementId,
            "bundleId": bundleId, "processId": app.processIdentifier,
        ]
    case "desktop_scroll":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        let point = CGPoint(x: try requiredNumber(arguments, "x"), y: try requiredNumber(arguments, "y"))
        try requirePointInApplicationWindow(app, point)
        let deltaX = try boundedNumber(arguments["deltaX"] ?? 0, "deltaX", -2_000, 2_000)
        let deltaY = try boundedNumber(arguments["deltaY"], "deltaY", -2_000, 2_000)
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(deltaY.rounded()),
            wheel2: Int32(deltaX.rounded()),
            wheel3: 0
        ) else { throw HelperError(message: "Could not create scroll event.") }
        event.post(tap: .cghidEventTap)
        return [
            "scrolled": true, "deltaX": deltaX, "deltaY": deltaY,
            "bundleId": bundleId, "processId": app.processIdentifier,
        ]
    case "desktop_drag":
        try requireAccessibility()
        try requireUserIdle()
        let bundleId = try requiredString(arguments, "bundleId")
        let app = try runningApplication(bundleId, expectedProcessId(arguments))
        try requireFrontmost(app)
        let start = CGPoint(x: try requiredNumber(arguments, "fromX"), y: try requiredNumber(arguments, "fromY"))
        let end = CGPoint(x: try requiredNumber(arguments, "toX"), y: try requiredNumber(arguments, "toY"))
        try requirePointInApplicationWindow(app, start)
        try requirePointInApplicationWindow(app, end)
        let durationMs = boundedInt(arguments["durationMs"], 300, 50, 5_000)
        try postDrag(start, end, durationMs)
        return [
            "dragged": true, "durationMs": durationMs,
            "bundleId": bundleId, "processId": app.processIdentifier,
        ]
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
    var applications = Dictionary(uniqueKeysWithValues: NSWorkspace.shared.runningApplications
        .compactMap { cached -> (pid_t, NSRunningApplication)? in
            guard let app = NSRunningApplication(processIdentifier: cached.processIdentifier),
                  app.activationPolicy == .regular,
                  !app.isTerminated else { return nil }
            return (app.processIdentifier, app)
        })

    // A long-lived LSUIElement host does not necessarily pump AppKit's main run loop, so
    // NSWorkspace's runningApplications snapshot can lag behind applications launched after
    // the helper. Merge the owners of currently visible layer-zero windows. This keeps the
    // API constrained to real GUI applications instead of exposing every background process.
    if let entries = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] {
        for entry in entries {
            guard let owner = entry[kCGWindowOwnerPID as String] as? NSNumber,
                  let layer = entry[kCGWindowLayer as String] as? NSNumber,
                  layer.intValue == 0 else { continue }
            let processId = owner.int32Value
            guard applications[processId] == nil,
                  let app = NSRunningApplication(processIdentifier: processId),
                  app.activationPolicy == .regular,
                  !app.isTerminated else { continue }
            applications[processId] = app
        }
    }

    return applications.values.compactMap { app in
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

func windowList(_ processId: pid_t) -> [[String: Any]] {
    guard let entries = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else { return [] }
    return entries.compactMap { entry in
        guard let owner = entry[kCGWindowOwnerPID as String] as? NSNumber,
              owner.int32Value == processId,
              let windowNumber = entry[kCGWindowNumber as String] as? NSNumber,
              let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              frame.width > 1,
              frame.height > 1 else { return nil }
        let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        guard layer == 0 else { return nil }
        var result: [String: Any] = [
            "windowId": windowNumber.intValue,
            "frame": rectDictionary(frame),
            "layer": layer,
        ]
        if let name = entry[kCGWindowName as String] as? String, !name.isEmpty {
            result["title"] = String(name.prefix(1_000))
        }
        return result
    }.sorted {
        (($0["windowId"] as? Int) ?? 0) < (($1["windowId"] as? Int) ?? 0)
    }
}

func pressKey(_ arguments: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    try requireUserIdle()
    let bundleId = try requiredString(arguments, "bundleId")
    let app = try runningApplication(bundleId, expectedProcessId(arguments))
    try requireFrontmost(app)
    try requireFocusedElementOwnedByProcess(app.processIdentifier)
    let key = try requiredString(arguments, "key")
    guard let code = keyCode(key) else { throw HelperError(message: "Key is not allowlisted.") }
    let modifiers = try optionalStringArray(arguments, "modifiers")
    let flags = try modifierFlags(modifiers)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw HelperError(message: "Could not create keyboard events.") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return [
        "pressed": key, "modifiers": modifiers,
        "bundleId": bundleId, "processId": app.processIdentifier,
    ]
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
    return try screenshotWindow(app, bundleId, selected, maxWidth, maxHeight)
}

func screenshotWindow(
    _ app: NSRunningApplication,
    _ bundleId: String,
    _ windowId: CGWindowID,
    _ maxWidth: Int,
    _ maxHeight: Int
) throws -> [String: Any] {
    let shareable = try shareableContent()
    guard let selected = shareable.windows.first(where: {
        $0.windowID == windowId
            && $0.owningApplication?.processID == app.processIdentifier
            && $0.windowLayer == 0
            && $0.isOnScreen
            && $0.frame.width > 1
            && $0.frame.height > 1
    }) else {
        throw HelperError(message: "The selected window is not a visible window of the leased application.")
    }
    return try screenshotWindow(app, bundleId, selected, maxWidth, maxHeight)
}

func screenshotWindow(
    _ app: NSRunningApplication,
    _ bundleId: String,
    _ selected: SCWindow,
    _ maxWidth: Int,
    _ maxHeight: Int
) throws -> [String: Any] {
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
        "sourceFrame": rectDictionary(selected.frame),
        "scale": scale,
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
    guard app.isActive else {
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

func cachedElement(
    _ arguments: [String: Any],
    _ app: NSRunningApplication,
    _ bundleId: String
) throws -> (String, String, AXUIElement) {
    pruneSnapshotCache()
    let snapshotId = try requiredString(arguments, "snapshotId")
    let elementId = try requiredString(arguments, "elementId")
    guard let snapshot = snapshotCache[snapshotId] else {
        throw HelperError(message: "The accessibility snapshot expired or is unknown; take a new snapshot.")
    }
    guard snapshot.bundleId == bundleId, snapshot.processId == app.processIdentifier else {
        throw HelperError(message: "The accessibility snapshot does not belong to the leased application process.")
    }
    guard Date().timeIntervalSince(snapshot.createdAt) <= snapshotMaxAgeSeconds else {
        snapshotCache.removeValue(forKey: snapshotId)
        throw HelperError(message: "The accessibility snapshot expired; take a new snapshot.")
    }
    guard let element = snapshot.elements[elementId] else {
        throw HelperError(message: "The accessibility element is not part of this snapshot.")
    }
    var elementProcessId: pid_t = 0
    guard AXUIElementGetPid(element, &elementProcessId) == .success,
          elementProcessId == app.processIdentifier else {
        throw HelperError(message: "The accessibility element is stale; take a new snapshot.")
    }
    return (snapshotId, elementId, element)
}

func pruneSnapshotCache() {
    let now = Date()
    snapshotCache = snapshotCache.filter {
        now.timeIntervalSince($0.value.createdAt) <= snapshotMaxAgeSeconds
    }
    if snapshotCache.count >= snapshotCacheLimit {
        let excess = snapshotCache.count - snapshotCacheLimit + 1
        let oldest = snapshotCache.sorted { $0.value.createdAt < $1.value.createdAt }.prefix(excess)
        for entry in oldest { snapshotCache.removeValue(forKey: entry.key) }
    }
}

func postMouseClick(_ point: CGPoint, _ buttonName: String, _ clickCount: Int) throws {
    let button: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    switch buttonName.lowercased() {
    case "left":
        button = .left
        downType = .leftMouseDown
        upType = .leftMouseUp
    case "right":
        button = .right
        downType = .rightMouseDown
        upType = .rightMouseUp
    default:
        throw HelperError(message: "button must be left or right.")
    }
    for index in 1...clickCount {
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: point,
            mouseButton: button
        ), let up = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: point,
            mouseButton: button
        ) else { throw HelperError(message: "Could not create mouse events.") }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        if clickCount > 1 && index < clickCount { Thread.sleep(forTimeInterval: 0.08) }
    }
}

func postDrag(_ start: CGPoint, _ end: CGPoint, _ durationMs: Int) throws {
    guard let down = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: start,
        mouseButton: .left
    ) else { throw HelperError(message: "Could not create drag start event.") }
    let steps = max(2, min(30, durationMs / 25))
    let stepDelay = Double(durationMs) / Double(steps) / 1_000.0
    var dragEvents: [CGEvent] = []
    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress
        )
        guard let drag = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDragged,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { throw HelperError(message: "Could not create drag event.") }
        dragEvents.append(drag)
    }
    guard let up = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: end,
        mouseButton: .left
    ) else { throw HelperError(message: "Could not create drag end event.") }
    down.post(tap: .cghidEventTap)
    for drag in dragEvents {
        drag.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: stepDelay)
    }
    up.post(tap: .cghidEventTap)
}

func keyCode(_ key: String) -> CGKeyCode? {
    let common: [String: CGKeyCode] = [
        "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Escape": 53,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
        "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
        "Y": 16, "T": 17, "O": 31, "U": 32, "I": 34, "P": 35, "L": 37,
        "J": 38, "K": 40, "N": 45, "M": 46,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "9": 25, "7": 26, "8": 28, "0": 29,
    ]
    return common[key.count == 1 ? key.uppercased() : key]
}

func modifierFlags(_ modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "command", "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option", "alt": flags.insert(.maskAlternate)
        case "control", "ctrl": flags.insert(.maskControl)
        default: throw HelperError(message: "Unsupported modifier: \(modifier).")
        }
    }
    return flags
}

func snapshot(
    _ element: AXUIElement,
    _ elementId: String,
    _ depth: Int,
    _ maxDepth: Int,
    _ maxNodes: Int,
    _ count: inout Int,
    _ elements: inout [String: AXUIElement]
) -> [String: Any] {
    if count >= maxNodes { return ["truncated": true] }
    count += 1
    elements[elementId] = element
    let role = attributeString(element, kAXRoleAttribute as CFString) ?? "unknown"
    let subrole = attributeString(element, kAXSubroleAttribute as CFString)
    var node: [String: Any] = ["role": role, "elementId": elementId]
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
        node["children"] = children.prefix(maxNodes - count).enumerated().map { index, child in
            snapshot(child, "\(elementId).\(index)", depth + 1, maxDepth, maxNodes, &count, &elements)
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

func optionalString(_ arguments: [String: Any], _ name: String) -> String? {
    guard let value = arguments[name] else { return nil }
    return value as? String
}

func optionalStringArray(_ arguments: [String: Any], _ name: String) throws -> [String] {
    guard let value = arguments[name] else { return [] }
    guard let items = value as? [String], items.count <= 4 else {
        throw HelperError(message: "\(name) must be an array of at most four strings.")
    }
    return items
}

func requiredInt(
    _ arguments: [String: Any],
    _ name: String,
    _ minimum: Int,
    _ maximum: Int
) throws -> Int {
    guard let value = arguments[name] as? NSNumber else {
        throw HelperError(message: "\(name) must be an integer.")
    }
    let number = value.intValue
    guard value.doubleValue == Double(number), number >= minimum, number <= maximum else {
        throw HelperError(message: "\(name) must be an integer from \(minimum) to \(maximum).")
    }
    return number
}

func boundedNumber(_ value: Any?, _ name: String, _ minimum: Double, _ maximum: Double) throws -> Double {
    guard let number = value as? NSNumber else {
        throw HelperError(message: "\(name) must be a number.")
    }
    let result = number.doubleValue
    guard result.isFinite, result >= minimum, result <= maximum else {
        throw HelperError(message: "\(name) must be from \(minimum) to \(maximum).")
    }
    return result
}

func rectDictionary(_ rect: CGRect) -> [String: Double] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
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

func emitPermissionResult(_ value: [String: Any]) {
    let output = jsonString(value) + "\n"
    guard let index = CommandLine.arguments.firstIndex(of: "--permission-output"),
          CommandLine.arguments.indices.contains(index + 1)
    else {
        print(output, terminator: "")
        return
    }
    do {
        try Data(output.utf8).write(
            to: URL(fileURLWithPath: CommandLine.arguments[index + 1]),
            options: .atomic
        )
    } catch {
        FileHandle.standardError.write(Data("Could not write permission result.\n".utf8))
        exit(1)
    }
}
