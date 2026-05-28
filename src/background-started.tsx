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
  startedAt: Date;
}

export function BackgroundStartedView({ audioPath, startedAt }: Props) {
  const { pop } = useNavigation();
  const { notifyOnComplete } = getPreferenceValues<Preferences>();

  const filename = path.basename(audioPath);
  const startedAtStr = startedAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const completionLine = notifyOnComplete
    ? `You can close Raycast. When done, you'll get a notification and Raycast will reopen to the result.`
    : `You can close Raycast. When done, the file will appear silently in your library — open **Review Transcriptions** to view it.`;

  const markdown = `# Transcribing in the background

**File:** \`${filename}\` · **Started:** ${startedAtStr}

${completionLine}

> To kill the job: \`pkill -f fluidaudiocli\`
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
