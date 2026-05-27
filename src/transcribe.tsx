import { Form, ActionPanel, Action, showToast, Toast, useNavigation, getPreferenceValues } from "@raycast/api";
import { useState } from "react";
import { transcribeFile } from "./api";
import { ResultsView } from "./results";
import { OutputFormat, Preferences } from "./types";
import * as fs from "fs";

export default function TranscribeCommand() {
  const { push } = useNavigation();
  const prefs = getPreferenceValues<Preferences>();
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [format, setFormat] = useState<OutputFormat>(prefs.defaultFormat || "markdown");
  const [speakersExpected, setSpeakersExpected] = useState<string>("");
  const [keyterms, setKeyterms] = useState<string>(prefs.defaultKeyTerms || "");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    if (filePaths.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "Pick a file first" });
      return;
    }
    const filePath = filePaths[0];
    if (!fs.existsSync(filePath)) {
      await showToast({ style: Toast.Style.Failure, title: "File not found", message: filePath });
      return;
    }

    setIsLoading(true);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Transcribing...",
      message: "Uploading and processing. This usually takes 4-12 minutes for an hour of audio.",
    });

    try {
      const speakersNum = speakersExpected ? parseInt(speakersExpected, 10) : undefined;
      const keytermsList = keyterms
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const result = await transcribeFile({
        audioPath: filePath,
        speakersExpected: Number.isFinite(speakersNum) ? speakersNum : undefined,
        keytermsPrompt: keytermsList.length > 0 ? keytermsList : undefined,
        onStatusUpdate: (status) => {
          toast.message = status;
        },
      });

      toast.style = Toast.Style.Success;
      toast.title = "Transcription complete";
      toast.message = `${result.utterances.length} utterances`;

      push(<ResultsView result={result} initialFormat={format} />);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Always create a fresh toast — the animated one may have been dismissed
      // by the user while waiting, in which case mutating it silently does nothing.
      await showToast({ style: Toast.Style.Failure, title: "Transcription failed", message });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Transcribe" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="file"
        title="Audio or video file"
        allowMultipleSelection={false}
        canChooseDirectories={false}
        value={filePaths}
        onChange={setFilePaths}
      />
      <Form.Dropdown id="format" title="Output format" value={format} onChange={(v) => setFormat(v as OutputFormat)}>
        <Form.Dropdown.Item value="markdown" title="Markdown with timestamps" />
        <Form.Dropdown.Item value="txt" title="Plain text (Speaker A: ...)" />
        <Form.Dropdown.Item value="json" title="Raw JSON" />
      </Form.Dropdown>
      <Form.TextField
        id="speakers"
        title="Speakers expected (optional)"
        placeholder="e.g. 2"
        info="Enter a single number (e.g. 2). Helps diarization. Leave blank for auto-detect."
        value={speakersExpected}
        onChange={setSpeakersExpected}
      />
      {prefs.transcriptionBackend !== "parakeet" && (
        <Form.TextArea
          id="keyterms"
          title="Key terms (optional)"
          placeholder="Hechinger, Nichole Dobo, Vaughn Wallace, edtech"
          info="Comma-separated proper nouns, names, and domain terms. Boosts transcription accuracy. Up to 1,000 terms."
          value={keyterms}
          onChange={setKeyterms}
        />
      )}
    </Form>
  );
}
