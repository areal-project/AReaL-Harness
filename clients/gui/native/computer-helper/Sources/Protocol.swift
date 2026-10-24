import Foundation
import ApplicationServices
import CryptoKit

typealias Object = [String: Any]

struct ControlError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

func canonical(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
func jsonText(_ value: Any) -> String { String(data: (try? canonical(value)) ?? Data("null".utf8), encoding: .utf8)! }
func digest(_ value: Any) throws -> String { SHA256.hash(data: try canonical(value)).map { String(format: "%02x", $0) }.joined() }
func nowMillis() -> Double { Date().timeIntervalSince1970 * 1000 }
func bool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
    return number.doubleValue
}
func integer(_ value: Any?) -> Int? {
    guard let n = number(value), n.rounded() == n, n >= 0, n <= Double(Int32.max) else { return nil }
    return Int(n)
}
func requireKeys(_ object: Object, _ allowed: Set<String>) throws {
    if let unknown = object.keys.first(where: { !allowed.contains($0) }) { throw ControlError("invalid_request", "Unrecognized field: \(unknown)") }
}
func requiredString(_ object: Object, _ key: String, max: Int = 100_000, empty: Bool = false) throws -> String {
    guard let value = object[key] as? String, value.utf8.count <= max, empty || !value.isEmpty else { throw ControlError("invalid_request", "Invalid \(key)") }
    return value
}

struct Owner {
    let data: Object
    let scope: String
    let lease: String
    let identity: String
    init(_ request: Object) throws {
        var fields = Object()
        for key in ["coreInstanceId", "projectId", "threadId", "turnId", "callId", "coreGeneration", "toolHostGeneration"] {
            fields[key] = try requiredString(request, key, max: 512)
        }
        data = fields
        identity = try digest(fields)
        var session = fields
        session.removeValue(forKey: "turnId"); session.removeValue(forKey: "callId")
        scope = try digest(session)
        session["turnId"] = fields["turnId"]
        lease = try digest(session)
    }
}

enum Operation: String, CaseIterable {
    case describe, listApps = "list_apps", listWindows = "list_windows", getState = "get_app_state"
    case click = "left_click", drag = "left_click_drag", scroll, type, setValue = "set_value"
    case selectText = "select_text", key, paste, performAction = "perform_action"
    case requestAccess = "request_access", stop = "stop_computer_control"
    var mutates: Bool { ![.describe, .listApps, .listWindows, .getState, .requestAccess, .stop].contains(self) }
}

enum TargetSpec {
    case element(Int)
    case coordinate(Int, Int, String)
    init(_ value: Any?) throws {
        guard let object = value as? Object, let type = object["type"] as? String else { throw ControlError("invalid_request", "A target is required") }
        if type == "element", let index = integer(object["index"]) {
            try requireKeys(object, ["type", "index"])
            self = .element(index)
        } else if type == "coordinate", let x = integer(object["x"]), let y = integer(object["y"]) {
            try requireKeys(object, ["type", "x", "y", "frame_id"])
            self = .coordinate(x, y, try requiredString(object, "frame_id", max: 128))
        } else { throw ControlError("invalid_request", "Invalid target") }
    }
}

struct Command {
    let operation: Operation
    let parameters: Object
    let strategy: String
    let returnState: String
    let targets: [TargetSpec]
    init(_ arguments: Object) throws {
        try requireKeys(arguments, ["operation", "parameters"])
        guard let name = arguments["operation"] as? String, let op = Operation(rawValue: name), let p = arguments["parameters"] as? Object else { throw ControlError("invalid_request", "Expected operation and parameters") }
        operation = op; parameters = p
        var keys: Set<String> = []
        switch op {
        case .describe, .listApps: break
        case .listWindows: keys = ["app_ref"]
        case .getState: keys = ["app_ref", "include_screenshot", "disable_diffing", "tree_shown_to_model"]
        case .click: keys = ["target", "mouse_button", "click_count", "modifiers", "strategy"]
        case .drag: keys = ["from_target", "to", "modifiers", "strategy"]
        case .scroll: keys = ["target", "scroll_direction", "scroll_amount", "strategy"]
        case .type: keys = ["text", "target", "strategy"]
        case .setValue: keys = ["target", "value", "strategy"]
        case .selectText: keys = ["target", "text_range"]
        case .key: keys = ["text", "repeat", "hold_seconds", "strategy"]
        case .paste: keys = ["text", "format"]
        case .performAction: keys = ["target", "action"]
        case .requestAccess: keys = ["capabilities"]
        case .stop: keys = ["reason"]
        }
        if op.mutates { keys.formUnion(["app_ref", "state_id", "return_state"]) }
        try requireKeys(p, keys)
        if let ref = p["app_ref"] { try validateAppRef(ref) }
        if [.listWindows, .getState, .key, .paste].contains(op), p["app_ref"] == nil { throw ControlError("invalid_request", "app_ref is required") }
        for field in ["include_screenshot", "disable_diffing", "tree_shown_to_model"] where p[field] != nil {
            guard bool(p[field]) != nil else { throw ControlError("invalid_request", "Invalid \(field)") }
        }
        strategy = p["strategy"] as? String ?? "auto"
        guard ["auto", "a11y", "event"].contains(strategy), p["strategy"] == nil || p["strategy"] is String else { throw ControlError("invalid_request", "Unknown strategy") }
        returnState = p["return_state"] as? String ?? "none"
        guard ["none", "compact", "full"].contains(returnState), p["return_state"] == nil || p["return_state"] is String else { throw ControlError("invalid_request", "Invalid return_state") }
        var specs: [TargetSpec] = []
        if [.click, .scroll, .setValue, .selectText, .performAction].contains(op) || p["target"] != nil { specs.append(try TargetSpec(p["target"])) }
        if op == .drag { specs = [try TargetSpec(p["from_target"]), try TargetSpec(p["to"])] }
        for target in specs { if case .element = target { _ = try requiredString(p, "state_id", max: 128) } }
        targets = specs
        if [.type, .key, .paste].contains(op) { _ = try requiredString(p, "text", empty: op != .key) }
        if op == .setValue { _ = try requiredString(p, "value", empty: true) }
        if op == .performAction { _ = try requiredString(p, "action", max: 256) }
        if op == .type && specs.isEmpty && p["app_ref"] == nil { throw ControlError("invalid_request", "Focused typing requires app_ref") }
        if let state = p["state_id"], !(state is String) { throw ControlError("invalid_request", "Invalid state_id") }
        if let modifiers = p["modifiers"], !(modifiers is String) { throw ControlError("invalid_request", "Invalid modifiers") }
        if op == .click {
            guard ["left", "right", "middle"].contains(p["mouse_button"] as? String ?? "left"), p["mouse_button"] == nil || p["mouse_button"] is String else { throw ControlError("invalid_request", "Invalid mouse_button") }
            if p["click_count"] != nil { guard let count = integer(p["click_count"]), (1...10).contains(count) else { throw ControlError("invalid_request", "click_count must be 1...10") } }
        }
        if op == .scroll {
            guard let direction = p["scroll_direction"] as? String, ["up", "down", "left", "right"].contains(direction), number(p["scroll_amount"]) != nil else { throw ControlError("invalid_request", "Invalid scroll direction or amount") }
        }
        if op == .selectText, let range = p["text_range"] {
            guard let array = range as? [Any], array.count == 2, integer(array[0]) != nil, integer(array[1]) != nil else { throw ControlError("invalid_request", "text_range must contain a UTF-16 start and length") }
        }
        if op == .key {
            if p["repeat"] != nil { guard let count = integer(p["repeat"]), (1...100).contains(count) else { throw ControlError("invalid_request", "repeat must be 1...100") } }
            if p["hold_seconds"] != nil { guard let hold = number(p["hold_seconds"]), (0...10).contains(hold) else { throw ControlError("invalid_request", "hold_seconds must be 0...10") } }
            let duration = (number(p["hold_seconds"]) ?? 0) * Double(integer(p["repeat"]) ?? 1)
            if duration > 20 { throw ControlError("invalid_request", "Total key hold exceeds 20 seconds") }
        }
        if op == .paste, !["text", "md", "html"].contains(p["format"] as? String ?? "text") || (op == .paste && p["format"] != nil && !(p["format"] is String)) { throw ControlError("invalid_request", "Unsupported clipboard format") }
        if op == .requestAccess, let value = p["capabilities"] { guard let caps = value as? [String], caps.allSatisfy({ ["accessibility", "screenRecording", "inputMonitoring"].contains($0) }) else { throw ControlError("invalid_request", "Unknown capability") } }
        if op == .stop, p["reason"] != nil { _ = try requiredString(p, "reason", max: 1024, empty: true) }
    }
}

func validateAppRef(_ value: Any) throws {
    if let bundle = value as? String, !bundle.isEmpty, bundle.utf8.count <= 512 { return }
    guard let ref = value as? Object else { throw ControlError("invalid_request", "Invalid app_ref") }
    try requireKeys(ref, ["name", "bundle_id", "pid", "window_id"])
    guard ref["name"] != nil || ref["bundle_id"] != nil || ref["pid"] != nil else { throw ControlError("invalid_request", "app_ref requires name, bundle_id or pid") }
    for field in ["name", "bundle_id"] where ref[field] != nil { _ = try requiredString(ref, field, max: 512) }
    for field in ["pid", "window_id"] where ref[field] != nil { guard let value = integer(ref[field]), value > 0 else { throw ControlError("invalid_request", "Invalid \(field)") } }
}

func envelope(_ value: Any, content: [Object]? = nil, dispatch: String = "not_sent") -> Object {
    var structured = value as? Object ?? ["value": value]
    structured["action_sent"] = dispatch != "not_sent"
    structured["dispatch_status"] = dispatch
    return ["content": content ?? [["type": "text", "text": jsonText(value)]], "structuredContent": structured]
}

func failure(_ error: Error, dispatched: Bool = false) -> Object {
    let native = error as? ControlError ?? ControlError("internal", error.localizedDescription)
    var result = envelope(["code": native.code, "message": native.message], dispatch: dispatched ? "possibly_sent" : "not_sent")
    result["isError"] = true
    return result
}
