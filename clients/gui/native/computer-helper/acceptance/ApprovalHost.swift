import AppKit
import ApplicationServices

final class ApprovalHost: NSObject, NSApplicationDelegate {
    let helper = Process()
    let input = Pipe()
    let output = Pipe()
    let outputLock = NSLock()
    var window: NSWindow!
    var button: NSButton!
    var approvals = 0
    func write(_ data: Data) {
        outputLock.lock(); defer { outputLock.unlock() }
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
    func reply(_ id: String, _ value: [String: Any]) {
        if var data = try? JSONSerialization.data(withJSONObject: ["id": id, "ok": true, "result": value]) {
            data.append(0x0a); write(data)
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 850, y: 220, width: 360, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "AReaL approval acceptance host"
        button = NSButton(title: "Allow once", target: self, action: #selector(allow))
        button.frame = NSRect(x: 80, y: 50, width: 200, height: 40)
        window.contentView!.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        helper.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
        helper.standardInput = input; helper.standardOutput = output; helper.standardError = FileHandle.standardError
        helper.terminationHandler = { process in exit(process.terminationStatus) }
        do { try helper.run() } catch { fatalError("Could not launch helper: \(error)") }
        DispatchQueue.global().async { [self] in
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { return }
                write(data)
            }
        }
        DispatchQueue.global().async { [self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = request["id"] as? String, let method = request["method"] as? String else { exit(65) }
                if method.hasPrefix("fixture_") {
                    DispatchQueue.main.async { self.command(id, method, request["params"] as? [String: Any] ?? [:]) }
                } else {
                    try? input.fileHandleForWriting.write(contentsOf: data + Data([0x0a]))
                }
            }
            try? input.fileHandleForWriting.close()
        }
    }
    @objc func allow() { approvals += 1 }
    func command(_ id: String, _ method: String, _ params: [String: Any]) {
        switch method {
        case "fixture_status":
            let frame = window.convertToScreen(button.convert(button.bounds, to: nil))
            let displayHeight = NSScreen.screens[0].frame.maxY
            reply(id, ["pid": getpid(), "helperPID": helper.processIdentifier, "approvals": approvals,
                       "frontmost": NSApp.isActive, "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                       "button": [frame.midX, displayHeight - frame.midY],
                       "postAccess": CGPreflightPostEventAccess()])
        case "fixture_click":
            let point = CGPoint(x: (params["x"] as! NSNumber).doubleValue, y: (params["y"] as! NSNumber).doubleValue)
            let source = CGEventSource(stateID: .privateState)
            source?.localEventsSuppressionInterval = 0
            let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
            down.setIntegerValueField(.eventSourceUserData, value: 0)
            down.post(tap: .cghidEventTap)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) {
                let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!
                up.setIntegerValueField(.eventSourceUserData, value: 0)
                up.post(tap: .cghidEventTap)
                self.reply(id, ["posted": true])
            }
        default: fatalError("Unknown acceptance command")
        }
    }
}

guard CommandLine.arguments.count == 2 else { fatalError("Usage: ApprovalHost <helper-executable>") }
let app = NSApplication.shared
let host = ApprovalHost()
app.setActivationPolicy(.regular)
app.delegate = host
app.run()
