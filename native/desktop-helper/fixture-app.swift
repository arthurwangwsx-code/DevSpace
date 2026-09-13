import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.finishLaunching()

let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 480, height: 240),
    styleMask: [.titled, .closable],
    backing: .buffered,
    defer: false
)
window.title = "DevSpace Desktop Fixture"

let label = NSTextField(labelWithString: "DevSpace Fixture Label")
label.frame = NSRect(x: 40, y: 170, width: 360, height: 24)
let input = NSTextField(string: "fixture-start")
input.frame = NSRect(x: 40, y: 115, width: 360, height: 28)
input.identifier = NSUserInterfaceItemIdentifier("fixture-input")
let secure = NSSecureTextField(string: "DO_NOT_LEAK_SECURE_VALUE")
secure.frame = NSRect(x: 40, y: 65, width: 360, height: 28)
secure.identifier = NSUserInterfaceItemIdentifier("fixture-secure")

window.contentView?.addSubview(label)
window.contentView?.addSubview(input)
window.contentView?.addSubview(secure)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(input)
app.activate(ignoringOtherApps: true)
app.run()
