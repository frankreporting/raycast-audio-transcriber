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

// Extract a normalized word sequence: lowercase, letters and digits only.
// Apostrophes are IGNORED (neither part of words nor separators), so
// contractions match their bare form — "that's" and "thats" both
// tokenize to ["thats"]. This lets polish's apostrophe additions
// (e.g., "wouldnt" → "wouldn't") pass the word-preservation validator
// directly rather than getting kicked to the merge fallback.
func wordTokens(_ s: String) -> [String] {
  var tokens: [String] = []
  var current = ""
  for scalar in s.lowercased().unicodeScalars {
    let c = Character(scalar)
    if c.isLetter || c.isNumber {
      current.append(c)
    } else if c == "'" {
      // skip apostrophe — neither add nor end current word
      continue
    } else if !current.isEmpty {
      tokens.append(current)
      current = ""
    }
  }
  if !current.isEmpty { tokens.append(current) }
  return tokens
}

struct OrigWord {
  let token: String
  let surface: String
}

func extractOriginalWords(_ s: String) -> [OrigWord] {
  var out: [OrigWord] = []
  var surface = ""
  for c in s {
    if c.isLetter || c.isNumber || c == "'" {
      surface.append(c)
    } else if !surface.isEmpty {
      let tok = wordTokens(surface).first ?? ""
      out.append(OrigWord(token: tok, surface: surface))
      surface = ""
    }
  }
  if !surface.isEmpty {
    let tok = wordTokens(surface).first ?? ""
    out.append(OrigWord(token: tok, surface: surface))
  }
  return out
}

// Walk through polished, accepting words that line up with the next
// original word (small lookahead splices in any words polish dropped),
// dropping polish words that don't match any nearby original word
// (hallucinations). Keeps polish's punctuation/casing where possible.
func mergePolishedPunctuation(original: String, polished: String) -> String {
  let originalWords = extractOriginalWords(original)
  if originalWords.isEmpty { return polished }
  let lookahead = 4
  var result = ""
  var origIdx = 0
  var i = polished.startIndex
  while i < polished.endIndex {
    let c = polished[i]
    if c.isLetter || c.isNumber {
      let wordStart = i
      while i < polished.endIndex,
        polished[i].isLetter || polished[i].isNumber || polished[i] == "'"
      {
        i = polished.index(after: i)
      }
      let polishWord = String(polished[wordStart..<i])
      let polishToken = wordTokens(polishWord).first ?? ""
      var matchedAt = -1
      let maxLookahead = min(lookahead, originalWords.count - origIdx)
      for k in 0..<maxLookahead {
        if originalWords[origIdx + k].token == polishToken {
          matchedAt = k
          break
        }
      }
      if matchedAt >= 0 {
        for k in 0..<matchedAt {
          if !result.isEmpty, let lastChar = result.last, !lastChar.isWhitespace {
            result += " "
          }
          result += originalWords[origIdx + k].surface
        }
        // After splicing missing words, ensure separation from polish word.
        if matchedAt > 0, let lastChar = result.last, !lastChar.isWhitespace {
          result += " "
        }
        result += polishWord
        origIdx += matchedAt + 1
      }
    } else {
      result.append(c)
      i = polished.index(after: i)
    }
  }
  while origIdx < originalWords.count {
    if !result.isEmpty, let lastChar = result.last, !lastChar.isWhitespace {
      result += " "
    }
    result += originalWords[origIdx].surface
    origIdx += 1
  }
  return cleanupArtifacts(result)
}

// Collapse spacing/punctuation artifacts left by the merge process
// (e.g. "  " from spliced gaps, ", ," when polish punctuation surrounded
// a dropped word). Iterates to a fixed point so cascading fixes settle.
func cleanupArtifacts(_ s: String) -> String {
  var result = s
  let pairs: [(String, String)] = [
    ("  ", " "),
    (" ,", ","),
    (" .", "."),
    (" ;", ";"),
    (" :", ":"),
    (" ?", "?"),
    (" !", "!"),
    (",,", ","),
    ("..", "."),
    (", ,", ","),
    (", .", "."),
    (",.", "."),
    (".,", "."),
  ]
  var changed = true
  while changed {
    changed = false
    for (from, to) in pairs {
      if result.contains(from) {
        result = result.replacingOccurrences(of: from, with: to)
        changed = true
      }
    }
  }
  return result.trimmingCharacters(in: .whitespacesAndNewlines)
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

    // One call per utterance AND a fresh session per utterance. Apple's
    // on-device 3B model degrades as session context grows — after ~20
    // messages it starts ignoring polish instructions and returning the
    // input unchanged. Fresh sessions keep each call's context to just
    // (system instructions + one utterance), which gives consistent
    // polish quality across the full transcript.
    //
    // Low temperature (0.2) keeps output deterministic. Surrounding
    // utterances go in the instructions, not the user message, so the
    // polish target stays unambiguous.
    let options = GenerationOptions(temperature: 0.2)
    var polished: [String] = payload.utterances.map { $0.text }

    let total = payload.utterances.count
    for (idx, utterance) in payload.utterances.enumerated() {
      // Emit progress to stderr so the TS caller can surface it in toasts.
      // Format is parseable: "PROGRESS <current>/<total>".
      writeStderr("PROGRESS \(idx + 1)/\(total)\n")

      let original = utterance.text
      if original.trimmingCharacters(in: .whitespaces).isEmpty { continue }

      var contextualInstructions = instructions
      let prev = idx > 0 ? payload.utterances[idx - 1].text : nil
      let next = idx < payload.utterances.count - 1 ? payload.utterances[idx + 1].text : nil
      if prev != nil || next != nil {
        contextualInstructions += "\n\nFor context, here are the surrounding "
        contextualInstructions += "utterances. DO NOT polish or include them in "
        contextualInstructions += "your response — they are only to help you "
        contextualInstructions += "understand the conversation rhythm."
        if let prev = prev {
          contextualInstructions += "\n\nPrevious utterance: \(prev)"
        }
        if let next = next {
          contextualInstructions += "\n\nNext utterance: \(next)"
        }
      }

      let session = LanguageModelSession(instructions: contextualInstructions)
      do {
        let response = try await session.respond(to: original, options: options)
        let candidate = response.content
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty { continue }

        // Word-preservation check: polish must contain exactly the same
        // word sequence as the original. If it doesn't, try a merge that
        // splices missing original words back in and drops hallucinations
        // (see mergePolishedPunctuation). Falls back to original text if
        // the merge can't reconcile.
        if wordTokens(original) == wordTokens(candidate) {
          polished[idx] = candidate
        } else {
          let merged = mergePolishedPunctuation(original: original, polished: candidate)
          if wordTokens(merged) == wordTokens(original) {
            writeStderr("Polish merged (word mismatch recovered) on utterance \(idx)\n")
            polished[idx] = merged
          } else {
            writeStderr("Polish rejected (merge failed) on utterance \(idx)\n")
          }
        }
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
