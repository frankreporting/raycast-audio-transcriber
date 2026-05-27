export type OutputFormat = "txt" | "markdown" | "json";

export interface Preferences {
  apiKey: string;
  defaultFormat: OutputFormat;
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
