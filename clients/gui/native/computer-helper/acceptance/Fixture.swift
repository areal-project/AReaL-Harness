import AppKit

final class FixtureView: NSView {
    var events: [[String: Any]] = []
    var changed: (() -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.88, green: 0.93, blue: 0.98, alpha: 1).setFill()
        bounds.fill()
        ("Input pad. Click, drag, scroll, or type here." as NSString).draw(at: NSPoint(x: 14, y: 14), withAttributes: [.foregroundColor: NSColor.black])
    }
    func record(_ name: String, _ event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let keyboard = [.keyDown, .keyUp, .flagsChanged].contains(event.type)
        let scroll = event.type == .scrollWheel
        events.append(["type": name, "x": point.x, "y": point.y, "button": keyboard || scroll ? 0 : event.buttonNumber,
                       "clickCount": keyboard || scroll ? 0 : event.clickCount, "keyCode": keyboard ? event.keyCode : 0,
                       "characters": [.keyDown, .keyUp].contains(event.type) ? event.characters ?? "" : "", "modifiers": event.modifierFlags.rawValue,
                       "deltaX": scroll ? event.scrollingDeltaX : 0, "deltaY": scroll ? event.scrollingDeltaY : 0])
        if events.count > 1000 { events.removeFirst(events.count - 1000) }
        changed?()
    }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(self); record("mouseDown", e) }
    override func mouseUp(with e: NSEvent) { record("mouseUp", e) }
    override func rightMouseDown(with e: NSEvent) { record("rightMouseDown", e) }
    override func rightMouseUp(with e: NSEvent) { record("rightMouseUp", e) }
    override func otherMouseDown(with e: NSEvent) { record("otherMouseDown", e) }
    override func otherMouseUp(with e: NSEvent) { record("otherMouseUp", e) }
    override func mouseDragged(with e: NSEvent) { record("mouseDragged", e) }
    override func scrollWheel(with e: NSEvent) { record("scrollWheel", e) }
    override func keyDown(with e: NSEvent) { record("keyDown", e) }
    override func keyUp(with e: NSEvent) { record("keyUp", e) }
    override func flagsChanged(with e: NSEvent) { record("flagsChanged", e) }
}

final class Fixture: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    let output: URL
    var window: NSWindow!
    let editor = NSTextView(frame: .zero)
    let pad = FixtureView(frame: .zero)
    var presses = 0
    var timer: Timer?
    var activationRequest = ""
    init(output: URL) { self.output = output }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            submenu.addItem(NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key))
        }
        edit.submenu = submenu; menu.addItem(edit); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 640, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "AReaL computer acceptance fixture"
        let content = window.contentView!
        let button = NSButton(title: "Record AX press", target: self, action: #selector(press))
        button.frame = NSRect(x: 24, y: 420, width: 180, height: 32)
        button.setAccessibilityIdentifier("fixture-press")
        content.addSubview(button)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 246, width: 592, height: 152))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        editor.frame = scroll.bounds
        editor.isRichText = true
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.string = "Fixture text: A😀BC\nSecond line"
        editor.setAccessibilityIdentifier("fixture-editor")
        editor.setAccessibilityLabel("Fixture editor")
        editor.delegate = self
        scroll.documentView = editor
        content.addSubview(scroll)
        pad.frame = NSRect(x: 24, y: 24, width: 592, height: 196)
        pad.setAccessibilityElement(true)
        pad.setAccessibilityRole(.group)
        pad.setAccessibilityLabel("Fixture input pad")
        pad.setAccessibilityIdentifier("fixture-pad")
        pad.changed = { [weak self] in self?.save() }
        content.addSubview(pad)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.save() }
        save()
    }
    @objc func press() { presses += 1; save() }
    func applicationDidBecomeActive(_ notification: Notification) {
        if FileManager.default.fileExists(atPath: output.appendingPathExtension("focus-on-activation").path) {
            window?.makeFirstResponder(editor)
        }
    }
    func textDidChange(_ notification: Notification) { save() }
    func save() {
        let trigger = output.appendingPathExtension("activate")
        if let request = try? String(contentsOf: trigger, encoding: .utf8) {
            try? FileManager.default.removeItem(at: trigger)
            activationRequest = request
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        let range = editor.selectedRange()
        let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "presses": presses,
                                  "text": editor.string, "selection": [range.location, range.length],
                                  "events": pad.events, "frontmost": NSApp.isActive,
                                  "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "activationRequest": activationRequest,
                                  "window": [window.frame.minX, window.frame.minY, window.frame.width, window.frame.height],
                                  "pasteboardTypes": NSPasteboard.general.types?.map(\.rawValue) ?? []]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { try? data.write(to: output, options: .atomic) }
    }
}

guard CommandLine.arguments.count == 2 else { fatalError("Usage: AReaLComputerFixture <evidence.json>") }
let app = NSApplication.shared
let fixture = Fixture(output: URL(fileURLWithPath: CommandLine.arguments[1]))
app.setActivationPolicy(.regular)
app.delegate = fixture
app.run()
