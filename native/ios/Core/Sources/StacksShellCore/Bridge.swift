import Foundation

/// Protocol 1 of the web <-> app bridge: native/protocol/v1.json is the contract.
public enum BridgeProtocol {
    public static let version = 1

    /// Who may make a call: any page of ours, only the portal's own page, or only an app that
    /// declared the call's capability (its manifest's `native`, served by /native/config).
    public enum Origins: String {
        case any
        case auth
        case app
    }

    /// Every call this app version understands, and who may make it.
    public static let calls: [String: Origins] = [
        "app.info": .any,
        "auth.apple": .auth,
        "auth.google": .auth,
        "auth.signedOut": .auth,
        "badge.set": .auth,
        "camera.locate": .app,
        "push.register": .auth,
        "push.saveDevice": .auth,
        "push.status": .auth,
        "share": .any,
        "share.page": .any,
        "haptics.impact": .app,
        "haptics.notification": .app,
        "haptics.pattern": .app,
        "motion.start": .app,
        "motion.stop": .app,
        "screen.immersive": .app,
        "screen.keepAwake": .app,
        "screen.lockOrientation": .app,
    ]

    /// The manifest capability each `.app` call needs.
    public static let capabilities: [String: String] = [
        "camera.locate": "camera",
        "haptics.impact": "haptics",
        "haptics.notification": "haptics",
        "haptics.pattern": "haptics",
        "motion.start": "motion",
        "motion.stop": "motion",
        "screen.immersive": "screen",
        "screen.keepAwake": "screen",
        "screen.lockOrientation": "screen",
    ]

    public static var callNames: [String] { calls.keys.sorted() }
}

public enum BridgeErrorCode: String, Codable {
    case unsupported
    case forbidden
    case cancelled
    case failed
}

public struct BridgeError: Error, Equatable {
    public let code: BridgeErrorCode
    public let message: String

    public init(_ code: BridgeErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// `{ v, name, args }` from the page.
public struct BridgeRequest: Codable, Equatable {
    public let v: Int
    public let name: String
    public let args: [String: JSONValue]

    public init(v: Int = BridgeProtocol.version, name: String, args: [String: JSONValue] = [:]) {
        self.v = v
        self.name = name
        self.args = args
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        name = try c.decode(String.self, forKey: .name)
        args = try c.decodeIfPresent([String: JSONValue].self, forKey: .args) ?? [:]
    }
}

/// `{ ok: true, result }` or `{ ok: false, error: { code, message } }` back to the page.
public enum BridgeReply: Equatable {
    case ok(JSONValue)
    case error(BridgeError)

    public var json: JSONValue {
        switch self {
        case .ok(let result):
            return .object(["ok": .bool(true), "result": result])
        case .error(let e):
            return .object(["ok": .bool(false), "error": .object(["code": .string(e.code.rawValue), "message": .string(e.message)])])
        }
    }
}

/// Where a message came from, as WebKit reports it.
public struct FrameInfo: Equatable {
    public let scheme: String
    public let host: String
    public let isMainFrame: Bool

    public init(scheme: String, host: String, isMainFrame: Bool) {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        self.isMainFrame = isMainFrame
    }
}

/// Checks every call against the protocol's rules, then runs its handler.
public final class BridgeRouter {
    public typealias Handler = ([String: JSONValue]) async throws -> JSONValue

    public let authHost: String
    private let isOurHost: (String) -> Bool
    private let allows: (String, String) async -> Bool
    private var handlers: [String: Handler] = [:]

    /// - Parameters:
    ///   - authHost: the portal's host (`auth.<domain>`): the only page that may call `auth.*`.
    ///   - isOurHost: pages on other hosts get nothing (they shouldn't be in the app at all).
    ///   - allows: has the app on a host (first argument) declared a capability (second)? From
    ///     `native` in /native/config; `.app` calls need theirs. Unknown hosts declare nothing.
    public init(authHost: String, isOurHost: @escaping (String) -> Bool, allows: @escaping (String, String) async -> Bool = { _, _ in false }) {
        self.authHost = authHost.lowercased()
        self.isOurHost = isOurHost
        self.allows = allows
    }

    public func register(_ name: String, _ handler: @escaping Handler) {
        handlers[name] = handler
    }

    /// Why this call may not run from this frame, or nil when it may.
    public func refusal(_ name: String, from frame: FrameInfo) async -> BridgeError? {
        guard let origins = BridgeProtocol.calls[name], handlers[name] != nil else {
            return BridgeError(.unsupported, "\"\(name)\" is not something this app does")
        }
        guard frame.scheme == "https", frame.isMainFrame, isOurHost(frame.host) else {
            return BridgeError(.forbidden, "Not allowed from this page")
        }
        if origins == .auth && frame.host != authHost {
            return BridgeError(.forbidden, "Only the Stacks portal may ask for \"\(name)\"")
        }
        if origins == .app {
            let needed = BridgeProtocol.capabilities[name] ?? name
            if frame.host == authHost {
                return BridgeError(.forbidden, "\"\(name)\" is for apps")
            }
            if !(await allows(frame.host, needed)) {
                return BridgeError(.forbidden, "This app hasn't declared \"\(needed)\" (\"native\" in its manifest)")
            }
        }
        return nil
    }

    /// Handle a message body from the page (Foundation objects, as WebKit delivers it).
    public func handle(body: Any, from frame: FrameInfo) async -> BridgeReply {
        let request: BridgeRequest
        do {
            let data = try JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed])
            request = try JSONDecoder().decode(BridgeRequest.self, from: data)
        } catch {
            return .error(BridgeError(.failed, "Malformed bridge request"))
        }
        return await handle(request, from: frame)
    }

    public func handle(_ request: BridgeRequest, from frame: FrameInfo) async -> BridgeReply {
        guard request.v == BridgeProtocol.version else {
            return .error(BridgeError(.unsupported, "This app speaks bridge protocol \(BridgeProtocol.version)"))
        }
        if let refusal = await refusal(request.name, from: frame) { return .error(refusal) }
        do {
            return .ok(try await handlers[request.name]!(request.args))
        } catch let e as BridgeError {
            return .error(e)
        } catch {
            return .error(BridgeError(.failed, error.localizedDescription))
        }
    }

    /// The script the app adds to every page at document start: `window.stacksNative`.
    public static func injectedScript(appVersion: String, platform: String = "ios") -> String {
        let calls = BridgeProtocol.callNames.map { "\"\($0)\"" }.joined(separator: ",")
        let version = appVersion.replacingOccurrences(of: "\"", with: "")
        return """
        (function () {
          var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.stacks;
          if (!handler || window.stacksNative) return;
          var listeners = {};
          var host = Object.freeze({
            protocol: \(BridgeProtocol.version),
            platform: "\(platform)",
            version: "\(version)",
            calls: Object.freeze([\(calls)]),
            call: function (name, args) { return handler.postMessage({ v: \(BridgeProtocol.version), name: name, args: args || {} }); },
            listen: function (channel, fn) {
              (listeners[channel] = listeners[channel] || []).push(fn);
              return function () { listeners[channel] = (listeners[channel] || []).filter(function (f) { return f !== fn; }); };
            },
            _emit: function (channel, payload) {
              (listeners[channel] || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) { setTimeout(function () { throw e; }); } });
            }
          });
          Object.defineProperty(window, "stacksNative", { value: host, writable: false, configurable: false });
        })();
        """
    }

    /// The script that hands an event to the page's listeners on `channel` (`payloadJSON` is
    /// already JSON).
    public static func emitScript(channel: String, payloadJSON: String) -> String {
        let quoted = (try? JSONEncoder().encode(channel)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        return "window.stacksNative && window.stacksNative._emit(\(quoted), \(payloadJSON));"
    }
}
