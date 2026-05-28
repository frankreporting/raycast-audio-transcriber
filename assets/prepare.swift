// Prepare a canonical TranscriptResult from FluidAudio outputs.
//
// Reads asr.json + diar.json, merges word timings to speaker segments, and
// optionally polishes each utterance via Apple's on-device language model
// (FoundationModels framework, macOS 26+). Writes a single final.json that
// the Raycast extension can load instantly without any in-process work.
//
// This entire script runs inside the detached background shell so that
// transcription + diarization + polish all complete BEFORE the "done"
// flag fires — Raycast doesn't need to be open during any of it.
//
// Usage:
//   swift prepare.swift --asr <path> --diar <path> --output <path>
//                       --audio <path> --job-id <id> [--polish]
//
// Exit codes:
//   0 — success (final.json written)
//   1 — bad args, parse failure, or empty utterances
//   2 — --polish requested but FoundationModels unavailable; the script
//       still writes final.json without polish, so this is a soft warning

import Foundation

// ── Helpers ───────────────────────────────────────────────────────────

func writeStderr(_ s: String) {
  FileHandle.standardError.write(s.data(using: .utf8) ?? Data())
}

func wordCount(_ s: String) -> Int {
  return s.split(whereSeparator: { $0.isWhitespace }).count
}

// Extract a normalized word sequence: lowercase, letters and digits only.
// Apostrophes are IGNORED (neither part of words nor separators), so
// contractions match their bare form — "that's" and "thats" both
// tokenize to ["thats"]. This lets polish's apostrophe additions
// (e.g., "wouldnt" → "wouldn't") pass the word-preservation validator
// directly rather than getting kicked to the merge fallback. Punctuation,
// em-dashes, and whitespace remain separators.
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

// Word + its original-case surface form (e.g., {token: "wouldnt", surface: "wouldn't"}).
struct OrigWord {
  let token: String  // lowercase, letters/digits only
  let surface: String  // original substring as it appeared in source
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

// When polish drops or hallucinates words, fall back to a merge: walk
// through the polished string, accepting polish's words when they line up
// with the next original word (small lookahead allows for dropped words
// to be spliced back in mid-stream), and dropping polish words that don't
// match (hallucinations). Preserves all original words, keeps as much
// polish punctuation/casing as possible. Worst case the output reverts
// to the original text with no polish — still no content loss.
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
      // Read a polish word
      let wordStart = i
      while i < polished.endIndex,
        polished[i].isLetter || polished[i].isNumber || polished[i] == "'"
      {
        i = polished.index(after: i)
      }
      let polishWord = String(polished[wordStart..<i])
      let polishToken = wordTokens(polishWord).first ?? ""

      // Try to match against next few original words
      var matchedAt = -1
      let maxLookahead = min(lookahead, originalWords.count - origIdx)
      for k in 0..<maxLookahead {
        if originalWords[origIdx + k].token == polishToken {
          matchedAt = k
          break
        }
      }

      if matchedAt >= 0 {
        // Splice in any original words polish skipped over
        for k in 0..<matchedAt {
          if !result.isEmpty,
            let lastChar = result.last,
            !lastChar.isWhitespace
          {
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
      // else: polish word is a hallucination — drop it
    } else {
      // Non-word char (punctuation/whitespace) — emit as-is
      result.append(c)
      i = polished.index(after: i)
    }
  }

  // Any original words polish never reached — append them
  while origIdx < originalWords.count {
    if !result.isEmpty,
      let lastChar = result.last,
      !lastChar.isWhitespace
    {
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

func iso8601(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

// ── Models ────────────────────────────────────────────────────────────

struct AsrWordTiming: Codable {
  let word: String
  let startTime: Double
  let endTime: Double
}

struct AsrJSON: Codable {
  let text: String
  let durationSeconds: Double?
  let wordTimings: [AsrWordTiming]
}

struct DiarSegment: Codable {
  let speakerId: String
  let startTimeSeconds: Double
  let endTimeSeconds: Double
}

struct DiarJSON: Codable {
  let durationSeconds: Double?
  let segments: [DiarSegment]
}

struct Utterance: Codable {
  let speaker: String
  var text: String
  let start: Int  // ms
  var end: Int  // ms
}

struct TranscriptResult: Codable {
  let id: String
  let text: String
  let utterances: [Utterance]
  let audioPath: String
  let audioDurationSec: Double
  let createdAt: String  // ISO 8601
}

// ── Arg parsing ───────────────────────────────────────────────────────

var asrPath: String?
var diarPath: String?
var outputPath: String?
var audioPath: String?
var jobId: String?
var doPolish = false

let args = CommandLine.arguments
var i = 1
while i < args.count {
  switch args[i] {
  case "--asr":
    asrPath = i + 1 < args.count ? args[i + 1] : nil
    i += 2
  case "--diar":
    diarPath = i + 1 < args.count ? args[i + 1] : nil
    i += 2
  case "--output":
    outputPath = i + 1 < args.count ? args[i + 1] : nil
    i += 2
  case "--audio":
    audioPath = i + 1 < args.count ? args[i + 1] : nil
    i += 2
  case "--job-id":
    jobId = i + 1 < args.count ? args[i + 1] : nil
    i += 2
  case "--polish":
    doPolish = true
    i += 1
  default:
    i += 1
  }
}

guard let asrPath = asrPath, let diarPath = diarPath,
  let outputPath = outputPath, let audioPath = audioPath, let jobId = jobId
else {
  writeStderr("missing required args: --asr, --diar, --output, --audio, --job-id\n")
  exit(1)
}

// ── Read inputs ───────────────────────────────────────────────────────

guard let asrData = FileManager.default.contents(atPath: asrPath),
  let asr = try? JSONDecoder().decode(AsrJSON.self, from: asrData)
else {
  writeStderr("Failed to parse asr.json at \(asrPath)\n")
  exit(1)
}

guard let diarData = FileManager.default.contents(atPath: diarPath),
  let diar = try? JSONDecoder().decode(DiarJSON.self, from: diarData)
else {
  writeStderr("Failed to parse diar.json at \(diarPath)\n")
  exit(1)
}

// ── Build utterances (port of TS buildUtterances) ─────────────────────

let segments = diar.segments.sorted { $0.startTimeSeconds < $1.startTimeSeconds }

let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
let lettersArr = Array(letters)
var speakerMap: [String: String] = [:]
for seg in segments {
  if speakerMap[seg.speakerId] == nil {
    let idx = speakerMap.count
    let letter = idx < lettersArr.count ? String(lettersArr[idx]) : seg.speakerId
    speakerMap[seg.speakerId] = letter
  }
}

// Greedy char-position scan of each word in asr.text (case-insensitive)
struct WordPos {
  let start: String.Index
  let end: String.Index
}
let lowerText = asr.text.lowercased()
var wordPositions: [WordPos] = []
var cursor = lowerText.startIndex
for w in asr.wordTimings {
  let needle = w.word.lowercased()
  if let range = lowerText.range(of: needle, range: cursor..<lowerText.endIndex) {
    wordPositions.append(WordPos(start: range.lowerBound, end: range.upperBound))
    cursor = range.upperBound
  } else {
    wordPositions.append(WordPos(start: cursor, end: cursor))
  }
}

// Assign each word to a segment (containment, fallback to nearest by midpoint)
var wordSegIdx: [Int] = []
for w in asr.wordTimings {
  var idx = segments.firstIndex(where: {
    w.startTime >= $0.startTimeSeconds && w.startTime < $0.endTimeSeconds
  })
  if idx == nil {
    var bestDist = Double.infinity
    for (i, s) in segments.enumerated() {
      let mid = (s.startTimeSeconds + s.endTimeSeconds) / 2
      let d = abs(w.startTime - mid)
      if d < bestDist {
        bestDist = d
        idx = i
      }
    }
  }
  wordSegIdx.append(idx ?? -1)
}

// Per-segment: slice text from first to last matched word
var utterances: [Utterance] = []
for (segIdx, seg) in segments.enumerated() {
  var first: Int = -1
  var last: Int = -1
  for (i, sIdx) in wordSegIdx.enumerated() where sIdx == segIdx {
    if first == -1 { first = i }
    last = i
  }
  if first == -1 { continue }
  let text = String(asr.text[wordPositions[first].start..<wordPositions[last].end])
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { continue }
  utterances.append(
    Utterance(
      speaker: speakerMap[seg.speakerId] ?? seg.speakerId,
      text: text,
      start: Int((seg.startTimeSeconds * 1000).rounded()),
      end: Int((seg.endTimeSeconds * 1000).rounded())
    ))
}

// Merge consecutive same-speaker utterances
var merged: [Utterance] = []
for u in utterances {
  if var last = merged.last, last.speaker == u.speaker {
    last.text = "\(last.text) \(u.text)".trimmingCharacters(in: .whitespacesAndNewlines)
    last.end = u.end
    merged[merged.count - 1] = last
  } else {
    merged.append(u)
  }
}

if merged.isEmpty {
  writeStderr("No utterances produced (audio may be silent or too short)\n")
  exit(1)
}

// ── Optional polish ───────────────────────────────────────────────────

func writeFinal(_ utterances: [Utterance]) {
  let duration = asr.durationSeconds.flatMap { $0 > 0 ? $0 : nil } ?? diar.durationSeconds ?? 0
  let result = TranscriptResult(
    id: jobId,
    text: asr.text,
    utterances: utterances,
    audioPath: audioPath,
    audioDurationSec: duration,
    createdAt: iso8601(Date())
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  guard let data = try? encoder.encode(result) else {
    writeStderr("Failed to encode final.json\n")
    exit(1)
  }
  try? data.write(to: URL(fileURLWithPath: outputPath))
}

if !doPolish {
  writeFinal(merged)
  exit(0)
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
  func polish(_ inputs: [Utterance]) async -> [Utterance] {
    // CRITICAL: create a fresh LanguageModelSession per utterance instead
    // of reusing one across the whole transcript. Apple's on-device 3B
    // model degrades as the session's conversation history grows — after
    // ~20 messages of context it starts ignoring the polish instructions
    // and returning the input unchanged. Fresh sessions keep every call's
    // context to just (system instructions + single utterance), which
    // gives consistent polish quality across the full transcript.
    //
    // Low temperature (0.2) keeps output deterministic and reduces the
    // chance of the model "creatively" rewriting or adding words.
    //
    // Surrounding-utterance context goes in the instructions, not the
    // user message — model sees prev/next for rhythm but the polish
    // target is unambiguous (the single user message).
    let options = GenerationOptions(temperature: 0.2)
    var out = inputs
    let total = inputs.count
    for (idx, u) in inputs.enumerated() {
      writeStderr("PROGRESS \(idx + 1)/\(total)\n")
      let original = u.text
      if original.trimmingCharacters(in: .whitespaces).isEmpty { continue }

      var contextualInstructions = instructions
      let prev = idx > 0 ? inputs[idx - 1].text : nil
      let next = idx < inputs.count - 1 ? inputs[idx + 1].text : nil
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
        let candidate = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty { continue }

        // Word-preservation check: polish must contain exactly the same
        // word sequence as the original (only punctuation/casing may
        // differ). If the model dropped/hallucinated/reordered words,
        // attempt a merge that splices missing original words back in
        // and drops hallucinated additions. Preserves polish's
        // punctuation/casing where it lines up; falls back to original
        // text where it doesn't.
        if wordTokens(original) == wordTokens(candidate) {
          out[idx].text = candidate
        } else {
          let merged = mergePolishedPunctuation(original: original, polished: candidate)
          // Sanity-check the merge: word sequence must match the original.
          if wordTokens(merged) == wordTokens(original) {
            writeStderr("Polish merged (word mismatch recovered) on utterance \(idx)\n")
            out[idx].text = merged
          } else {
            writeStderr("Polish rejected (merge failed) on utterance \(idx)\n")
          }
        }
      } catch {
        writeStderr("Polish failed on utterance \(idx): \(error)\n")
      }
    }
    return out
  }

  if #available(macOS 26.0, *) {
    let sem = DispatchSemaphore(value: 0)
    var polished: [Utterance] = merged
    Task {
      polished = await polish(merged)
      sem.signal()
    }
    sem.wait()
    writeFinal(polished)
    exit(0)
  } else {
    writeStderr("FoundationModels requires macOS 26+, skipping polish\n")
    writeFinal(merged)
    exit(2)
  }
#else
  writeStderr("FoundationModels framework not available, skipping polish\n")
  writeFinal(merged)
  exit(2)
#endif
