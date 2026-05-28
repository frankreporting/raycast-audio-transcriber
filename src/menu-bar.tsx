import {
  MenuBarExtra,
  Icon,
  LocalStorage,
  launchCommand,
  LaunchType,
  openExtensionPreferences,
  open,
} from "@raycast/api";
import { useEffect, useState } from "react";
import * as path from "path";
import { cleanupJob, getJobStatus, isJobStale } from "./api";
import { listLibraryRecent, getLibraryFolder, LibraryItem } from "./library";
import { ParakeetJob } from "./types";

const JOBS_KEY = "parakeet-jobs";
const RECENT_LIMIT = 8;

interface JobBuckets {
  running: ParakeetJob[];
  ready: ParakeetJob[]; // done flag set but not yet handed off
  errored: ParakeetJob[];
}

async function classifyJobs(): Promise<JobBuckets> {
  const raw = await LocalStorage.getItem<string>(JOBS_KEY);
  if (!raw) return { running: [], ready: [], errored: [] };
  let jobs: ParakeetJob[];
  try {
    jobs = JSON.parse(raw);
  } catch {
    return { running: [], ready: [], errored: [] };
  }

  const running: ParakeetJob[] = [];
  const ready: ParakeetJob[] = [];
  const errored: ParakeetJob[] = [];
  const surviving: ParakeetJob[] = [];

  for (const job of jobs) {
    const status = getJobStatus(job);
    if (status === "done") {
      ready.push(job);
      surviving.push(job);
    } else if (status === "error") {
      errored.push(job);
      surviving.push(job);
    } else if (isJobStale(job)) {
      // Hasn't reported done/error in 2h — almost certainly crashed.
      cleanupJob(job);
    } else {
      running.push(job);
      surviving.push(job);
    }
  }

  // Persist the cleaned list (stale jobs dropped) but don't transition done
  // jobs — let the Transcribe form do that so it can push ResultsView.
  if (surviving.length !== jobs.length) {
    await LocalStorage.setItem(JOBS_KEY, JSON.stringify(surviving));
  }

  return { running, ready, errored };
}

function elapsed(since: number): string {
  const diff = Date.now() - since;
  const min = 60_000;
  const hr = 60 * min;
  if (diff < min) return `${Math.floor(diff / 1000)}s`;
  if (diff < hr) return `${Math.floor(diff / min)}m`;
  return `${Math.floor(diff / hr)}h`;
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString();
}

export default function MenuBarStatus() {
  const [buckets, setBuckets] = useState<JobBuckets>({
    running: [],
    ready: [],
    errored: [],
  });
  const [recent, setRecent] = useState<LibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const folder = getLibraryFolder();

  useEffect(() => {
    (async () => {
      const b = await classifyJobs();
      setBuckets(b);
      setRecent(folder ? listLibraryRecent(RECENT_LIMIT) : []);
      setIsLoading(false);
    })();
  }, []);

  const runningCount = buckets.running.length;
  const readyCount = buckets.ready.length;
  const erroredCount = buckets.errored.length;
  const totalPending = runningCount + readyCount + erroredCount;

  // Always render the menu bar icon — a passive indicator that the command
  // is enabled. When the queue is empty the icon is just the mic glyph; when
  // jobs are in flight or ready, a count appears alongside. (Earlier version
  // auto-hid when idle, but that made it impossible to tell "command is on
  // but nothing pending" from "command isn't enabled".)

  // Menu bar title: prioritize "ready/errored" cues over running counts
  // since those are actionable. Keep it short (menu bar real estate is small).
  let title: string | undefined;
  if (readyCount > 0) {
    title = `✓ ${readyCount}`;
  } else if (erroredCount > 0) {
    title = `⚠ ${erroredCount}`;
  } else if (runningCount > 0) {
    title = `${runningCount}`;
  }

  const tooltipParts: string[] = [];
  if (runningCount > 0)
    tooltipParts.push(
      `${runningCount} transcribing${runningCount === 1 ? "" : ""}`,
    );
  if (readyCount > 0) tooltipParts.push(`${readyCount} ready to view`);
  if (erroredCount > 0) tooltipParts.push(`${erroredCount} failed`);
  const tooltip =
    tooltipParts.length > 0
      ? `Audio Transcriber — ${tooltipParts.join(", ")}`
      : "Audio Transcriber";

  return (
    <MenuBarExtra
      icon={Icon.Microphone}
      title={title}
      tooltip={tooltip}
      isLoading={isLoading}
    >
      {buckets.running.length > 0 && (
        <MenuBarExtra.Section title="Transcribing">
          {buckets.running.map((job) => (
            <MenuBarExtra.Item
              key={job.id}
              icon={Icon.CircleProgress}
              title={path.basename(job.audioPath)}
              subtitle={`${elapsed(job.createdAt)} elapsed`}
            />
          ))}
        </MenuBarExtra.Section>
      )}

      {buckets.ready.length > 0 && (
        <MenuBarExtra.Section title="Ready to view">
          {buckets.ready.map((job) => (
            <MenuBarExtra.Item
              key={job.id}
              icon={Icon.CheckCircle}
              title={path.basename(job.audioPath)}
              subtitle="Click to open in Raycast"
              onAction={() =>
                launchCommand({
                  name: "transcribe",
                  type: LaunchType.UserInitiated,
                })
              }
            />
          ))}
        </MenuBarExtra.Section>
      )}

      {buckets.errored.length > 0 && (
        <MenuBarExtra.Section title="Failed">
          {buckets.errored.map((job) => (
            <MenuBarExtra.Item
              key={job.id}
              icon={Icon.XMarkCircle}
              title={path.basename(job.audioPath)}
              subtitle="Click to view error"
              onAction={() =>
                launchCommand({
                  name: "transcribe",
                  type: LaunchType.UserInitiated,
                })
              }
            />
          ))}
        </MenuBarExtra.Section>
      )}

      {recent.length > 0 && (
        <MenuBarExtra.Section title="Recent transcripts">
          {recent.map((item) => {
            const sourceBase = path.basename(
              item.result.audioPath,
              path.extname(item.result.audioPath),
            );
            return (
              <MenuBarExtra.Item
                key={item.filepath}
                icon={Icon.Waveform}
                title={sourceBase}
                subtitle={relativeTime(item.result.createdAt)}
                onAction={() => open(item.filepath)}
              />
            );
          })}
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.Microphone}
          title="New Transcription"
          onAction={() =>
            launchCommand({
              name: "transcribe",
              type: LaunchType.UserInitiated,
            })
          }
        />
        <MenuBarExtra.Item
          icon={Icon.List}
          title="Review All Transcripts"
          onAction={() =>
            launchCommand({
              name: "transcriptions",
              type: LaunchType.UserInitiated,
            })
          }
        />
        {folder && (
          <MenuBarExtra.Item
            icon={Icon.Folder}
            title="Open Library Folder"
            onAction={() => open(folder)}
          />
        )}
        <MenuBarExtra.Item
          icon={Icon.Gear}
          title="Extension Preferences"
          onAction={openExtensionPreferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
