import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AssemblyAI } from "assemblyai";
import { getPreferenceValues } from "@raycast/api";
import { Preferences, TranscriptResult, Utterance } from "./types";

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
    throw new Error("AssemblyAI API key is not set. Add it in Raycast → Preferences → Extensions → Audio Transcriber.");
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
      ...(opts.speakersExpected ? { speakers_expected: opts.speakersExpected } : {}),
      ...(opts.keytermsPrompt && opts.keytermsPrompt.length > 0
        ? { keyterms_prompt: opts.keytermsPrompt }
        : {}),
    } as Parameters<typeof client.transcripts.transcribe>[0]);

    if (transcript.status === "error") {
      throw new Error(transcript.error || "AssemblyAI returned an error status");
    }

    if (!transcript.utterances || transcript.utterances.length === 0) {
      throw new Error("No utterances returned. The audio may be silent or too short.");
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

// Shape of fluidaudiocli transcribe --output-json <path>
interface FluidTranscriptJSON {
  text: string;
  durationSeconds?: number;
  wordTimings: Array<{
    word: string;
    startTime: number; // seconds
    endTime: number;   // seconds
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
        "Parakeet binary path is not set. Build fluidaudiocli and set its path in Raycast → Preferences → Extensions → Audio Transcriber."
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
        throw new Error(`Parakeet ${stepName} failed: ${msg}${stderr ? `\n\n${stderr}` : ""}`);
      }
    };

    try {
      opts.onStatusUpdate?.("Transcribing locally… (first run downloads models, may take a few minutes)");
      await runStep(
        ["transcribe", opts.audioPath, "--output-json", asrOut, "--word-timestamps"],
        "transcription"
      );

      if (!fs.existsSync(asrOut)) {
        throw new Error("Parakeet transcription produced no output. Check the binary path in preferences.");
      }

      opts.onStatusUpdate?.("Identifying speakers…");
      await runStep(
        [
          "process", opts.audioPath,
          "--mode", "streaming",
          "--output", diarOut,
          ...(opts.speakersExpected ? ["--num-clusters", String(opts.speakersExpected)] : []),
        ],
        "diarization"
      );

      if (!fs.existsSync(diarOut)) {
        throw new Error("Parakeet diarization produced no output.");
      }

      const asrData = JSON.parse(fs.readFileSync(asrOut, "utf8")) as FluidTranscriptJSON;
      const diarData = JSON.parse(fs.readFileSync(diarOut, "utf8")) as FluidDiarizationJSON;

      // Map raw speakerIds (first-seen order) to letters A, B, C…
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const speakerMap = new Map<string, string>();
      const sorted = [...diarData.segments].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
      for (const seg of sorted) {
        if (!speakerMap.has(seg.speakerId)) {
          speakerMap.set(seg.speakerId, letters[speakerMap.size] ?? seg.speakerId);
        }
      }

      // Merge: for each speaker segment, collect words whose startTime falls in that window
      const utterances: Utterance[] = [];
      for (const seg of sorted) {
        const words = asrData.wordTimings.filter(
          (w) => w.startTime >= seg.startTimeSeconds && w.startTime < seg.endTimeSeconds
        );
        if (words.length === 0) continue;
        utterances.push({
          speaker: speakerMap.get(seg.speakerId) ?? seg.speakerId,
          text: words.map((w) => w.word).join(" "),
          start: Math.round(seg.startTimeSeconds * 1000),
          end: Math.round(seg.endTimeSeconds * 1000),
        });
      }

      if (utterances.length === 0) {
        throw new Error("No utterances produced. The audio may be silent or too short.");
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
        try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
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

export async function transcribeFile(opts: TranscribeOptions): Promise<TranscriptResult> {
  const { transcriptionBackend } = getPreferenceValues<Preferences>();

  if (transcriptionBackend === "parakeet-fallback") {
    try {
      return await new LocalParakeetBackend().transcribe(opts);
    } catch {
      opts.onStatusUpdate?.("Local Parakeet failed, falling back to AssemblyAI...");
      return await new AssemblyAIBackend().transcribe(opts);
    }
  }

  return getBackend().transcribe(opts);
}
