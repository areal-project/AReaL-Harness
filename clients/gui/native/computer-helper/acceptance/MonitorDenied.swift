import Foundation

@main
struct MonitorDeniedAcceptance {
    static func main() throws {
        let control = InputControl(canListen: { false })
        let helper = ComputerHelper(control: control)
        let target: Object = ["type": "element", "index": 0]
        let app: Object = ["pid": Int(ProcessInfo.processInfo.processIdentifier)]
        let operations: [(String, Object)] = [
            ("left_click", ["target": target, "strategy": "a11y"]),
            ("left_click_drag", ["from_target": target, "to": target]),
            ("scroll", ["target": target, "scroll_direction": "down", "scroll_amount": 1, "strategy": "a11y"]),
            ("type", ["target": target, "text": "text", "strategy": "a11y"]),
            ("set_value", ["target": target, "value": "text"]),
            ("select_text", ["target": target, "text_range": [0, 0]]),
            ("key", ["app_ref": app, "text": "a"]),
            ("paste", ["app_ref": app, "text": "text"]),
            ("perform_action", ["target": target, "action": "AXPress"])
        ]
        var checked: [String] = []
        for (operation, parameters) in operations {
            var parameters = parameters; parameters["state_id"] = "unresolved-fixture-state"
            let request: Object = ["coreInstanceId": "fixture", "coreGeneration": "fixture-core-generation", "projectId": "fixture", "threadId": "fixture", "turnId": "fixture", "callId": UUID().uuidString, "toolHostGeneration": "fixture-tool-generation",
                                   "arguments": ["operation": operation, "parameters": parameters]]
            do {
                _ = try helper.prepare(request, epoch: control.epoch)
                throw ControlError("acceptance_failed", "Mutation \(operation) was admitted without a monitor")
            } catch let error as ControlError {
                guard error.code == "takeover_unavailable" else { throw error }
            }
            checked.append(operation)
        }
        guard helper.status()["ready"] as? Bool == false else { throw ControlError("acceptance_failed", "Missing monitor incorrectly reported ready") }
        print(jsonText(["passed": true, "mutations": checked, "scope": "Native prepare with injected unavailable listen permission; no app lookup, AX write, OS prompt, or input dispatch"]))
    }
}
