// uab-apple-model: lets Unified AI Base use Apple's on-device model (Apple Intelligence).
//
// Speaks newline-delimited JSON over stdio:
//   in:  {"type":"start","instructions":"…","prompt":"…","tools":[{name,description,parameters}]}
//   out: {"type":"tool_call","id":"t1","name":"…","arguments":{…}}
//   in:  {"type":"tool_result","id":"t1","content":"…"}
//   out: {"type":"final","text":"…"}  or  {"type":"error","code":"…","message":"…"}
//
// The model never runs a tool itself: every tool call goes back to the app,
// which sends it to the kernel for authorisation.
//
//   uab-apple-model --check   prints {"available":true} or {"available":false,"reason":"…"}

import Foundation
import FoundationModels

func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

func parseJSON(_ text: String) -> Any {
  (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) ?? [String: Any]()
}

/// Tool calls wait here until the app sends back the kernel's decision.
actor Bridge {
  private var waiting: [String: CheckedContinuation<String, Never>] = [:]
  private var counter = 0

  func call(name: String, argumentsJSON: String) async -> String {
    counter += 1
    let id = "t\(counter)"
    return await withCheckedContinuation { continuation in
      waiting[id] = continuation
      emit(["type": "tool_call", "id": id, "name": name, "arguments": parseJSON(argumentsJSON)])
    }
  }

  func resolve(id: String, content: String) {
    waiting.removeValue(forKey: id)?.resume(returning: content)
  }
}

/// A tool whose name and inputs come from the kernel's capability list at runtime.
struct KernelTool: Tool {
  let name: String
  let description: String
  let parameters: GenerationSchema
  let bridge: Bridge

  func call(arguments: GeneratedContent) async throws -> String {
    await bridge.call(name: name, argumentsJSON: arguments.jsonString)
  }
}

/// JSON Schema (the subset capabilities use) → the model's generation schema.
func schema(_ s: [String: Any], name: String) -> DynamicGenerationSchema {
  let description = s["description"] as? String
  if let choices = s["enum"] as? [String], !choices.isEmpty {
    return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
  }
  switch s["type"] as? String {
  case "object":
    let props = s["properties"] as? [String: Any] ?? [:]
    let required = Set(s["required"] as? [String] ?? [])
    let properties = props.keys.sorted().map { key -> DynamicGenerationSchema.Property in
      let p = props[key] as? [String: Any] ?? [:]
      return DynamicGenerationSchema.Property(
        name: key,
        description: p["description"] as? String,
        schema: schema(p, name: "\(name)_\(key)"),
        isOptional: !required.contains(key)
      )
    }
    return DynamicGenerationSchema(name: name, description: description, properties: properties)
  case "array":
    return DynamicGenerationSchema(arrayOf: schema(s["items"] as? [String: Any] ?? ["type": "string"], name: "\(name)_item"))
  case "number", "integer":
    return DynamicGenerationSchema(type: Double.self)
  case "boolean":
    return DynamicGenerationSchema(type: Bool.self)
  default:
    return DynamicGenerationSchema(type: String.self)
  }
}

func availability() -> [String: Any] {
  switch SystemLanguageModel.default.availability {
  case .available:
    return ["available": true]
  case .unavailable(let reason):
    let text: String
    switch reason {
    case .deviceNotEligible: text = "This Mac doesn't support Apple Intelligence."
    case .appleIntelligenceNotEnabled: text = "Apple Intelligence is turned off. Turn it on in System Settings → Apple Intelligence & Siri."
    case .modelNotReady: text = "Apple's model is still downloading. Try again in a few minutes."
    @unknown default: text = "Apple's on-device model isn't available."
    }
    return ["available": false, "reason": text]
  }
}

@main
struct Main {
  static func main() async {
    if CommandLine.arguments.contains("--check") {
      emit(availability())
      return
    }
    guard let line = readLine(), let start = parseJSON(line) as? [String: Any], start["type"] as? String == "start" else {
      emit(["type": "error", "code": "protocol", "message": "Expected a start message"])
      exit(2)
    }
    let avail = availability()
    if avail["available"] as? Bool != true {
      emit(["type": "error", "code": "unavailable", "message": avail["reason"] ?? "Unavailable"])
      exit(1)
    }

    let bridge = Bridge()
    // Kernel decisions arrive on stdin while the model is working.
    Thread {
      while let line = readLine() {
        guard let msg = parseJSON(line) as? [String: Any], msg["type"] as? String == "tool_result",
              let id = msg["id"] as? String else { continue }
        let content = msg["content"] as? String ?? ""
        Task { await bridge.resolve(id: id, content: content) }
      }
      exit(0) // the app went away
    }.start()

    do {
      let specs = start["tools"] as? [[String: Any]] ?? []
      let tools: [any Tool] = try specs.map { spec in
        let name = spec["name"] as? String ?? "tool"
        let params = spec["parameters"] as? [String: Any] ?? ["type": "object", "properties": [String: Any]()]
        return KernelTool(
          name: name,
          description: spec["description"] as? String ?? "",
          parameters: try GenerationSchema(root: schema(params, name: name), dependencies: []),
          bridge: bridge
        )
      }
      let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
      let session = LanguageModelSession(model: model, tools: tools, instructions: start["instructions"] as? String ?? "")
      let response = try await session.respond(to: start["prompt"] as? String ?? "")
      emit(["type": "final", "text": response.content])
    } catch let error as LanguageModelSession.GenerationError {
      let code: String
      switch error {
      case .exceededContextWindowSize: code = "context"
      case .guardrailViolation, .refusal: code = "guardrail"
      case .rateLimited: code = "busy"
      default: code = "generation"
      }
      emit(["type": "error", "code": code, "message": error.localizedDescription])
    } catch {
      emit(["type": "error", "code": "other", "message": error.localizedDescription])
    }
    exit(0)
  }
}
