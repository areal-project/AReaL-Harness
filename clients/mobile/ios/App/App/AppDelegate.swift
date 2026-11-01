import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

class MobileViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArealKeychainPlugin())
        bridge?.registerPluginInstance(ArealLocalSocketPlugin())
        #if DEBUG
        if #available(iOS 16.4, *) { webView?.isInspectable = true }
        if let product = ProcessInfo.processInfo.environment["AREAL_MOBILE_PRODUCT"],
           let data = product.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data),
           object is [String: Any],
           let controller = webView?.configuration.userContentController {
            controller.add(ProductResultHandler(), name: "arealProduct")
            controller.addUserScript(WKUserScript(
                source: "window.__AREAL_MOBILE_PRODUCT__ = \(product);",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        guard let value = ProcessInfo.processInfo.environment["AREAL_MOBILE_PROBE"],
              let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              object is [String: Any],
              let controller = webView?.configuration.userContentController else { return }
        controller.add(ProbeResultHandler(), name: "arealProbe")
        controller.addUserScript(WKUserScript(
            source: "window.__AREAL_MOBILE_PROBE__ = \(value);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        #endif
    }
}

#if DEBUG
private final class ProbeResultHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String,
              ["pairing", "result"].contains(kind),
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? data.write(to: documents.appendingPathComponent("probe-\(kind).json"), options: .atomic)
    }
}
#endif

#if DEBUG
private final class ProductResultHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String,
              ["pairing", "ready", "background", "result"].contains(kind),
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? data.write(to: documents.appendingPathComponent("product-\(kind).json"), options: .atomic)
    }
}
#endif
