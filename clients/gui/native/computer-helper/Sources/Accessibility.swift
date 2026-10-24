import AppKit
import ApplicationServices
import ScreenCaptureKit

func onMain<T>(_ body: () throws -> T) rethrows -> T { try Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body) }
func copyAXValue(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    var result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if result == .cannotComplete {
        Thread.sleep(forTimeInterval: 0.025)
        result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    }
    return (result, value)
}
func ax(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    let (result, value) = copyAXValue(element, name)
    return result == .success ? value : nil
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = ax(element, name) else { return nil }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}
func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let position = ax(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = ax(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
          point.x.isFinite, point.y.isFinite, dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func axRange(_ element: AXUIElement) -> CFRange? {
    guard let value = ax(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}
func rectJSON(_ rect: CGRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height] }
func axActions(_ element: AXUIElement) -> [String] {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success else { return [] }
    return actions as? [String] ?? []
}
func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var result = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &result) == .success && result.boolValue
}
func elementSignature(_ element: AXUIElement) throws -> String {
    guard let role = axString(element, kAXRoleAttribute) else { throw ControlError("element_unavailable", "The AX element no longer exists") }
    let selection = axRange(element)
    return try digest(["role": role, "title": axString(element, kAXTitleAttribute) ?? "",
                       "value": axString(element, kAXValueAttribute) ?? "", "bounds": axBounds(element).map(rectJSON) ?? [],
                       "enabled": (ax(element, kAXEnabledAttribute) as? Bool) ?? true,
                       "selection": selection.map { [$0.location, $0.length] } ?? [], "actions": axActions(element)])
}

final class AppTarget {
    let app: NSRunningApplication
    let element: AXUIElement
    let pid: pid_t
    let bundle: String?
    let launched: Date?
    init(_ app: NSRunningApplication) {
        self.app = app; pid = app.processIdentifier; bundle = app.bundleIdentifier; launched = app.launchDate
        element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.25)
    }
    var json: Object { ["pid": Int(pid), "bundle_id": bundle as Any? ?? NSNull(), "name": app.localizedName as Any? ?? NSNull(), "active": app.isActive] }
    func validate() throws {
        guard let live = NSRunningApplication(processIdentifier: pid), !live.isTerminated,
              live.bundleIdentifier == bundle, live.launchDate == launched else { throw ControlError("element_unavailable", "The prepared application exited or changed identity") }
    }
}

final class WindowTarget {
    let app: AppTarget
    let element: AXUIElement
    let id: Int
    let bounds: CGRect
    let title: String
    init(app: AppTarget, element: AXUIElement, id: Int) throws {
        guard let bounds = axBounds(element) else { throw ControlError("element_unavailable", "Window geometry is unavailable") }
        self.app = app; self.element = element; self.id = id; self.bounds = bounds
        title = axString(element, kAXTitleAttribute) ?? ""
    }
    var json: Object {
        ["window_id": id, "title": title, "bounds": rectJSON(bounds),
         "main": (ax(element, kAXMainAttribute) as? Bool) ?? false,
         "focused": axElement(ax(app.element, kAXFocusedWindowAttribute)).map { CFEqual($0, element) } ?? false,
         "minimized": (ax(element, kAXMinimizedAttribute) as? Bool) ?? false,
         "subrole": axString(element, kAXSubroleAttribute) as Any? ?? NSNull()]
    }
    func validate() throws {
        try app.validate()
        guard axBounds(element) == bounds, axString(element, kAXTitleAttribute) == title,
              (ax(element, kAXMinimizedAttribute) as? Bool) != true else { throw ControlError("element_unavailable", "The observed window changed; observe it again") }
    }
    func requireForeground() throws {
        try validate()
        guard onMain({ NSWorkspace.shared.frontmostApplication?.processIdentifier }) == app.pid,
              let focused = axElement(ax(app.element, kAXFocusedWindowAttribute)), CFEqual(focused, element) else {
            throw ControlError("foreground_required", "The prepared application and window must already be foreground")
        }
    }
    func requireForegroundOrHost(_ hostPID: pid_t?) throws {
        try validate()
        let foreground = onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
        if let hostPID, foreground == hostPID { return }
        try requireForeground()
    }
    func activateRetainedWindow() throws {
        try validate()
        guard app.app.activate(options: []) else {
            throw ControlError("foreground_required", "The approved application could not be activated")
        }
        guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success,
              AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue) == .success else {
            throw ControlError("foreground_required", "The approved window could not be raised")
        }
    }
}

final class WindowRegistry {
    var records: [(pid_t, AXUIElement, Int)] = []
    var apps: [pid_t: AppTarget] = [:]
    var nextId = 1
    func windows(_ app: AppTarget) throws -> [WindowTarget] {
        let (status, value) = copyAXValue(app.element, kAXWindowsAttribute)
        guard status == .success, let elements = value as? [AXUIElement] else { throw ControlError("element_unavailable", "AX windows are unavailable (AX status \(status.rawValue))") }
        return try elements.prefix(100).map { element in
            let id: Int
            if let existing = records.first(where: { $0.0 == app.pid && CFEqual($0.1, element) }) { id = existing.2 }
            else { id = nextId; nextId += 1; records.append((app.pid, element, id)) }
            return try WindowTarget(app: app, element: element, id: id)
        }
    }
    func resolveApp(_ value: Any) throws -> AppTarget {
        let ref = (value as? Object) ?? ["bundle_id": value]
        let matches = onMain { NSWorkspace.shared.runningApplications }.filter { app in
            !app.isTerminated && (ref["pid"] == nil || integer(ref["pid"]) == Int(app.processIdentifier))
                && (ref["bundle_id"] == nil || ref["bundle_id"] as? String == app.bundleIdentifier)
                && (ref["name"] == nil || (ref["name"] as? String)?.caseInsensitiveCompare(app.localizedName ?? "") == .orderedSame)
        }
        guard matches.count == 1, let app = matches.first else {
            throw ControlError("invalid_request", matches.isEmpty ? "Target app is not running" : "app_ref matches multiple running apps; specify pid")
        }
        if let existing = apps[app.processIdentifier], (try? existing.validate()) != nil { return existing }
        let target = AppTarget(app)
        apps[app.processIdentifier] = target
        return target
    }
    func resolveWindow(_ app: AppTarget, ref: Any?) throws -> WindowTarget {
        let windows = try windows(app)
        if let object = ref as? Object, let id = integer(object["window_id"]) {
            guard let window = windows.first(where: { $0.id == id }) else { throw ControlError("element_unavailable", "Pinned window is unavailable") }
            return window
        }
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if let selected = axElement(ax(app.element, attribute)), let window = windows.first(where: { CFEqual($0.element, selected) }) { return window }
        }
        guard windows.count == 1, let window = windows.first else { throw ControlError("element_unavailable", "Select an explicit window_id from list_windows") }
        return window
    }
}

struct ElementBinding {
    let element: AXUIElement
    let signature: String
    let row: Object
}

final class FrameBinding {
    let id = UUID().uuidString
    let windowID: CGWindowID
    let bounds: CGRect
    let width: Int
    let height: Int
    let png: Data
    let capturedAt = nowMillis()
    init(id: CGWindowID, bounds: CGRect, image: CGImage) throws {
        windowID = id; self.bounds = bounds; width = image.width; height = image.height
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), data.count <= 20 * 1024 * 1024 else { throw ControlError("internal", "Captured PNG exceeds the image budget") }
        png = data
    }
    func validate(_ window: WindowTarget) throws {
        try window.validate()
        guard let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [Object], rows.count == 1,
              let row = rows.first, integer(row[kCGWindowOwnerPID as String]) == Int(window.app.pid),
              let rectangle = row[kCGWindowBounds as String] as? [String: Any],
              let current = CGRect(dictionaryRepresentation: rectangle as CFDictionary), current == bounds,
              (row[kCGWindowIsOnscreen as String] as? Bool) == true else { throw ControlError("element_unavailable", "The screenshot frame is stale or offscreen") }
    }
    func point(x: Int, y: Int) throws -> CGPoint {
        guard x < width, y < height else { throw ControlError("invalid_request", "Pixel target lies outside the emitted raster") }
        return CGPoint(x: bounds.minX + Double(x) * bounds.width / Double(width), y: bounds.minY + Double(y) * bounds.height / Double(height))
    }
    var json: Object { ["frame_id": id, "window_id": Int(windowID), "pixel_width": width, "pixel_height": height, "capture_bounds": rectJSON(bounds), "captured_at": capturedAt] }
}

final class Observation {
    let id = UUID().uuidString
    let ownerScope: String
    let epoch: UInt64
    let window: WindowTarget
    let elements: [ElementBinding]
    let text: String
    let frame: FrameBinding?
    let expires = nowMillis() + 90_000
    init(owner: Owner, epoch: UInt64, window: WindowTarget, frame: FrameBinding?, check: () throws -> Void) throws {
        ownerScope = owner.scope; self.epoch = epoch; self.window = window; self.frame = frame
        var rows: [ElementBinding] = []; var lines: [String] = []; var seen: [AXUIElement] = []
        let deadline = nowMillis() + 4_000
        var textBytes = 0
        func walk(_ element: AXUIElement, _ depth: Int) throws {
            try check()
            guard rows.count < 750, depth <= 32, nowMillis() < deadline, textBytes < 192 * 1024,
                  !seen.contains(where: { CFEqual($0, element) }) else { return }
            seen.append(element)
            guard let role = axString(element, kAXRoleAttribute) else { return }
            let title = (axString(element, kAXTitleAttribute) ?? axString(element, kAXDescriptionAttribute)).map { String($0.prefix(2048)) }
            let value = axString(element, kAXValueAttribute).map { String($0.prefix(32_768)) }
            let index = rows.count
            let row: Object = ["index": index, "kind": role.hasPrefix("AX") ? String(role.dropFirst(2)) : role,
                               "title": title as Any? ?? NSNull(), "value": value as Any? ?? NSNull(), "actions": axActions(element),
                               "identifier": axString(element, kAXIdentifierAttribute) as Any? ?? NSNull(),
                               "bounds": axBounds(element).map(rectJSON) as Any? ?? NSNull()]
            let line = String(repeating: "  ", count: depth) + "[\(index)] \(row["kind"]!) \(title ?? "")\(value.map { " = " + $0 } ?? "")"
            textBytes += line.utf8.count; lines.append(line)
            rows.append(ElementBinding(element: element, signature: try elementSignature(element), row: row))
            for child in (ax(element, kAXChildrenAttribute) as? [AXUIElement] ?? []) { try walk(child, depth + 1) }
        }
        try walk(window.element, 0)
        elements = rows; text = lines.joined(separator: "\n")
    }
    var result: Object {
        var data: Object = ["state_id": id, "app": window.app.json, "window": window.json, "elements": elements.map(\.row), "text": text, "snapshot_mode": "full"]
        var content: [Object] = [["type": "text", "text": text]]
        if let frame {
            data["frame_id"] = frame.id; data["frame"] = frame.json
            content.append(["type": "image", "data": frame.png.base64EncodedString(), "mimeType": "image/png"])
            content.append(["type": "text", "text": jsonText(["image_ref": frame.json])])
        }
        return envelope(data, content: content)
    }
}

func captureWindow(_ window: WindowTarget, check: () throws -> Void) throws -> FrameBinding {
    guard CGPreflightScreenCaptureAccess() else { throw ControlError("permission_denied", "Grant Screen Recording to AReaL Computer Helper in Settings") }
    try window.validate()
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var captured: Result<FrameBinding, Error>?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
        if let error { lock.lock(); captured = .failure(error); lock.unlock(); semaphore.signal(); return }
        let candidates = content?.windows.filter { $0.owningApplication?.processID == window.app.pid && $0.frame == window.bounds && ($0.title ?? "") == window.title } ?? []
        guard candidates.count == 1, let selected = candidates.first else {
            lock.lock(); captured = .failure(ControlError("element_unavailable", "Cannot uniquely map the AX window to a capture window")); lock.unlock(); semaphore.signal(); return
        }
        let filter = SCContentFilter(desktopIndependentWindow: selected)
        let config = SCStreamConfiguration()
        let scale = min(Double(filter.pointPixelScale), 4096 / max(selected.frame.width, selected.frame.height))
        config.width = max(1, Int((selected.frame.width * scale).rounded()))
        config.height = max(1, Int((selected.frame.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
            let result: Result<FrameBinding, Error>
            if let image { result = Result { try FrameBinding(id: selected.windowID, bounds: selected.frame, image: image) } }
            else { result = .failure(error ?? ControlError("internal", "ScreenCaptureKit returned no image")) }
            lock.lock(); captured = result; lock.unlock(); semaphore.signal()
        }
    }
    let deadline = nowMillis() + 10_000
    while semaphore.wait(timeout: .now() + 0.025) != .success {
        try check()
        if nowMillis() >= deadline { throw ControlError("timeout", "Screen capture timed out") }
    }
    try check()
    lock.lock(); let result = captured; lock.unlock()
    let frame = try result!.get()
    try frame.validate(window)
    return frame
}
