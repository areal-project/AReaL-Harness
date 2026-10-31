import Capacitor
import Network
import Foundation

@objc(ArealLocalSocketPlugin)
public class ArealLocalSocketPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ArealLocalSocketPlugin"
    public let jsName = "ArealLocalSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "areal.local-socket")
    private var sockets: [String: NWConnection] = [:]
    private var pending: [String: Int] = [:]
    private let maxFrame = 512 * 1024

    private func localURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "ws", url.user == nil,
              url.password == nil, url.path == "/remote/socket", url.query == nil,
              url.fragment == nil, let host = url.host,
              (1...65535).contains(url.port ?? 80) else { return nil }
        let literal = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if let address = IPv4Address(literal) {
            let bytes = Array(address.rawValue)
            guard literal == bytes.map(String.init).joined(separator: "."),
                  bytes[0] == 10 || (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
                  (bytes[0] == 192 && bytes[1] == 168) else { return nil }
            return url
        }
        guard !literal.contains("%"), let address = IPv6Address(literal),
              address.rawValue.first.map({ $0 & 0xfe == 0xfc }) == true else { return nil }
        return url
    }

    private func event(_ id: String, _ type: String, data: Data? = nil, text: Bool = false) {
        var payload: [String: Any] = ["id": id, "type": type]
        if let data { payload["data"] = data.base64EncodedString(); payload["text"] = text }
        notifyListeners("socketEvent", data: payload)
    }

    private func finish(_ id: String, failed: Bool = false) {
        guard let connection = sockets.removeValue(forKey: id) else { return }
        pending.removeValue(forKey: id)
        connection.cancel()
        if failed { event(id, "error") }
        event(id, "close")
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil,
              let value = call.getString("url"), let url = localURL(value) else {
            call.reject("Invalid local relay", "INVALID_LOCAL_RELAY")
            return
        }
        queue.async { [self] in
            guard self.sockets[id] == nil, self.sockets.count < 4 else {
                call.reject("Local socket limit", "LOCAL_SOCKET_LIMIT")
                return
            }
            let websocket = NWProtocolWebSocket.Options()
            websocket.autoReplyPing = true
            let host = url.host!.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            let authority = (host.contains(":") ? "[\(host)]" : host) +
                (url.port.map { $0 == 80 ? "" : ":\($0)" } ?? "")
            // Network.framework 的默认 Host 会省略非默认端口，Relay 要求完整 authority。
            websocket.setAdditionalHeaders([
                (name: "Origin", value: "capacitor://localhost"),
                (name: "Host", value: authority)
            ])
            websocket.maximumMessageSize = self.maxFrame
            let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
            parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
            let connection = NWConnection(to: .url(url), using: parameters)
            self.sockets[id] = connection
            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard let self, let connection, self.sockets[id] === connection else { return }
                switch state {
                case .ready:
                    self.event(id, "open")
                    self.receive(id, connection)
                case .failed, .waiting:
                    self.finish(id, failed: true)
                case .cancelled:
                    self.finish(id)
                default: break
                }
            }
            connection.start(queue: self.queue)
            call.resolve()
        }
    }

    private func receive(_ id: String, _ connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] data, context, _, error in
            guard let self, let connection, self.sockets[id] === connection else { return }
            if error != nil { self.finish(id, failed: true); return }
            guard let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata else { self.finish(id, failed: true); return }
            switch metadata.opcode {
            case .text, .binary:
                guard let data, data.count <= self.maxFrame else { self.finish(id, failed: true); return }
                self.event(id, "message", data: data, text: metadata.opcode == .text)
            case .close:
                self.finish(id)
                return
            case .ping, .pong: break
            default:
                self.finish(id, failed: true)
                return
            }
            self.receive(id, connection)
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let value = call.getString("data"),
              value.count <= ((maxFrame + 2) / 3) * 4,
              let data = Data(base64Encoded: value), data.count <= maxFrame else {
            call.reject("Invalid local frame", "LOCAL_FRAME_LIMIT")
            return
        }
        let text = call.getBool("text") ?? false
        queue.async {
            guard let connection = self.sockets[id], connection.state == .ready,
                  (self.pending[id] ?? 0) + data.count <= 2 * 1024 * 1024 else {
                call.reject("Local socket unavailable", "LOCAL_SOCKET_UNAVAILABLE")
                return
            }
            self.pending[id, default: 0] += data.count
            let metadata = NWProtocolWebSocket.Metadata(opcode: text ? .text : .binary)
            let context = NWConnection.ContentContext(identifier: "remote", metadata: [metadata])
            connection.send(content: data, contentContext: context, isComplete: true,
                            completion: .contentProcessed { error in
                if self.sockets[id] === connection {
                    self.pending[id, default: 0] -= data.count
                }
                if error != nil { call.reject("Local send failed", "LOCAL_SEND_FAILED") }
                else { call.resolve() }
            })
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Missing socket"); return }
        queue.async { self.finish(id); call.resolve() }
    }
}
