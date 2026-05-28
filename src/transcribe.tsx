import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  useNavigation,
  getPreferenceValues,
  LocalStorage,
  Alert,
  confirmAlert,
  openExtensionPreferences,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
  cleanupJob,
  getJobStatus,
  isJobStale,
  loadJobErrorLog,
  loadJobResult,
  startParakeetJob,
  transcribeFile,
} from "./api";
import { ResultsView } from "./results";
import { BackgroundStartedView } from "./background-started";
import { getLibraryFolder, saveCanonicalTranscript } from "./library";
import { OutputFormat, ParakeetJob, Preferences } from "./types";
import * as fs from "fs";
import * as path from "path";

const JOBS_KEY = "parakeet-jobs";

async function readJobs(): Promise<ParakeetJob[]> {
  const raw = await LocalStorage.getItem<string>(JOBS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ParakeetJob[];
  } catch {
    return [];
  }
}

async function writeJobs(jobs: ParakeetJob[]): Promise<void> {
  await LocalStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
}

// Prompt the user to set a transcripts library folder. Bouncing through
// Raycast's preferences panel is the only way — extensions can't write to
// their own preferences directly.
async function promptForLibraryFolder(): Promise<void> {
  await confirmAlert({
    title: "Set a transcripts library folder?",
    message:
      "Every successful transcription will auto-save here as a JSON sidecar, so you can browse and re-export them later with the Review Transcriptions command.\n\nWithout a library folder, transcripts only save when you press ⌘S on the results view, and Review Transcriptions is empty.",
    primaryAction: {
      title: "Open Preferences",
      onAction: () => openExtensionPreferences(),
    },
    dismissAction: { title: "Not Now", style: Alert.ActionStyle.Cancel },
  });
}

export default function TranscribeCommand() {
  const { push } = useNavigation();
  const prefs = getPreferenceValues<Preferences>();
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [format, setFormat] = useState<OutputFormat>(
    prefs.defaultFormat || "markdown",
  );
  const [speakersExpected, setSpeakersExpected] = useState<string>("");
  const [keyterms, setKeyterms] = useState<string>(prefs.defaultKeyTerms || "");
  const [isLoading, setIsLoading] = useState(false);

  // On mount, check for any pending background jobs and surface their results.
  // Done jobs push ResultsView for the most recent; errored jobs show a toast;
  // running jobs show a quick status toast. Stale jobs get cleaned up silently.
  // Finally, if no library folder is configured and nothing else is demanding
  // attention, prompt the user to set one (so the Transcriptions browse command
  // becomes useful).
  useEffect(() => {
    (async () => {
      let pushedResult = false;

      const jobs = await readJobs();
      if (jobs.length > 0) {
        const fresh: ParakeetJob[] = [];
        const done: ParakeetJob[] = [];
        const errored: ParakeetJob[] = [];
        const running: ParakeetJob[] = [];

        for (const job of jobs) {
          const status = getJobStatus(job);
          if (status === "done") {
            done.push(job);
            fresh.push(job);
          } else if (status === "error") {
            errored.push(job);
            fresh.push(job);
          } else if (isJobStale(job)) {
            cleanupJob(job);
          } else {
            running.push(job);
            fresh.push(job);
          }
        }

        if (running.length > 0) {
          const n = running.length;
          await showToast({
            style: Toast.Style.Animated,
            title: `${n} transcription${n > 1 ? "s" : ""} running in background`,
            message: "You'll get a notification when complete.",
          });
        }

        if (errored.length > 0) {
          const job = errored[errored.length - 1];
          const log = loadJobErrorLog(job);
          await showToast({
            style: Toast.Style.Failure,
            title: `Transcription of ${path.basename(job.audioPath)} failed`,
            message: log.split("\n").slice(-3).join(" "),
          });
          for (const j of errored) {
            cleanupJob(j);
          }
          await writeJobs(
            fresh.filter((j) => !errored.some((e) => e.id === j.id)),
          );
        }

        if (done.length > 0) {
          const job = done[done.length - 1];
          try {
            const result = loadJobResult(job);
            const remaining = fresh.filter((j) => j.id !== job.id);
            await writeJobs(remaining);
            cleanupJob(job);
            saveCanonicalTranscript(result, format);
            push(<ResultsView result={result} initialFormat={format} />);
            pushedResult = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await showToast({
              style: Toast.Style.Failure,
              title: "Couldn't load completed transcription",
              message: msg,
            });
            cleanupJob(job);
            await writeJobs(fresh.filter((j) => j.id !== job.id));
          }
        } else if (errored.length === 0 && running.length === 0) {
          await writeJobs(fresh);
        }
      }

      // Don't prompt if we just pushed a result — wait for next mount.
      if (!pushedResult && !getLibraryFolder()) {
        await promptForLibraryFolder();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit() {
    if (filePaths.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Pick a file first",
      });
      return;
    }
    const filePath = filePaths[0];
    if (!fs.existsSync(filePath)) {
      await showToast({
        style: Toast.Style.Failure,
        title: "File not found",
        message: filePath,
      });
      return;
    }

    const speakersNum = speakersExpected
      ? parseInt(speakersExpected, 10)
      : undefined;
    const speakersExpectedFinal = Number.isFinite(speakersNum)
      ? speakersNum
      : undefined;

    // Parakeet-only mode runs in the background so it survives Raycast death.
    // AssemblyAI (cloud) and fallback mode keep the inline/sync flow — cloud
    // upload is fast enough that the window staying open isn't a problem.
    if (prefs.transcriptionBackend === "parakeet") {
      try {
        const job = startParakeetJob({
          audioPath: filePath,
          speakersExpected: speakersExpectedFinal,
        });
        const jobs = await readJobs();
        jobs.push(job);
        await writeJobs(jobs);

        setFilePaths([]);
        push(
          <BackgroundStartedView
            audioPath={filePath}
            startedAt={new Date(job.createdAt)}
          />,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await showToast({
          style: Toast.Style.Failure,
          title: "Couldn't start transcription",
          message,
        });
      }
      return;
    }

    setIsLoading(true);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Transcribing...",
      message:
        "Uploading and processing. This usually takes 4-12 minutes for an hour of audio.",
    });

    try {
      const keytermsList = keyterms
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const result = await transcribeFile({
        audioPath: filePath,
        speakersExpected: speakersExpectedFinal,
        keytermsPrompt: keytermsList.length > 0 ? keytermsList : undefined,
        onStatusUpdate: (status) => {
          toast.message = status;
        },
      });

      toast.style = Toast.Style.Success;
      toast.title = "Transcription complete";
      toast.message = `${result.utterances.length} utterances`;

      saveCanonicalTranscript(result, format);
      push(<ResultsView result={result} initialFormat={format} />);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Always create a fresh toast — the animated one may have been dismissed
      // by the user while waiting, in which case mutating it silently does nothing.
      await showToast({
        style: Toast.Style.Failure,
        title: "Transcription failed",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }

  const submitTitle =
    prefs.transcriptionBackend === "parakeet"
      ? "Start Transcription in Background"
      : "Transcribe";

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={submitTitle} onSubmit={handleSubmit} />
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
      <Form.Dropdown
        id="format"
        title="Output format"
        value={format}
        onChange={(v) => setFormat(v as OutputFormat)}
      >
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
