import { AssemblyAI } from "assemblyai";
import { getPreferenceValues } from "@raycast/api";
import { Preferences, TranscriptResult, Utterance } from "./types";

export interface TranscribeOptions {
  audioPath: string;
  speakersExpected?: number;
  keytermsPrompt?: string[];
  onStatusUpdate?: (status: string) => void;
}

// Phase 1.5 will add LocalParakeetBackend behind this same interface.
export interface TranscriptionBackend {
  readonly name: string;
  transcribe(opts: TranscribeOptions): Promise<TranscriptResult>;
}

function getAssemblyAIClient(): AssemblyAI {
  const { apiKey } = getPreferenceValues<Preferences>();
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

// Phase 1: always AssemblyAI. Phase 1.5 will read a preference here.
export function getBackend(): TranscriptionBackend {
  return new AssemblyAIBackend();
}

export async function transcribeFile(opts: TranscribeOptions): Promise<TranscriptResult> {
  const backend = getBackend();
  return backend.transcribe(opts);
}
