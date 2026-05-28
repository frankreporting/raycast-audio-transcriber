export type OutputFormat = "txt" | "markdown" | "json";

export type TranscriptionBackendPref =
  | "assemblyai"
  | "parakeet"
  | "parakeet-fallback";

export interface Preferences {
  apiKey: string;
  defaultFormat: OutputFormat;
  defaultKeyTerms: string;
  transcriptionBackend: TranscriptionBackendPref;
  parakeetBinaryPath: string;
  transcriptsFolder: string;
  notifyOnComplete: boolean;
  llmPolish: boolean;
}

export interface Utterance {
  speaker: string; // "A", "B", "C" from AssemblyAI
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
}

export interface TranscriptResult {
  id: string;
  text: string; // full plain transcript (no speaker labels)
  utterances: Utterance[];
  audioPath: string; // original file path on disk
  audioDurationSec: number;
  createdAt: Date;
}

// Maps "A" -> "Nickie", "B" -> "Christina", etc.
export type SpeakerNameMap = Record<string, string>;

// A detached Parakeet transcription job — survives Raycast extension death,
// rehydrated on the next form mount by checking flag files in jobDir.
export interface ParakeetJob {
  id: string;
  audioPath: string;
  jobDir: string;
  asrOut: string;
  diarOut: string;
  finalOut: string; // canonical TranscriptResult JSON written by prepare.swift
  doneFlag: string;
  errorFlag: string;
  logPath: string;
  speakersExpected?: number;
  createdAt: number; // epoch ms
}

export type ParakeetJobStatus = "running" | "done" | "error";
