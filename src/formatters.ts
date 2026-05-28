import { TranscriptResult, SpeakerNameMap } from "./types";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function speakerLabel(speaker: string, nameMap?: SpeakerNameMap): string {
  if (nameMap && nameMap[speaker]) return nameMap[speaker];
  return `Speaker ${speaker}`;
}

export function formatAsTxt(
  result: TranscriptResult,
  nameMap?: SpeakerNameMap,
): string {
  return result.utterances
    .map((u) => `${speakerLabel(u.speaker, nameMap)}: ${u.text}`)
    .join("\n\n");
}

export function formatAsMarkdown(
  result: TranscriptResult,
  nameMap?: SpeakerNameMap,
): string {
  const header = [
    `# Transcript`,
    ``,
    `**Source:** \`${result.audioPath}\`  `,
    `**Duration:** ${formatTime(result.audioDurationSec * 1000)}  `,
    `**Transcribed:** ${result.createdAt.toISOString()}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const body = result.utterances
    .map((u) => {
      const time = formatTime(u.start);
      const name = speakerLabel(u.speaker, nameMap);
      return `**[${time}] ${name}:** ${u.text}`;
    })
    .join("\n\n");

  return header + body;
}

export function formatAsJson(
  result: TranscriptResult,
  nameMap?: SpeakerNameMap,
): string {
  const remapped = {
    ...result,
    createdAt: result.createdAt.toISOString(),
    utterances: result.utterances.map((u) => ({
      ...u,
      speakerLetter: u.speaker,
      speakerName: speakerLabel(u.speaker, nameMap),
    })),
  };
  return JSON.stringify(remapped, null, 2);
}

export function getExtension(format: "txt" | "markdown" | "json"): string {
  return format === "markdown" ? "md" : format;
}
