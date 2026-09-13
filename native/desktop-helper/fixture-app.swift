import AppKit

final class FixtureController: NSObject {
    let label: NSTextField
    private var count = 0

    init(label: NSTextField) {
        self.label = label
    }

    @objc func increment(_ sender: NSButton) {
        count += 1
        sender.title = "Increment \(count)"
        label.stringValue = "Clicked \(count)"
    }
}

// NSControl does not strongly retain its target. Keep the fixture controller
// alive for the lifetime of the process so AXPress exercises the real action
// path instead of a deallocated target.
private var retainedController: FixtureController?

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
let controller = FixtureController(label: label)
retainedController = controller
let input = NSTextField(string: "fixture-start")
input.frame = NSRect(x: 40, y: 115, width: 360, height: 28)
input.identifier = NSUserInterfaceItemIdentifier("fixture-input")
let secure = NSSecureTextField(string: "DO_NOT_LEAK_SECURE_VALUE")
secure.frame = NSRect(x: 40, y: 65, width: 360, height: 28)
secure.identifier = NSUserInterfaceItemIdentifier("fixture-secure")
let button = NSButton(title: "Increment 0", target: controller, action: #selector(FixtureController.increment(_:)))
button.frame = NSRect(x: 40, y: 20, width: 140, height: 32)

window.contentView?.addSubview(label)
window.contentView?.addSubview(input)
window.contentView?.addSubview(secure)
window.contentView?.addSubview(button)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(input)
app.activate(ignoringOtherApps: true)
app.run()
