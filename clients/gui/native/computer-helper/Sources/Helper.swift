import AppKit
import ApplicationServices

enum NativeAction {
    case axAction(AXUIElement, String, Int)
    case attribute(AXUIElement, String, CFTypeRef)
    case click(CGPoint, CGMouseButton, Int, [(CGKeyCode, CGEventFlags)])
    case drag(CGPoint, CGPoint, [(CGKeyCode, CGEventFlags)])
    case scroll(CGPoint, Int32, Int32)
    case type(String, CGPoint?)
    case key(KeyChord, Int, Double)
    case paste(String, String)
    var usesEvents: Bool { switch self { case .axAction, .attribute: return false; default: return true } }
}

final class PreparedPlan {
    let owner: Owner
    let command: Command
    let app: AppTarget?
    let window: WindowTarget?
    let epoch: UInt64
    let publicPlan: Object
    let observations: [Observation]
    let bindings: [(AXUIElement, String)]
    let action: NativeAction?
    let focusedElement: AXUIElement?
    init(owner: Owner, command: Command, app: AppTarget?, window: WindowTarget?, epoch: UInt64,
         helperGeneration: String, observations: [Observation], bindings: [(AXUIElement, String)], action: NativeAction?, focusedElement: AXUIElement? = nil) throws {
        self.owner = owner; self.command = command; self.app = app; self.window = window; self.epoch = epoch
        self.observations = observations; self.bindings = bindings; self.action = action
        self.focusedElement = focusedElement
        let target: Object = ["app": app?.json as Any? ?? NSNull(), "window": window?.json as Any? ?? NSNull()]
        let origin = app.map { "computer://\($0.bundle ?? "pid")/\($0.pid)\(window.map { "/\($0.id)" } ?? "")" } ?? "computer://desktop"
        var plan = owner.data
        plan.merge(["preparedActionId": UUID().uuidString, "operation": command.operation.rawValue,
                    "origin": origin, "target": target, "parameters": command.parameters,
                    "expiresAt": nowMillis() + 45_000, "helperGeneration": helperGeneration,
                    "controlEpoch": epoch], uniquingKeysWith: { _, new in new })
        plan["fingerprint"] = try digest(plan)
        publicPlan = plan
    }
}

final class ComputerHelper {
    let control: InputControl
    let generation = UUID().uuidString
    private let windows = WindowRegistry()
    private var observations: [String: Observation] = [:]
    private var plans: [String: PreparedPlan] = [:]
    private let planLock = NSLock()
    var emit: ((Object) -> Void)?
    init(control: InputControl = InputControl()) {
        self.control = control
        control.activity = { [weak self] status in self?.emit?(["event": "activity", "status": status]) }
        control.startMonitor()
    }
    func status() -> Object {
        let accessibility = AXIsProcessTrusted()
        let capture = CGPreflightScreenCaptureAccess()
        let listen = CGPreflightListenEventAccess()
        var value: Object = ["available": true, "platform": "darwin", "minimumOS": "14.0", "helperGeneration": generation,
                             "grantOwner": "com.areal.harness.computer-helper", "owner": ["display_name": "AReaL Computer Helper", "bundle_id": Bundle.main.bundleIdentifier ?? "com.areal.harness.computer-helper", "path": Bundle.main.bundlePath],
                             "accessibility": accessibility ? "granted" : "denied", "screenRecording": capture ? "granted" : "denied",
                             "inputMonitoring": listen ? "granted" : "denied", "ready": accessibility && capture && listen && control.monitored]
        value.merge(control.status, uniquingKeysWith: { _, new in new })
        return value
    }
    func requestAccess(_ capability: String) throws -> Object {
        switch capability {
        case "accessibility": onMain { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
        case "screenRecording": onMain { _ = CGRequestScreenCaptureAccess() }
        case "inputMonitoring": onMain { _ = CGRequestListenEventAccess() }
        default: throw ControlError("invalid_request", "Unknown permission capability")
        }
        return status()
    }
    func prepare(_ request: Object, epoch: UInt64) throws -> Object {
        try control.check(epoch)
        control.startMonitor()
        try control.check(epoch)
        let owner = try Owner(request)
        guard let arguments = request["arguments"] as? Object else { throw ControlError("invalid_request", "Missing arguments") }
        let command = try Command(arguments)
        if command.operation.mutates && !control.monitored { throw ControlError("takeover_unavailable", "All native mutations require a working physical input monitor") }
        planLock.lock()
        plans = plans.filter { ($0.value.publicPlan["expiresAt"] as? Double ?? 0) > nowMillis() && $0.value.epoch == epoch }
        let planCount = plans.count
        planLock.unlock()
        observations = observations.filter { $0.value.expires > nowMillis() && $0.value.epoch == epoch }
        guard planCount < 64 else { throw ControlError("controller_busy", "Too many pending approvals") }
        var refs: [Observation] = []
        var bindings: [(AXUIElement, String)] = []
        var focusedElement: AXUIElement?
        var app: AppTarget?
        var window: WindowTarget?
        if command.operation == .getState || command.operation == .listWindows || command.operation.mutates {
            guard AXIsProcessTrusted() else { throw ControlError("permission_denied", "Grant Accessibility to AReaL Computer Helper in Settings") }
        }
        if let ref = command.parameters["app_ref"] { app = try windows.resolveApp(ref) }
        func observed(_ target: TargetSpec) throws -> Observation {
            let candidate: Observation?
            switch target {
            case .element: candidate = (command.parameters["state_id"] as? String).flatMap { observations[$0] }
            case .coordinate(_, _, let frame): candidate = observations.values.first { $0.frame?.id == frame }
            }
            guard let observation = candidate, observation.ownerScope == owner.scope, observation.epoch == epoch,
                  observation.expires > nowMillis() else { throw ControlError("element_unavailable", "Unknown, expired, or foreign state/frame; observe this app again") }
            try observation.window.validate()
            if let app, app.pid != observation.window.app.pid { throw ControlError("invalid_request", "app_ref does not match the observed app") }
            if let window, !CFEqual(window.element, observation.window.element) { throw ControlError("invalid_request", "Targets must belong to the same observed window") }
            if let pin = (command.parameters["app_ref"] as? Object).flatMap({ integer($0["window_id"]) }), pin != observation.window.id { throw ControlError("invalid_request", "app_ref window_id does not match the observation") }
            app = observation.window.app; window = observation.window
            if !refs.contains(where: { $0.id == observation.id }) { refs.append(observation) }
            return observation
        }
        var resolved: [(AXUIElement?, CGPoint)] = []
        for target in command.targets {
            let observation = try observed(target)
            switch target {
            case .element(let index):
                guard index < observation.elements.count else { throw ControlError("element_unavailable", "Element index is outside the observation") }
                let binding = observation.elements[index]
                guard try elementSignature(binding.element) == binding.signature else { throw ControlError("element_unavailable", "The observed element changed; observe it again") }
                bindings.append((binding.element, binding.signature))
                let bounds = axBounds(binding.element)
                resolved.append((binding.element, bounds.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: CGFloat.nan, y: CGFloat.nan)))
            case .coordinate(let x, let y, _):
                guard let frame = observation.frame else { throw ControlError("element_unavailable", "Screenshot frame is missing") }
                try frame.validate(observation.window)
                resolved.append((nil, try frame.point(x: x, y: y)))
            }
        }
        if window == nil, let app, command.operation != .listWindows { window = try windows.resolveWindow(app, ref: command.parameters["app_ref"]) }
        var action: NativeAction?
        if command.operation.mutates {
            guard let app, let window else { throw ControlError("invalid_request", "Action requires an observed target or app_ref") }
            try window.validate()
            let p = command.parameters
            let strategy = command.strategy
            let modifiers = try KeyChord.parseModifiers(p["modifiers"] as? String ?? "")
            func element() throws -> AXUIElement {
                guard let element = resolved.first?.0 else { throw ControlError("invalid_request", "This operation requires an AX element target") }
                return element
            }
            func point(_ index: Int = 0) throws -> CGPoint {
                let value = resolved[index].1
                guard value.x.isFinite, value.y.isFinite, window.bounds.contains(value) else { throw ControlError("element_unavailable", "Element has no actionable point inside the observed window") }
                return value
            }
            func focused() throws -> AXUIElement {
                guard let focus = axElement(ax(app.element, kAXFocusedUIElementAttribute)) else { throw ControlError("element_unavailable", "No focused control is available") }
                if let target = resolved.first?.0, !CFEqual(target, focus) { throw ControlError("element_unavailable", "The requested typing target is not focused") }
                bindings.append((focus, try elementSignature(focus)))
                focusedElement = focus
                return focus
            }
            switch command.operation {
            case .click:
                let mouse = p["mouse_button"] as? String ?? "left"
                let count = integer(p["click_count"]) ?? 1
                if strategy != "event", let target = resolved.first?.0, mouse == "left", count == 1, modifiers.isEmpty, axActions(target).contains(kAXPressAction) { action = .axAction(target, kAXPressAction, 1) }
                else {
                    if strategy == "a11y" { throw ControlError("action_unavailable", "AXPress cannot represent this click") }
                    action = .click(try point(), mouse == "right" ? .right : mouse == "middle" ? .center : .left, count, modifiers)
                }
            case .drag:
                if strategy == "a11y" { throw ControlError("action_unavailable", "Drag requires event strategy") }
                action = .drag(try point(), try point(1), modifiers)
            case .scroll:
                let amount = max(0, min(100, number(p["scroll_amount"])!))
                let direction = p["scroll_direction"] as! String
                let name = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage", "left": "AXScrollLeftByPage", "right": "AXScrollRightByPage"][direction]!
                if strategy != "event", let target = resolved.first?.0, amount.rounded() == amount, axActions(target).contains(name) { action = .axAction(target, name, Int(amount)) }
                else {
                    if strategy == "a11y" { throw ControlError("action_unavailable", "The target does not advertise this AX scroll action") }
                    let horizontal = direction == "left" || direction == "right"
                    let size = horizontal ? window.bounds.width : window.bounds.height
                    let pixels = Int32((amount * size).rounded()) * (direction == "down" || direction == "right" ? -1 : 1)
                    action = .scroll(try point(), horizontal ? pixels : 0, horizontal ? 0 : pixels)
                }
            case .setValue:
                if strategy == "event" { throw ControlError("action_unavailable", "set_value supports AX value assignment only") }
                let target = try element()
                guard settable(target, kAXValueAttribute) else { throw ControlError("not_settable", "AXValue is not settable") }
                action = .attribute(target, kAXValueAttribute, p["value"] as! CFString)
            case .selectText:
                let target = try element()
                guard settable(target, kAXSelectedTextRangeAttribute), let value = axString(target, kAXValueAttribute) else { throw ControlError("not_selectable", "The target has no selectable text") }
                let range = p["text_range"] as? [Any]
                var selection = CFRange(location: range.map { integer($0[0])! } ?? 0, length: range.map { integer($0[1])! } ?? value.utf16.count)
                guard selection.location <= value.utf16.count, selection.length <= value.utf16.count - selection.location else { throw ControlError("invalid_request", "UTF-16 range is outside the current text") }
                action = .attribute(target, kAXSelectedTextRangeAttribute, AXValueCreate(.cfRange, &selection)!)
            case .type:
                let text = p["text"] as! String
                if !resolved.isEmpty && resolved.first?.0 == nil {
                    if strategy == "a11y" { throw ControlError("action_unavailable", "Coordinate typing requires event strategy") }
                    action = .type(text, try point())
                    break
                }
                let target: AXUIElement
                if let selected = resolved.first?.0 { target = selected }
                else { target = try focused() }
                if strategy != "event", settable(target, kAXSelectedTextAttribute) { action = .attribute(target, kAXSelectedTextAttribute, text as CFString) }
                else if strategy != "event", settable(target, kAXValueAttribute), let value = axString(target, kAXValueAttribute), let range = axRange(target),
                        range.location >= 0, range.length >= 0, range.location <= value.utf16.count, range.length <= value.utf16.count - range.location {
                    let replaced = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
                    action = .attribute(target, kAXValueAttribute, replaced as CFString)
                } else {
                    if strategy == "a11y" { throw ControlError("not_settable", "Focused text cannot be inserted through AX") }
                    if resolved.isEmpty { _ = try focused(); action = .type(text, nil) }
                    else { action = .type(text, try point()) }
                }
            case .key:
                if strategy == "a11y" { throw ControlError("action_unavailable", "Keyboard chords require event strategy") }
                _ = try focused(); action = .key(try KeyChord(p["text"] as! String), integer(p["repeat"]) ?? 1, number(p["hold_seconds"]) ?? 0)
            case .paste:
                _ = try focused(); action = .paste(p["text"] as! String, p["format"] as? String ?? "text")
            case .performAction:
                let target = try element(); let name = p["action"] as! String
                guard axActions(target).contains(name) else { throw ControlError("action_unavailable", "The observed element does not advertise this AX action") }
                action = .axAction(target, name, 1)
            default: break
            }
            if action?.usesEvents == true {
                guard CGPreflightPostEventAccess() else { throw ControlError("permission_denied", "Accessibility event posting is unavailable") }
                try window.requireForegroundOrHost(control.trustedHostPID)
            }
        }
        try control.check(epoch)
        let plan = try PreparedPlan(owner: owner, command: command, app: app, window: window, epoch: epoch,
                                    helperGeneration: generation, observations: refs, bindings: bindings, action: action, focusedElement: focusedElement)
        if command.operation.mutates { try control.reserve(owner, epoch: epoch) }
        planLock.lock(); plans[plan.publicPlan["preparedActionId"] as! String] = plan; planLock.unlock()
        return plan.publicPlan
    }
    private func consumePlan(_ request: Object, epoch: UInt64) throws -> PreparedPlan {
        try control.check(epoch)
        let owner = try Owner(request)
        planLock.lock(); defer { planLock.unlock() }
        guard let supplied = (request["computerApproval"] as? Object)?["plan"] as? Object,
              let id = supplied["preparedActionId"] as? String, let plan = plans[id] else { throw ControlError("not_authorized", "A retained single-use approval plan is required") }
        guard plan.owner.identity == owner.identity, try canonical(supplied) == canonical(plan.publicPlan),
              let arguments = request["arguments"] as? Object,
              try canonical(arguments) == canonical(["operation": plan.command.operation.rawValue, "parameters": plan.command.parameters]) else { throw ControlError("not_authorized", "Approval identity or arguments changed") }
        plans.removeValue(forKey: id)
        guard plan.publicPlan["expiresAt"] as! Double > nowMillis(), plan.epoch == epoch else {
            releaseUnusedReservation(plan)
            throw ControlError("not_authorized", "The approval plan expired or was revoked")
        }
        return plan
    }
    private func releaseUnusedReservation(_ plan: PreparedPlan) {
        if plan.command.operation.mutates && plan.epoch == control.epoch
            && !plans.values.contains(where: { $0.command.operation.mutates && $0.owner.lease == plan.owner.lease && $0.epoch == plan.epoch && ($0.publicPlan["expiresAt"] as? Double ?? 0) > nowMillis() }) {
            control.releaseReservation(plan.owner)
        }
    }
    func discard(_ request: Object) throws -> Object {
        let owner = try Owner(request)
        planLock.lock(); defer { planLock.unlock() }
        guard let supplied = (request["computerApproval"] as? Object)?["plan"] as? Object,
              let id = supplied["preparedActionId"] as? String else { throw ControlError("not_authorized", "A retained single-use approval plan is required") }
        guard let plan = plans[id] else { return ["discarded": false, "preparedActionId": id, "action_sent": false, "dispatch_status": "not_sent"] }
        guard plan.owner.identity == owner.identity, try canonical(supplied) == canonical(plan.publicPlan),
              let arguments = request["arguments"] as? Object,
              try canonical(arguments) == canonical(["operation": plan.command.operation.rawValue, "parameters": plan.command.parameters]) else { throw ControlError("not_authorized", "Approval identity or arguments changed") }
        plans.removeValue(forKey: id)
        releaseUnusedReservation(plan)
        return ["discarded": true, "preparedActionId": id, "action_sent": false, "dispatch_status": "not_sent"]
    }
    func executeStop(_ request: Object, epoch: UInt64) -> Object {
        do {
            let plan = try consumePlan(request, epoch: epoch)
            guard plan.command.operation == .stop else { throw ControlError("invalid_request", "The control lane only accepts Stop") }
            control.stop(plan.command.parameters["reason"] as? String ?? "Model requested Stop")
            return envelope(["stopped": true])
        } catch { return failure(error) }
    }
    func prepareStop(_ request: Object, epoch: UInt64) throws -> Object {
        try control.check(epoch)
        let owner = try Owner(request)
        guard let arguments = request["arguments"] as? Object else { throw ControlError("invalid_request", "Missing arguments") }
        let command = try Command(arguments)
        guard command.operation == .stop else { throw ControlError("invalid_request", "The control lane only accepts Stop") }
        let plan = try PreparedPlan(owner: owner, command: command, app: nil, window: nil, epoch: epoch, helperGeneration: generation, observations: [], bindings: [], action: nil)
        planLock.lock(); defer { planLock.unlock() }
        plans = plans.filter { ($0.value.publicPlan["expiresAt"] as? Double ?? 0) > nowMillis() && $0.value.epoch == epoch }
        guard plans.count < 64 else { throw ControlError("controller_busy", "Too many pending approvals") }
        plans[plan.publicPlan["preparedActionId"] as! String] = plan
        return plan.publicPlan
    }
    func execute(_ request: Object, epoch: UInt64) -> Object {
        var run: ActionRun?
        var consumedOwner: Owner?
        defer { if let run { control.finish(run) } else if let consumedOwner { control.releaseReservation(consumedOwner) } }
        do {
            let plan = try consumePlan(request, epoch: epoch)
            let owner = plan.owner
            consumedOwner = owner
            let id = plan.publicPlan["preparedActionId"] as! String
            try plan.app?.validate(); try plan.window?.validate()
            for observation in plan.observations {
                guard observations[observation.id] === observation, observation.expires > nowMillis() else { throw ControlError("element_unavailable", "The observation was superseded or expired") }
                try observation.frame?.validate(observation.window)
            }
            for (element, signature) in plan.bindings { guard try elementSignature(element) == signature else { throw ControlError("element_unavailable", "The prepared AX target changed; observe again") } }
            let command = plan.command
            switch command.operation {
            case .describe:
                return envelope(["platform": "darwin", "minimumOS": "14.0", "methods": Operation.allCases.map(\.rawValue),
                                 "requires": "Use state_id for AX indices and frame_id for raster coordinates. Observe again after mutations. All mutations require a working Input Monitoring tap. Event input requires the target window foreground or an approved handoff from the trusted host to the retained window. request_access is passive; grants are requested in Settings.",
                                 "limits": ["planLifetimeMs": 45_000, "observationLifetimeMs": 90_000, "maximumElements": 750, "maximumRasterDimension": 4096, "maximumKeyHoldSeconds": 10, "maximumRepeatedHoldSeconds": 20]])
            case .requestAccess:
                var value = status(); value["message"] = "Use AReaL Settings to grant access. Model calls never prompt."
                return envelope(value)
            case .stop:
                control.stop(command.parameters["reason"] as? String ?? "Model requested Stop")
                return envelope(["stopped": true])
            case .listApps:
                let apps: [Object] = onMain { NSWorkspace.shared.runningApplications }.filter { !$0.isTerminated && $0.activationPolicy != .prohibited }.map {
                    ["pid": Int($0.processIdentifier), "bundle_id": $0.bundleIdentifier as Any? ?? NSNull(), "name": $0.localizedName as Any? ?? NSNull(), "active": $0.isActive]
                }
                return envelope(apps)
            case .listWindows:
                guard AXIsProcessTrusted() else { throw ControlError("permission_denied", "Accessibility permission was revoked") }
                return envelope(try windows.windows(plan.app!).map(\.json))
            case .getState:
                return try observe(owner, window: plan.window!, epoch: epoch, screenshot: bool(command.parameters["include_screenshot"]) == true)
            default:
                guard AXIsProcessTrusted(), let window = plan.window, let action = plan.action else { throw ControlError("permission_denied", "Accessibility permission is required") }
                let context = ActionRun(id: id, epoch: epoch, owner: owner, window: window, operation: command.operation.rawValue)
                run = context; try control.begin(context)
                if action.usesEvents {
                    try control.handoff(context)
                    for (element, signature) in plan.bindings {
                        guard try elementSignature(element) == signature else { throw ControlError("element_unavailable", "The prepared AX target changed during approval handoff") }
                    }
                    if let focused = plan.focusedElement {
                        guard let current = axElement(ax(window.app.element, kAXFocusedUIElementAttribute)), CFEqual(current, focused) else {
                            throw ControlError("element_unavailable", "The prepared focused control changed during approval handoff")
                        }
                    }
                }
                try dispatch(action, run: context)
                try control.check(epoch)
                let sent = control.wasSent(context)
                var result = envelope(["target": window.app.json], dispatch: sent ? "sent" : "not_sent")
                if command.returnState != "none" {
                    do {
                        result = try observe(owner, window: window, epoch: epoch, screenshot: false)
                        var structured = result["structuredContent"] as! Object
                        structured["action_sent"] = sent; structured["dispatch_status"] = sent ? "sent" : "not_sent"
                        result["structuredContent"] = structured
                    } catch {
                        var structured = result["structuredContent"] as! Object
                        structured["observation_error"] = (error as? ControlError)?.message ?? error.localizedDescription
                        result["structuredContent"] = structured
                    }
                } else { observations = observations.filter { $0.value.ownerScope != owner.scope || $0.value.window.app.pid != window.app.pid } }
                return result
            }
        } catch { return failure(error, dispatched: run.map { control.wasSent($0) } ?? false) }
    }
    private func observe(_ owner: Owner, window: WindowTarget, epoch: UInt64, screenshot: Bool) throws -> Object {
        guard AXIsProcessTrusted() else { throw ControlError("permission_denied", "Accessibility permission is required") }
        try control.check(epoch); try window.validate()
        let check = { try self.control.check(epoch) }
        let frame = screenshot ? try captureWindow(window, check: check) : nil
        let observation = try Observation(owner: owner, epoch: epoch, window: window, frame: frame, check: check)
        try window.validate(); try control.check(epoch)
        observations = observations.filter { $0.value.ownerScope != owner.scope || $0.value.window.app.pid != window.app.pid }
        if observations.count >= 64, let oldest = observations.min(by: { $0.value.expires < $1.value.expires })?.key { observations.removeValue(forKey: oldest) }
        observations[observation.id] = observation
        return observation.result
    }
    private func dispatch(_ action: NativeAction, run: ActionRun) throws {
        switch action {
        case .axAction(let element, let name, let count):
            for _ in 0..<count {
                try run.window.validate()
                let result = try control.perform(run) { AXUIElementPerformAction(element, name as CFString) }
                guard result == .success else { throw ControlError("action_unavailable", "AX action failed with status \(result.rawValue)") }
            }
        case .attribute(let element, let attribute, let value):
            let result = try control.perform(run) { AXUIElementSetAttributeValue(element, attribute as CFString, value) }
            guard result == .success else { throw ControlError("not_settable", "AX assignment failed with status \(result.rawValue)") }
        case .click(let point, let button, let count, let modifiers):
            let flags = try control.modifiers(modifiers, down: true, run: run)
            let down: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
            let up: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
            for click in 1...count {
                try control.mouse(down, point: point, button: button, flags: flags, clickCount: click, run: run)
                try control.wait(0.03, run: run)
                try control.mouse(up, point: point, button: button, flags: flags, clickCount: click, run: run)
                if click < count { try control.wait(0.06, run: run) }
            }
            _ = try control.modifiers(modifiers, down: false, run: run)
        case .drag(let start, let end, let modifiers):
            let flags = try control.modifiers(modifiers, down: true, run: run)
            try control.mouse(.leftMouseDown, point: start, button: .left, flags: flags, run: run)
            for step in 1...30 {
                try control.wait(0.015, run: run)
                let ratio = Double(step) / 30
                try control.mouse(.leftMouseDragged, point: CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio), button: .left, flags: flags, run: run)
            }
            try control.mouse(.leftMouseUp, point: end, button: .left, flags: flags, run: run)
            _ = try control.modifiers(modifiers, down: false, run: run)
        case .scroll(let point, let x, let y):
            if x != 0 || y != 0 { try control.scroll(point: point, x: x, y: y, run: run) }
        case .type(let text, let point):
            if let point { try dispatch(.click(point, .left, 1, []), run: run) }
            for scalar in text.unicodeScalars {
                let units = Array(String(scalar).utf16)
                try control.key(0, down: true, flags: [], run: run, text: units)
                try control.key(0, down: false, flags: [], run: run, text: units)
            }
        case .key(let chord, let count, let hold):
            for _ in 0..<count {
                let flags = try control.modifiers(chord.modifiers, down: true, run: run)
                try control.key(chord.key, down: true, flags: flags, run: run)
                try control.wait(hold, run: run)
                try control.key(chord.key, down: false, flags: flags, run: run)
                _ = try control.modifiers(chord.modifiers, down: false, run: run)
            }
        case .paste(let text, let format):
            try control.checkEvent(run)
            try control.perform(run) {
                try onMain {
                    let board = NSPasteboard.general
                    board.clearContents()
                    let type: NSPasteboard.PasteboardType = format == "html" ? .html : .string
                    guard board.setString(text, forType: type) else { throw ControlError("internal", "Could not write pasteboard data") }
                    if format == "md", !board.setString(text, forType: NSPasteboard.PasteboardType("net.daringfireball.markdown")) { throw ControlError("internal", "Could not write Markdown pasteboard data") }
                }
            }
            try dispatch(.key(try KeyChord("cmd+v"), 1, 0), run: run)
        }
    }
}
