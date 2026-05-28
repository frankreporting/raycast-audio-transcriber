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
    let session = LanguageModelSession(instructions: instructions)
    var out = inputs
    let total = inputs.count
    for (idx, u) in inputs.enumerated() {
      writeStderr("PROGRESS \(idx + 1)/\(total)\n")
      let original = u.text
      if original.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      do {
        let response = try await session.respond(to: original)
        let candidate = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if candidate.isEmpty { continue }
        let origCount = wordCount(original)
        let newCount = wordCount(candidate)
        if origCount > 0 {
          let drift = abs(Double(newCount - origCount)) / Double(origCount)
          if drift > 0.2 { continue }
        }
        out[idx].text = candidate
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
