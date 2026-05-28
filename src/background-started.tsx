import {
  Detail,
  ActionPanel,
  Action,
  useNavigation,
  getPreferenceValues,
} from "@raycast/api";
import * as path from "path";
import { Preferences } from "./types";

interface Props {
  audioPath: string;
  jobId: string;
  startedAt: Date;
}

export function BackgroundStartedView({ audioPath, jobId, startedAt }: Props) {
  const { pop } = useNavigation();
  const { notifyOnComplete } = getPreferenceValues<Preferences>();

  const filename = path.basename(audioPath);
  const startedAtStr = startedAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const completionBlock = notifyOnComplete
    ? `When it's done:

- A macOS notification will pop up ("Transcription of ${filename} is ready").
- Raycast will reopen automatically and take you straight to the transcript.

If you'd rather come back manually, just reopen Raycast and run **Transcribe** again, or open **Review Transcriptions** — both detect completed jobs and load them.

### What about errors?

If something goes wrong, you'll get a notification telling you so, and reopening Transcribe will show the last few lines of the run log.`
    : `When it's done, it'll show up silently in your library — no notification, no auto-open. **Open Review Transcriptions periodically** to check on it (newest is at the top).

If you'd prefer a system notification + auto-open instead, turn on **Alert when background transcription completes** in extension preferences.

### What about errors?

Errors are also silent by default — reopening Transcribe shows the last few lines of the run log for any failed jobs.`;

  const markdown = `# Transcribing in the background

**File:** \`${filename}\`
**Started:** ${startedAtStr}
**Job ID:** \`${jobId}\`

---

Your transcription is now running on-device. **You can safely close Raycast** — it will keep going.

${completionBlock}

---

### Want to kill the job?

Quit it from Terminal: \`pkill -f fluidaudiocli\`
`;

  return (
    <Detail
      markdown={markdown}
      navigationTitle="Transcription started"
      actions={
        <ActionPanel>
          <Action title="Start Another Transcription" onAction={pop} />
        </ActionPanel>
      }
    />
  );
}
