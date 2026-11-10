import Foundation

/// A JSON value: what bridge arguments and results are made of.
public enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

extension JSONValue {
    /// The value as Foundation objects (what WebKit hands back to the page).
    public var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? Int(n) as Any : n as Any
        case .string(let s): return s
        case .array(let a): return a.map { $0.foundationValue }
        case .object(let o): return o.mapValues { $0.foundationValue }
        }
    }

    /// A value from Foundation objects (what WebKit gives us from the page).
    public init(foundation value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
