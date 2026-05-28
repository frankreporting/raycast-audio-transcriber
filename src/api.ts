import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AssemblyAI } from "assemblyai";
import { getPreferenceValues } from "@raycast/api";
import {
  ParakeetJob,
  ParakeetJobStatus,
  Preferences,
  TranscriptResult,
  Utterance,
} from "./types";

const execFileAsync = promisify(execFile);

export interface TranscribeOptions {
  audioPath: string;
  speakersExpected?: number;
  keytermsPrompt?: string[];
  onStatusUpdate?: (status: string) => void;
}

// Phase 1.5 adds LocalParakeetBackend behind this interface.
export interface TranscriptionBackend {
  readonly name: string;
  transcribe(opts: TranscribeOptions): Promise<TranscriptResult>;
}

// --- AssemblyAI backend ---

function getAssemblyAIClient(): AssemblyAI {
  const { apiKey } = getPreferenceValues<Preferences>();
  if (!apiKey) {
    throw new Error(
      "AssemblyAI API key is not set. Add it in Raycast → Preferences → Extensions → Audio Transcriber.",
    );
  }
  return new AssemblyAI({ apiKey });
}

export class AssemblyAIBackend implements TranscriptionBackend {
  readonly name = "AssemblyAI (cloud)";

  async transcribe(opts: TranscribeOptions): Promise<TranscriptResult> {
    const client = getAssemblyAIClient();

    opts.onStatusUpdate?.("Uploading file...");

    const transcript = await client.transcripts.transcribe({
      audio: opts.audioPath,
      speech_models: ["universal-3-pro", "universal-2"],
      speaker_labels: true,
      ...(opts.speakersExpected
        ? { speakers_expected: opts.speakersExpected }
        : {}),
      ...(opts.keytermsPrompt && opts.keytermsPrompt.length > 0
        ? { keyterms_prompt: opts.keytermsPrompt }
        : {}),
    } as Parameters<typeof client.transcripts.transcribe>[0]);

    if (transcript.status === "error") {
      throw new Error(
        transcript.error || "AssemblyAI returned an error status",
      );
    }

    if (!transcript.utterances || transcript.utterances.length === 0) {
      throw new Error(
        "No utterances returned. The audio may be silent or too short.",
      );
    }

    const utterances: Utterance[] = transcript.utterances.map((u) => ({
      speaker: u.speaker ?? "?",
      text: u.text ?? "",
      start: u.start ?? 0,
      end: u.end ?? 0,
    }));

    return {
      id: transcript.id,
      text: transcript.text || "",
      utterances,
      audioPath: opts.audioPath,
      audioDurationSec: transcript.audio_duration || 0,
      createdAt: new Date(),
    };
  }
}

// --- Local Parakeet backend ---

// Parakeet's diarizer emits a separate segment whenever there's a pause,
// so a single speaker's monologue often arrives as many short segments.
// Collapse consecutive segments by the same speaker into one utterance:
// timestamps span the full range, text is joined with a space.
function mergeConsecutiveSpeakers(utterances: Utterance[]): Utterance[] {
  const merged: Utterance[] = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === u.speaker) {
      last.text = `${last.text} ${u.text}`.trim();
      last.end = u.end;
    } else {
      merged.push({ ...u });
    }
  }
  return merged;
}

// Build utterances by slicing the model's clean top-level text instead of
// joining word tokens. FluidAudio's `text` field is the source of truth
// for spacing/punctuation/casing; `wordTimings` give us per-word time
// markers we use to find where each speaker segment maps into the text.
//
// Words that fall in time gaps between diarization segments (mismatched
// boundaries between ASR and diarization models) get assigned to the
// nearest segment by midpoint distance — without this they're silently
// dropped, which leaves visible word-shaped holes in the transcript.
function buildUtterances(
  asrData: FluidTranscriptJSON,
  diarData: FluidDiarizationJSON,
): Utterance[] {
  const segments = [...diarData.segments].sort(
    (a, b) => a.startTimeSeconds - b.startTimeSeconds,
  );
  if (segments.length === 0) return [];

  // Map raw speakerIds (first-seen order) to letters A, B, C…
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const speakerMap = new Map<string, string>();
  for (const seg of segments) {
    if (!speakerMap.has(seg.speakerId)) {
      speakerMap.set(
        seg.speakerId,
        letters[speakerMap.size] ?? seg.speakerId,
      );
    }
  }

  // Find character offset of each word in the top-level text via a greedy
  // case-insensitive scan. Words that can't be located (rare — only if
  // text is normalized differently than wordTimings) fall back to a
  // zero-length marker at the cursor.
  const wordPositions: Array<{ start: number; end: number }> = [];
  const lowerText = asrData.text.toLowerCase();
  let cursor = 0;
  for (const w of asrData.wordTimings) {
    const needle = w.word.toLowerCase();
    const found = lowerText.indexOf(needle, cursor);
    if (found >= 0) {
      wordPositions.push({ start: found, end: found + w.word.length });
      cursor = found + w.word.length;
    } else {
      wordPositions.push({ start: cursor, end: cursor });
    }
  }

  // Assign each word to a segment. First pass: word's startTime falls
  // inside the segment's window. Second pass (fallback): nearest segment
  // by midpoint — catches words that fall in inter-segment gaps.
  const wordSegIdx: number[] = [];
  for (const w of asrData.wordTimings) {
    let idx = segments.findIndex(
      (s) =>
        w.startTime >= s.startTimeSeconds && w.startTime < s.endTimeSeconds,
    );
    if (idx === -1) {
      let bestDist = Infinity;
      for (let i = 0; i < segments.length; i++) {
        const mid =
          (segments[i].startTimeSeconds + segments[i].endTimeSeconds) / 2;
        const d = Math.abs(w.startTime - mid);
        if (d < bestDist) {
          bestDist = d;
          idx = i;
        }
      }
    }
    wordSegIdx.push(idx);
  }

  // For each segment, slice asrData.text from the first matched word's
  // start char to the last matched word's end char. This preserves the
  // model's spacing and punctuation exactly.
  const utterances: Utterance[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    let first = -1;
    let last = -1;
    for (let i = 0; i < wordSegIdx.length; i++) {
      if (wordSegIdx[i] === segIdx) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) continue;
    const text = asrData.text
      .slice(wordPositions[first].start, wordPositions[last].end)
      .trim();
    if (text.length === 0) continue;
    utterances.push({
      speaker: speakerMap.get(seg.speakerId) ?? seg.speakerId,
      text,
      start: Math.round(seg.startTimeSeconds * 1000),
      end: Math.round(seg.endTimeSeconds * 1000),
    });
  }

  return mergeConsecutiveSpeakers(utterances);
}

// Shape of fluidaudiocli transcribe --output-json <path>
interface FluidTranscriptJSON {
  text: string;
  durationSeconds?: number;
  wordTimings: Array<{
    word: string;
    startTime: number; // seconds
    endTime: number; // seconds
  }>;
}

// Shape of fluidaudiocli process --output <path>
interface FluidDiarizationJSON {
  durationSeconds: number;
  segments: Array<{
    speakerId: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
  }>;
}

export class LocalParakeetBackend implements TranscriptionBackend {
  readonly name = "Local Parakeet";

  async transcribe(opts: TranscribeOptions): Promise<TranscriptResult> {
    const { parakeetBinaryPath } = getPreferenceValues<Preferences>();
    const binary = parakeetBinaryPath?.trim();
    if (!binary) {
      throw new Error(
        "Parakeet binary path is not set. Build fluidaudiocli and set its path in Raycast → Preferences → Extensions → Audio Transcriber.",
      );
    }

    const tag = `raycast-${Date.now()}`;
    const asrOut = path.join(os.tmpdir(), `${tag}-asr.json`);
    const diarOut = path.join(os.tmpdir(), `${tag}-diar.json`);

    // FluidAudio logs heavily to stderr (especially during first-run model download).
    // Raise maxBuffer well above the default 1MB to avoid spurious ENOBUFS errors.
    const execOpts = { maxBuffer: 200 * 1024 * 1024 };

    const runStep = async (args: string[], stepName: string) => {
      try {
        await execFileAsync(binary, args, execOpts);
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr?.slice(-1000) ?? "";
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Parakeet ${stepName} failed: ${msg}${stderr ? `\n\n${stderr}` : ""}`,
        );
      }
    };

    try {
      opts.onStatusUpdate?.(
        "Transcribing locally… (first run downloads models, may take a few minutes)",
      );
      await runStep(
        [
          "transcribe",
          opts.audioPath,
          "--output-json",
          asrOut,
          "--word-timestamps",
        ],
        "transcription",
      );

      if (!fs.existsSync(asrOut)) {
        throw new Error(
          "Parakeet transcription produced no output. Check the binary path in preferences.",
        );
      }

      opts.onStatusUpdate?.("Identifying speakers…");
      // Offline mode runs VBx clustering over the whole audio at once —
      // significantly more accurate than streaming, which has to commit to
      // speaker assignments incrementally without full context. With
      // --num-speakers set, it's a hard constraint (vs. streaming's
      // --num-clusters, which is only a hint).
      await runStep(
        [
          "process",
          opts.audioPath,
          "--mode",
          "offline",
          "--output",
          diarOut,
          ...(opts.speakersExpected
            ? ["--num-speakers", String(opts.speakersExpected)]
            : []),
        ],
        "diarization",
      );

      if (!fs.existsSync(diarOut)) {
        throw new Error("Parakeet diarization produced no output.");
      }

      const asrData = JSON.parse(
        fs.readFileSync(asrOut, "utf8"),
      ) as FluidTranscriptJSON;
      const diarData = JSON.parse(
        fs.readFileSync(diarOut, "utf8"),
      ) as FluidDiarizationJSON;

      const utterances = buildUtterances(asrData, diarData);
      if (utterances.length === 0) {
        throw new Error(
          "No utterances produced. The audio may be silent or too short.",
        );
      }

      return {
        id: `local-${Date.now()}`,
        text: asrData.text,
        utterances,
        audioPath: opts.audioPath,
        audioDurationSec: asrData.durationSeconds ?? diarData.durationSeconds,
        createdAt: new Date(),
      };
    } finally {
      for (const f of [asrOut, diarOut]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
}

// --- Backend selection ---

// Phase 1: AssemblyAI. Phase 1.5: reads transcriptionBackend preference.
export function getBackend(): TranscriptionBackend {
  const { transcriptionBackend } = getPreferenceValues<Preferences>();
  if (transcriptionBackend === "parakeet") {
    return new LocalParakeetBackend();
  }
  return new AssemblyAIBackend();
}

export async function transcribeFile(
  opts: TranscribeOptions,
): Promise<TranscriptResult> {
  const { transcriptionBackend } = getPreferenceValues<Preferences>();

  if (transcriptionBackend === "parakeet-fallback") {
    try {
      return await new LocalParakeetBackend().transcribe(opts);
    } catch {
      opts.onStatusUpdate?.(
        "Local Parakeet failed, falling back to AssemblyAI...",
      );
      return await new AssemblyAIBackend().transcribe(opts);
    }
  }

  return getBackend().transcribe(opts);
}

// --- Background Parakeet jobs ---
//
// Raycast kills the extension process the moment the view is dismissed, which
// kills any child processes in its process group. To survive that, we write a
// shell script and spawn it detached (its own session via setsid-equivalent).
// fluidaudiocli runs to completion regardless, and we fire an osascript
// notification on done/error so the user knows to come back.

function shEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function getJobsRootDir(): string {
  const dir = path.join(
    os.homedir(),
    "Library",
    "Caches",
    "raycast-transcribe",
    "jobs",
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function startParakeetJob(opts: TranscribeOptions): ParakeetJob {
  const { parakeetBinaryPath, notifyOnComplete } =
    getPreferenceValues<Preferences>();
  const binary = parakeetBinaryPath?.trim();
  if (!binary) {
    throw new Error(
      "Parakeet binary path is not set. Build fluidaudiocli and set its path in Raycast → Preferences → Extensions → Audio Transcriber.",
    );
  }
  if (!fs.existsSync(binary)) {
    throw new Error(`Parakeet binary not found at: ${binary}`);
  }

  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jobDir = path.join(getJobsRootDir(), id);
  fs.mkdirSync(jobDir, { recursive: true });

  const asrOut = path.join(jobDir, "asr.json");
  const diarOut = path.join(jobDir, "diar.json");
  const doneFlag = path.join(jobDir, "done");
  const errorFlag = path.join(jobDir, "error");
  const logPath = path.join(jobDir, "run.log");
  const scriptPath = path.join(jobDir, "run.sh");

  // Offline mode runs VBx clustering with full audio context — much more
  // accurate than streaming, and --num-speakers is a hard constraint when set
  // (streaming's --num-clusters is only a hint).
  const numSpeakersArgs = opts.speakersExpected
    ? `--num-speakers ${shEscape(String(opts.speakersExpected))}`
    : "";

  // Strip double quotes from the basename — osascript embeds it in a "..."
  // string literal where unescaped quotes would break the AppleScript.
  const fileBasename = path.basename(opts.audioPath).replace(/"/g, "");
  const successMsg = `Transcription of ${fileBasename} is ready. Click to view in Raycast.`;
  const failureMsg = `Transcription of ${fileBasename} failed. Click to view error in Raycast.`;
  const deeplinkUrl =
    "raycast://extensions/brianfrank/audio-transcriber-for-raycast/transcribe";

  // The script:
  //   1. Adds Homebrew bin dirs to PATH so terminal-notifier (typically in
  //      /opt/homebrew/bin or /usr/local/bin) is reachable.
  //   2. Defines a `notify` helper that prefers terminal-notifier (Raycast
  //      icon + clickable) and falls back to osascript (Script Editor icon,
  //      no click action) if terminal-notifier isn't installed.
  //   3. Runs the two fluidaudiocli steps with output captured to a log file.
  //   4. Writes a done/error flag. If notifyOnComplete is enabled, fires a
  //      notification and deeplinks back into Raycast. Otherwise completes
  //      silently — the user checks Review Transcriptions when ready.
  // The whole thing runs detached so it survives Raycast death.
  const successAlert = notifyOnComplete
    ? `notify "Audio Transcriber" ${shEscape(successMsg)} "Glass"
  open ${shEscape(deeplinkUrl)} >/dev/null 2>&1 || true`
    : "";
  const failureAlert = notifyOnComplete
    ? `notify "Audio Transcriber" ${shEscape(failureMsg)} "Basso"
  open ${shEscape(deeplinkUrl)} >/dev/null 2>&1 || true`
    : "";

  const script = `#!/bin/sh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

notify() {
  # $1 = title, $2 = message, $3 = sound name
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier \\
      -sender com.raycast.macos \\
      -title "$1" \\
      -message "$2" \\
      -sound "$3" \\
      -open ${shEscape(deeplinkUrl)} \\
      >/dev/null 2>&1 || true
  else
    osascript -e "display notification \\"$2\\" with title \\"$1\\" sound name \\"$3\\"" >/dev/null 2>&1 || true
  fi
}

{
  ${shEscape(binary)} transcribe ${shEscape(opts.audioPath)} --output-json ${shEscape(asrOut)} --word-timestamps && \\
  ${shEscape(binary)} process ${shEscape(opts.audioPath)} --mode offline --output ${shEscape(diarOut)} ${numSpeakersArgs}
} > ${shEscape(logPath)} 2>&1

if [ $? -eq 0 ] && [ -f ${shEscape(asrOut)} ] && [ -f ${shEscape(diarOut)} ]; then
  touch ${shEscape(doneFlag)}
  ${successAlert}
else
  touch ${shEscape(errorFlag)}
  ${failureAlert}
fi
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const child = spawn("/bin/sh", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  // Disown so the parent (Raycast extension) doesn't wait on us.
  child.unref();

  return {
    id,
    audioPath: opts.audioPath,
    jobDir,
    asrOut,
    diarOut,
    doneFlag,
    errorFlag,
    logPath,
    speakersExpected: opts.speakersExpected,
    createdAt: Date.now(),
  };
}

export function getJobStatus(job: ParakeetJob): ParakeetJobStatus {
  if (fs.existsSync(job.doneFlag)) return "done";
  if (fs.existsSync(job.errorFlag)) return "error";
  return "running";
}

export function loadJobResult(job: ParakeetJob): TranscriptResult {
  const asrData = JSON.parse(
    fs.readFileSync(job.asrOut, "utf8"),
  ) as FluidTranscriptJSON;
  const diarData = JSON.parse(
    fs.readFileSync(job.diarOut, "utf8"),
  ) as FluidDiarizationJSON;

  const utterances = buildUtterances(asrData, diarData);
  if (utterances.length === 0) {
    throw new Error(
      "No utterances produced. The audio may be silent or too short.",
    );
  }

  return {
    id: job.id,
    text: asrData.text,
    utterances,
    audioPath: job.audioPath,
    audioDurationSec: asrData.durationSeconds ?? diarData.durationSeconds,
    createdAt: new Date(job.createdAt),
  };
}

export function loadJobErrorLog(job: ParakeetJob): string {
  try {
    const log = fs.readFileSync(job.logPath, "utf8").trim();
    return log.length > 0 ? log.slice(-2000) : "No error output captured.";
  } catch {
    return "No log file available.";
  }
}

export function cleanupJob(job: ParakeetJob): void {
  try {
    fs.rmSync(job.jobDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// A job that's been "running" for >2 hours has almost certainly crashed
// (longest realistic transcription on M-series is <10 min for an hour of audio).
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export function isJobStale(job: ParakeetJob): boolean {
  return Date.now() - job.createdAt > STALE_THRESHOLD_MS;
}
