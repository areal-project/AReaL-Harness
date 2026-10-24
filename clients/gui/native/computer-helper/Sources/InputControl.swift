import AppKit
import ApplicationServices

final class ActionRun {
    let id: String
    let epoch: UInt64
    let owner: Owner
    let window: WindowTarget
    let operation: String
    var sent = false
    init(id: String, epoch: UInt64, owner: Owner, window: WindowTarget, operation: String) { self.id = id; self.epoch = epoch; self.owner = owner; self.window = window; self.operation = operation }
}

struct KeyChord {
    let key: CGKeyCode
    let modifiers: [(CGKeyCode, CGEventFlags)]
    static let modifierTable: [String: (CGKeyCode, CGEventFlags)] = [
        "cmd": (55, .maskCommand), "command": (55, .maskCommand), "meta": (55, .maskCommand),
        "ctrl": (59, .maskControl), "control": (59, .maskControl),
        "alt": (58, .maskAlternate), "option": (58, .maskAlternate), "shift": (56, .maskShift)]
    static let keyTable: [String: CGKeyCode] = [
        "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
        "q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,
        "=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
        "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"return":36,"enter":36,
        "l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,
        "tab":48,"space":49," ":49,"`":50,"backspace":51,"delete":51,"esc":53,"escape":53,
        "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,
        "f11":103,"f12":111,"f13":105,"f14":107,"f15":113,"f16":106,"f17":64,"f18":79,"f19":80,"f20":90,
        "home":115,"end":119,"pageup":116,"pagedown":121,"forwarddelete":117,
        "left":123,"arrowleft":123,"right":124,"arrowright":124,"down":125,"arrowdown":125,"up":126,"arrowup":126]
    static func parseModifiers(_ value: String) throws -> [(CGKeyCode, CGEventFlags)] {
        if value.isEmpty { return [] }
        var result: [(CGKeyCode, CGEventFlags)] = []
        for item in value.lowercased().split(separator: "+", omittingEmptySubsequences: false) {
            guard let entry = modifierTable[item.trimmingCharacters(in: .whitespaces)], !result.contains(where: { $0.0 == entry.0 }) else { throw ControlError("invalid_request", "Unknown or duplicate modifier") }
            result.append(entry)
        }
        return result
    }
    init(_ text: String) throws {
        var parts = text.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard let name = parts.popLast(), let code = Self.keyTable[name] else { throw ControlError("invalid_request", "Unknown key chord; use type for Unicode text") }
        key = code; modifiers = try Self.parseModifiers(parts.joined(separator: "+"))
    }
}

final class InputControl {
    private let lock = NSRecursiveLock()
    private var generation: UInt64 = 1
    private var lease: String?
    private var leaseDeadline = 0.0
    private var hasAdmittedOwners = false
    private var active: ActionRun?
    private var keys: [CGKeyCode: CGEventFlags] = [:]
    private var buttons: [UInt32: CGPoint] = [:]
    private var tap: CFMachPort?
    private var monitorStarting = false
    private let canListen: () -> Bool
    private let hostPID = getppid()
    private var reason: String?
    let tag = Int64.random(in: 1...Int64.max)
    let source = CGEventSource(stateID: .privateState)
    var activity: ((Object) -> Void)?
    var epoch: UInt64 { lock.lock(); defer { lock.unlock() }; return generation }
    var monitored: Bool { lock.lock(); defer { lock.unlock() }; return tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false }
    var status: Object {
        lock.lock(); defer { lock.unlock() }
        return ["active": active != nil, "activeTarget": active?.window.app.json as Any? ?? NSNull(),
                "app": active?.window.app.json as Any? ?? NSNull(), "operation": active?.operation as Any? ?? NSNull(),
                "controlEpoch": generation, "lastStopReason": reason as Any? ?? NSNull(),
                "heldKeys": keys.count, "heldButtons": buttons.count, "takeoverMonitoring": monitored]
    }
    init(canListen: @escaping () -> Bool = { CGPreflightListenEventAccess() }) {
        self.canListen = canListen
        source?.localEventsSuppressionInterval = 0
        let permitted: CGEventFilterMask = [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents]
        source?.setLocalEventsFilterDuringSuppressionState(permitted, state: .eventSuppressionStateSuppressionInterval)
        source?.setLocalEventsFilterDuringSuppressionState(permitted, state: .eventSuppressionStateRemoteMouseDrag)
    }
    func startMonitor() {
        lock.lock()
        guard tap == nil, !monitorStarting, canListen() else { lock.unlock(); return }
        monitorStarting = true; lock.unlock()
        let ready = DispatchSemaphore(value: 0)
        Thread.detachNewThread { [self] in
            let events: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                         .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
            let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
            let created = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                           eventsOfInterest: mask, callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let control = Unmanaged<InputControl>.fromOpaque(refcon).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { control.stop("Input monitoring stopped") }
                else if event.getIntegerValueField(.eventSourceUserData) != control.tag { control.physicalInput(event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            lock.lock(); tap = created; monitorStarting = false; lock.unlock()
            if let created, let runSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) {
                CFRunLoopAddSource(CFRunLoopGetCurrent(), runSource, .commonModes)
                CGEvent.tapEnable(tap: created, enable: true)
                ready.signal(); CFRunLoopRun()
            } else { ready.signal() }
        }
        _ = ready.wait(timeout: .now() + 1)
    }
    func reserve(_ owner: Owner, epoch: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        try checkLocked(epoch)
        if let lease, lease != owner.lease, leaseDeadline > nowMillis() || active != nil { throw ControlError("controller_busy", "Another project or turn owns computer control") }
        lease = owner.lease; leaseDeadline = nowMillis() + 60_000
    }
    func admit(_ owner: Owner, epoch: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard epoch == generation else { throw ControlError("human_control", "The admitted control generation was revoked; a new user turn is required") }
        if let lease, lease != owner.lease, leaseDeadline > nowMillis() || active != nil { throw ControlError("controller_busy", "Another project or turn owns computer control") }
        hasAdmittedOwners = true
    }
    func begin(_ run: ActionRun) throws {
        lock.lock(); defer { lock.unlock() }
        guard monitored else { throw ControlError("takeover_unavailable", "All native mutations require a working physical input monitor") }
        try reserve(run.owner, epoch: run.epoch)
        guard active == nil else { throw ControlError("controller_busy", "An action is already running") }
        active = run; reason = nil
        activity?(status)
    }
    func finish(_ run: ActionRun) {
        lock.lock(); defer { lock.unlock() }
        if active === run { releaseLocked(); active = nil; lease = nil; leaseDeadline = 0; activity?(status) }
    }
    func releaseReservation(_ owner: Owner) {
        lock.lock(); defer { lock.unlock() }
        if active == nil && lease == owner.lease { lease = nil; leaseDeadline = 0 }
    }
    func wasSent(_ run: ActionRun) -> Bool { lock.lock(); defer { lock.unlock() }; return run.sent }
    func check(_ epoch: UInt64) throws { lock.lock(); defer { lock.unlock() }; try checkLocked(epoch) }
    private func checkLocked(_ epoch: UInt64) throws {
        guard epoch == generation else { throw ControlError("control_stopped", reason ?? "The control generation changed; observe again") }
    }
    func checkEvent(_ run: ActionRun) throws {
        try check(run.epoch)
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ControlError("permission_denied", "Accessibility event posting is unavailable") }
        guard monitored else { throw ControlError("takeover_unavailable", "Grant Input Monitoring and restart the helper before event actions") }
        try run.window.requireForeground()
    }
    var trustedHostPID: pid_t? { hostPID > 1 && getppid() == hostPID ? hostPID : nil }
    func handoff(_ run: ActionRun) throws {
        try run.window.requireForegroundOrHost(trustedHostPID)
        if onMain({ NSWorkspace.shared.frontmostApplication?.processIdentifier }) == run.window.app.pid {
            try run.window.requireForeground()
            return
        }
        try perform(run) {
            try onMain {
                try run.window.requireForegroundOrHost(trustedHostPID)
                try run.window.activateRetainedWindow()
            }
        }
        let deadline = nowMillis() + 1_000
        while true {
            try check(run.epoch)
            try run.window.validate()
            let frontmost = onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
            guard frontmost == run.window.app.pid || (trustedHostPID != nil && frontmost == trustedHostPID) else {
                throw ControlError("foreground_required", "Another application took the foreground during approval handoff")
            }
            if (try? run.window.requireForeground()) != nil { return }
            guard nowMillis() < deadline else { throw ControlError("foreground_required", "The approved window did not become foreground") }
            Thread.sleep(forTimeInterval: 0.01)
        }
    }
    func perform<T>(_ run: ActionRun, _ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        try checkLocked(run.epoch)
        guard active === run else { throw ControlError("control_stopped", "Action lease was revoked") }
        guard monitored else { throw ControlError("takeover_unavailable", "Physical input monitoring is unavailable") }
        run.sent = true
        return try body()
    }
    func wait(_ seconds: Double, run: ActionRun) throws {
        let until = nowMillis() + seconds * 1000
        repeat {
            try checkEvent(run)
            if nowMillis() >= until { return }
            Thread.sleep(forTimeInterval: min(0.01, (until - nowMillis()) / 1000))
        } while true
    }
    private func post(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: tag)
        event.post(tap: .cghidEventTap)
    }
    func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, run: ActionRun, text: [UniChar]? = nil) throws {
        try checkEvent(run)
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw ControlError("internal", "Could not create keyboard event") }
        event.flags = flags
        if let text { event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text) }
        try perform(run) {
            if down { keys[code] = flags } else { keys.removeValue(forKey: code) }
            post(event)
        }
    }
    func modifiers(_ modifiers: [(CGKeyCode, CGEventFlags)], down: Bool, run: ActionRun) throws -> CGEventFlags {
        var flags = modifiers.reduce(CGEventFlags()) { $0.union($1.1) }
        if down {
            flags = []
            for (key, flag) in modifiers { flags.insert(flag); try self.key(key, down: true, flags: flags, run: run) }
        } else {
            for (key, flag) in modifiers.reversed() { flags.remove(flag); try self.key(key, down: false, flags: flags, run: run) }
        }
        return flags
    }
    func mouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, flags: CGEventFlags, clickCount: Int = 1, run: ActionRun) throws {
        try checkEvent(run)
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw ControlError("internal", "Could not create mouse event") }
        event.flags = flags; event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        try perform(run) {
            if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) { buttons[button.rawValue] = point }
            else if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) { buttons.removeValue(forKey: button.rawValue) }
            else if buttons[button.rawValue] != nil { buttons[button.rawValue] = point }
            post(event)
        }
    }
    func scroll(point: CGPoint, x: Int32, y: Int32, run: ActionRun) throws {
        try mouse(.mouseMoved, point: point, button: .left, flags: [], run: run)
        try checkEvent(run)
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0) else { throw ControlError("internal", "Could not create scroll event") }
        try perform(run) { post(event) }
    }
    private func physicalInput(_ event: CGEvent) {
        lock.lock(); defer { lock.unlock() }
        if active == nil, keys.isEmpty, buttons.isEmpty, let host = trustedHostPID,
           event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(host) { return }
        let controlled = hasAdmittedOwners || active != nil || (lease != nil && leaseDeadline > nowMillis())
        if controlled { stop("Physical user input took over computer control") }
    }
    func stop(_ reason: String) {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1; self.reason = reason; lease = nil; leaseDeadline = 0; hasAdmittedOwners = false
        releaseLocked(); active = nil; activity?(status)
    }
    private func releaseLocked() {
        for code in keys.keys.sorted() {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) { event.flags = []; post(event) }
        }
        for (raw, point) in buttons {
            guard let button = CGMouseButton(rawValue: raw) else { continue }
            let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
            if let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) { event.flags = []; post(event) }
        }
        keys.removeAll(); buttons.removeAll()
    }
}
