// Polish ASR utterances using Apple's on-device language model
// (FoundationModels framework, macOS 26 Tahoe+).
//
// Reads JSON from stdin: { "utterances": [{ "text": "..." }, ...] }
// Writes JSON to stdout: { "utterances": [{ "text": "..." }, ...] }
//
// Exit codes:
//   0 — success (output is polished utterances)
//   2 — FoundationModels unavailable (older macOS or AI disabled). Caller
//       should treat this as "polish skipped" rather than a fatal error.
//   1 — anything else (bad input, model error, parse failure, etc.)

import Foundation

struct InUtterance: Codable { let text: String }
struct InPayload: Codable { let utterances: [InUtterance] }
struct OutUtterance: Codable { let text: String }
struct OutPayload: Codable { let utterances: [OutUtterance] }

func wordCount(_ s: String) -> Int {
  return s.split(whereSeparator: { $0.isWhitespace }).count
}

func writeStderr(_ s: String) {
  FileHandle.standardError.write(s.data(using: .utf8) ?? Data())
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let payload = try? JSONDecoder().decode(InPayload.self, from: inputData) else {
  writeStderr("Invalid input JSON\n")
  exit(1)
}

#if canImport(FoundationModels)
  import FoundationModels

  let instructions = """
    You polish raw automatic speech recognition transcripts. The user will give you \
    one utterance per message. Add commas around disfluencies (um, uh, ah, like, you \
    know, I mean, well, so), em-dashes for self-corrections and false starts (e.g., \
    "code coding" becomes "code—coding"), missing punctuation, and proper capitalization.

    CRITICAL: Do NOT add, remove, or change any of the spoken words. Keep them in the \
    exact same order. Only add punctuation and fix casing.

    Respond with ONLY the polished utterance. No preamble. No explanation. No quotes \
    around it. No trailing punctuation that wasn't implied by the speech.

    Examples:
    Input:  um yeah I think so it was the the door that was open
    Output: Um, yeah, I think so. It was the—the door that was open.

    Input:  code coding is hard you know
    Output: Code—coding is hard, you know?
    """

  @available(macOS 26.0, *)
  func run(payload: InPayload) async {
    if payload.utterances.isEmpty {
      let out = OutPayload(utterances: [])
      if let data = try? JSONEncoder().encode(out) {
        FileHandle.standardOutput.write(data)
      }
      return
    }

    // One call per utterance. Per-utterance calls are clearer for the model
    // than batched numbered lists (small models drift on format compliance)
    // and the per-call overhead on Apple FMM is small. Total time for 50
    // utterances is typically under 30 seconds on Apple Silicon.
    let session = LanguageModelSession(instructions: instructions)
    var polished: [String] = payload.utterances.map { $0.text }

    let total = payload.utterances.count
    for (idx, utterance) in payload.utterances.enumerated() {
      // Emit progress to stderr so the TS caller can surface it in toasts.
      // Format is parseable: "PROGRESS <current>/<total>".
      writeStderr("PROGRESS \(idx + 1)/\(total)\n")

      let original = utterance.text
      if original.trimmingCharacters(in: .whitespaces).isEmpty { continue }

      do {
        let response = try await session.respond(to: original)
        let candidate = response.content
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty { continue }

        // Safety check: drop polished text if word count drifted >20% (the
        // model may have hallucinated, dropped words, or added commentary).
        let originalCount = wordCount(original)
        let newCount = wordCount(candidate)
        if originalCount > 0 {
          let drift = abs(Double(newCount - originalCount)) / Double(originalCount)
          if drift > 0.2 { continue }
        }
        polished[idx] = candidate
      } catch {
        writeStderr("Polish failed on utterance \(idx): \(error)\n")
        // Keep the original text for this utterance and continue.
      }
    }

    let out = OutPayload(utterances: polished.map { OutUtterance(text: $0) })
    if let data = try? JSONEncoder().encode(out) {
      FileHandle.standardOutput.write(data)
    } else {
      writeStderr("Failed to encode output JSON\n")
      exit(1)
    }
  }

  if #available(macOS 26.0, *) {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
      await run(payload: payload)
      semaphore.signal()
    }
    semaphore.wait()
  } else {
    writeStderr("FoundationModels requires macOS 26 (Tahoe) or later\n")
    exit(2)
  }
#else
  writeStderr("FoundationModels framework not available in this SDK\n")
  exit(2)
#endif
