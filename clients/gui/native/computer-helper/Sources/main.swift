import AppKit
import Foundation

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let helper = ComputerHelper()
let worker = DispatchQueue(label: "com.areal.computer.actions")
let output = DispatchQueue(label: "com.areal.computer.output")
let inputLimit = 1_048_576
let outputLimit = 32 * 1_048_576
let admissionLock = NSLock()
var admitted = 0

func send(_ value: Object) {
    output.async {
        do {
            var data = try canonical(value)
            guard data.count <= outputLimit else { helper.control.stop("Response budget exceeded"); exit(70) }
            data.append(0x0a)
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch { helper.control.stop("Host output closed"); exit(0) }
    }
}
func reply(_ id: String, _ body: () throws -> Any) {
    do { send(["id": id, "ok": true, "result": try body()]) }
    catch {
        let result = failure(error)
        send(["id": id, "ok": false, "error": result["structuredContent"]!])
    }
}
helper.emit = send
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termination.setEventHandler { helper.control.stop("Helper terminated"); exit(0) }
termination.resume()
let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
interruption.setEventHandler { helper.control.stop("Helper interrupted"); exit(0) }
interruption.resume()

DispatchQueue.global(qos: .userInitiated).async {
    var buffer = Data()
    var bytes = [UInt8](repeating: 0, count: 65_536)
    while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count < 0 { if errno == EINTR { continue }; helper.control.stop("Host input failed"); exit(0) }
        if count == 0 { helper.control.stop("Host disconnected"); exit(0) }
        buffer.append(contentsOf: bytes.prefix(count))
        while let newline = buffer.firstIndex(of: 0x0a) {
            let line = buffer[..<newline]
            buffer.removeSubrange(...newline)
            guard line.count <= inputLimit, let message = try? JSONSerialization.jsonObject(with: Data(line)) as? Object,
                  let id = message["id"] as? String, id.utf8.count <= 128, let method = message["method"] as? String else {
                helper.control.stop("Malformed private request"); exit(65)
            }
            let params = message["params"] as? Object ?? [:]
            if method == "stop" {
                helper.control.stop(params["reason"] as? String ?? "Stopped by host")
                reply(id) { helper.status() }
                continue
            }
            if method == "status" { reply(id) { helper.status() }; continue }
            if method == "close" {
                helper.control.stop("Host closed helper")
                output.sync {}
                exit(0)
            }
            var epoch = helper.control.epoch
            let isStop = (params["arguments"] as? Object)?["operation"] as? String == Operation.stop.rawValue
            if (method == "prepare" || method == "execute") && !isStop {
                do {
                    guard let admitted = integer(params["admissionEpoch"]), admitted > 0 else { throw ControlError("invalid_request", "Missing private admission generation") }
                    epoch = UInt64(admitted)
                    try helper.control.admit(Owner(params), epoch: epoch)
                } catch { reply(id) { throw error }; continue }
            }
            if method == "prepare", isStop {
                reply(id) { try helper.prepareStop(params, epoch: epoch) }
                continue
            }
            if method == "execute", isStop {
                reply(id) { helper.executeStop(params, epoch: epoch) }
                continue
            }
            admissionLock.lock()
            if admitted >= 32 { admissionLock.unlock(); reply(id) { throw ControlError("controller_busy", "Helper request queue is full") }; continue }
            admitted += 1; admissionLock.unlock()
            worker.async {
                defer { admissionLock.lock(); admitted -= 1; admissionLock.unlock() }
                reply(id) {
                    if method == "discard" { return try helper.discard(params) }
                    try helper.control.check(epoch)
                    switch method {
                    case "prepare": return try helper.prepare(params, epoch: epoch)
                    case "execute": return helper.execute(params, epoch: epoch)
                    case "requestAccess": return try helper.requestAccess(requiredString(params, "capability", max: 64))
                    default: throw ControlError("method_not_found", "Unknown private helper method")
                    }
                }
            }
        }
        if buffer.count > inputLimit { helper.control.stop("Private request budget exceeded"); exit(65) }
    }
}
app.run()
