import { Detail, ActionPanel, Action, showToast, Toast, Clipboard, useNavigation } from "@raycast/api";
import { useState, useMemo } from "react";
import * as fs from "fs";
import * as path from "path";
import { formatAsTxt, formatAsMarkdown, formatAsJson, getExtension } from "./formatters";
import { OutputFormat, TranscriptResult, SpeakerNameMap } from "./types";
import { RenameSpeakersForm } from "./rename-speakers";

interface Props {
  result: TranscriptResult;
  initialFormat: OutputFormat;
}

export function ResultsView({ result, initialFormat }: Props) {
  const { push } = useNavigation();
  const [format, setFormat] = useState<OutputFormat>(initialFormat);
  const [nameMap, setNameMap] = useState<SpeakerNameMap>({});

  const formatted = useMemo(() => {
    if (format === "txt") return formatAsTxt(result, nameMap);
    if (format === "json") return formatAsJson(result, nameMap);
    return formatAsMarkdown(result, nameMap);
  }, [result, format, nameMap]);

  const detailMarkdown = useMemo(() => {
    if (format === "markdown") return formatted;
    if (format === "json") return "```json\n" + formatted + "\n```";
    return "```\n" + formatted + "\n```";
  }, [formatted, format]);

  function defaultSavePath(): string {
    const dir = path.dirname(result.audioPath);
    const base = path.basename(result.audioPath, path.extname(result.audioPath));
    return path.join(dir, `${base}.transcript.${getExtension(format)}`);
  }

  async function handleCopy() {
    await Clipboard.copy(formatted);
    await showToast({ style: Toast.Style.Success, title: "Copied to clipboard" });
  }

  async function handlePaste() {
    await Clipboard.paste(formatted);
  }

  async function handleSave() {
    const savePath = defaultSavePath();
    try {
      fs.writeFileSync(savePath, formatted, "utf8");
      await showToast({ style: Toast.Style.Success, title: "Saved", message: savePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Save failed", message });
    }
  }

  const uniqueSpeakers = useMemo(() => {
    const set = new Set<string>();
    result.utterances.forEach((u) => set.add(u.speaker));
    return Array.from(set).sort();
  }, [result]);

  return (
    <Detail
      markdown={detailMarkdown}
      navigationTitle={path.basename(result.audioPath)}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Output">
            <Action
              title="Copy to Clipboard"
              onAction={handleCopy}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            <Action
              title="Paste to Frontmost App"
              onAction={handlePaste}
              shortcut={{ modifiers: ["cmd"], key: "v" }}
            />
            <Action
              title="Save Next to Source File"
              onAction={handleSave}
              shortcut={{ modifiers: ["cmd"], key: "s" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Modify">
            <Action
              title="Rename Speakers"
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={() =>
                push(
                  <RenameSpeakersForm
                    speakers={uniqueSpeakers}
                    currentMap={nameMap}
                    onSubmit={(newMap) => setNameMap(newMap)}
                  />,
                )
              }
            />
            <Action
              title="Switch Format: Markdown"
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={() => setFormat("markdown")}
            />
            <Action
              title="Switch Format: Plain Text"
              shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
              onAction={() => setFormat("txt")}
            />
            <Action
              title="Switch Format: JSON"
              shortcut={{ modifiers: ["cmd", "shift"], key: "j" }}
              onAction={() => setFormat("json")}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
