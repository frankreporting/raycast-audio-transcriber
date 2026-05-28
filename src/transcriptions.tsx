import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  LocalStorage,
  showToast,
  Toast,
  Alert,
  confirmAlert,
  useNavigation,
  openExtensionPreferences,
  getApplications,
  getDefaultApplication,
  Application,
} from "@raycast/api";
import { useEffect, useState, useCallback } from "react";
import * as path from "path";
import {
  LibraryItem,
  deleteLibraryItem,
  findRelatedFiles,
  getLibraryFolder,
  listLibrary,
} from "./library";
import { ResultsView } from "./results";
import { OutputFormat, Preferences, TranscriptResult } from "./types";
import { getPreferenceValues } from "@raycast/api";

// Cache of { default, all } applications keyed by file extension. Same
// extension → same defaults, so we never look up twice in a session.
interface ExtApps {
  default: Application | null;
  all: Application[];
}
type AppMap = Record<string, ExtApps>;

// Tracks the last time the user opened Review Transcriptions. Anything with
// createdAt > this value gets a "New" badge. We capture the previous value
// for this session's render BEFORE bumping the stored timestamp, so the
// badge persists during the visit and clears on the next one.
const LAST_VISIT_KEY = "review-transcriptions-last-visit-ms";

async function readLastVisit(): Promise<number> {
  const raw = await LocalStorage.getItem<string>(LAST_VISIT_KEY);
  return raw ? parseInt(raw, 10) : 0;
}

async function writeLastVisit(ts: number): Promise<void> {
  await LocalStorage.setItem(LAST_VISIT_KEY, String(ts));
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "?";
  const totalSec = Math.floor(sec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function uniqueSpeakerCount(result: TranscriptResult): number {
  const set = new Set<string>();
  for (const u of result.utterances) set.add(u.speaker);
  return set.size;
}

function relativeDate(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString();
}

function labelForExtension(ext: string): string {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "md") return "Markdown";
  if (e === "txt") return "Plain Text";
  if (e === "json") return "JSON";
  return e.toUpperCase();
}

async function buildAppMap(items: LibraryItem[]): Promise<AppMap> {
  const map: AppMap = {};
  const seenExts = new Set<string>();
  for (const item of items) {
    for (const fp of findRelatedFiles(item.filepath)) {
      const ext = path.extname(fp).toLowerCase();
      if (seenExts.has(ext)) continue;
      seenExts.add(ext);
      try {
        const [def, all] = await Promise.all([
          getDefaultApplication(fp).catch(() => null),
          getApplications(fp).catch(() => [] as Application[]),
        ]);
        map[ext] = { default: def, all };
      } catch {
        map[ext] = { default: null, all: [] };
      }
    }
  }
  return map;
}

export default function TranscriptionsCommand() {
  const { push } = useNavigation();
  const prefs = getPreferenceValues<Preferences>();
  const folder = getLibraryFolder();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [appMap, setAppMap] = useState<AppMap>({});
  const [lastVisit, setLastVisit] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    const loaded = listLibrary();
    setItems(loaded);
    const map = await buildAppMap(loaded);
    setAppMap(map);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      // Capture the previous visit timestamp BEFORE updating it — that's the
      // cutoff we use to decide which items are "new" for this visit. On the
      // very first visit (no prior value), nothing is marked new.
      const prev = await readLastVisit();
      setLastVisit(prev);
      await writeLastVisit(Date.now());
      await reload();
    })();
  }, [reload]);

  if (!folder) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Folder}
          title="No transcripts library configured"
          description="Set a Transcripts library folder in extension preferences to enable this command."
          actions={
            <ActionPanel>
              <Action
                title="Open Extension Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search transcripts…">
      {items.length === 0 && !isLoading && (
        <List.EmptyView
          icon={Icon.Document}
          title="No transcripts yet"
          description={`Run the Transcribe command. Completed transcriptions will save to:\n${folder}`}
          actions={
            <ActionPanel>
              <Action.ShowInFinder path={folder} title="Open Library Folder" />
              <Action.OpenInBrowser
                url="raycast://extensions/brianfrank/audio-transcriber-for-raycast/transcribe"
                title="Run Transcribe Command"
                icon={Icon.Microphone}
              />
            </ActionPanel>
          }
        />
      )}
      {items.map((item) => (
        <TranscriptionItem
          key={item.filepath}
          item={item}
          appMap={appMap}
          isNew={lastVisit > 0 && item.result.createdAt.getTime() > lastVisit}
          defaultFormat={prefs.defaultFormat || "markdown"}
          onChange={reload}
          onOpen={() =>
            push(
              <ResultsView
                result={item.result}
                initialFormat={prefs.defaultFormat || "markdown"}
              />,
            )
          }
        />
      ))}
    </List>
  );
}

interface ItemProps {
  item: LibraryItem;
  appMap: AppMap;
  isNew: boolean;
  defaultFormat: OutputFormat;
  onOpen: () => void;
  onChange: () => void;
}

function TranscriptionItem({
  item,
  appMap,
  isNew,
  onOpen,
  onChange,
}: ItemProps) {
  const { result, filepath } = item;
  const sourceBase = path.basename(
    result.audioPath,
    path.extname(result.audioPath),
  );
  const speakerCount = uniqueSpeakerCount(result);
  const duration = formatDuration(result.audioDurationSec);
  const accessoryDate = relativeDate(result.createdAt);
  const accessories: List.Item.Accessory[] = isNew
    ? [{ tag: { value: "New", color: Color.Green } }, { text: accessoryDate }]
    : [{ text: accessoryDate }];

  const relatedFiles = findRelatedFiles(filepath);
  // Prefer readable formats (md, txt) over JSON when listing actions, so the
  // most-useful "Open" actions come first in the panel.
  const sortedFiles = [...relatedFiles].sort((a, b) => {
    const order = { ".md": 0, ".txt": 1, ".json": 2 } as Record<string, number>;
    const ea = path.extname(a).toLowerCase();
    const eb = path.extname(b).toLowerCase();
    return (order[ea] ?? 99) - (order[eb] ?? 99);
  });

  async function handleDelete() {
    const confirmed = await confirmAlert({
      title: `Delete "${sourceBase}"?`,
      message: `This will remove all files for this transcript from your library (${relatedFiles.length} file${relatedFiles.length === 1 ? "" : "s"}). The source audio file is not affected.`,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    try {
      deleteLibraryItem(filepath);
      await showToast({ style: Toast.Style.Success, title: "Deleted" });
      onChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await showToast({
        style: Toast.Style.Failure,
        title: "Delete failed",
        message,
      });
    }
  }

  return (
    <List.Item
      title={sourceBase}
      subtitle={`${result.utterances.length} utterances · ${speakerCount} speaker${
        speakerCount === 1 ? "" : "s"
      } · ${duration}`}
      accessories={accessories}
      icon={Icon.Waveform}
      actions={
        <ActionPanel>
          <Action title="Open Transcript" icon={Icon.Eye} onAction={onOpen} />
          {sortedFiles.map((fp) => {
            const ext = path.extname(fp).toLowerCase();
            const exts = appMap[ext];
            const formatLabel = labelForExtension(ext);
            return (
              <ActionPanel.Section key={fp} title={formatLabel}>
                {exts?.default && (
                  <Action.Open
                    title={`Open ${formatLabel} in ${exts.default.name}`}
                    target={fp}
                    application={exts.default}
                    icon={Icon.Pencil}
                  />
                )}
                {exts && exts.all.length > 0 && (
                  <ActionPanel.Submenu
                    title={`Open ${formatLabel} With…`}
                    icon={Icon.AppWindow}
                  >
                    {exts.all.map((app) => (
                      <Action.Open
                        key={app.bundleId ?? app.path}
                        title={app.name}
                        target={fp}
                        application={app}
                      />
                    ))}
                  </ActionPanel.Submenu>
                )}
                {(!exts || !exts.default) && (
                  <Action.Open
                    title={`Open ${formatLabel}`}
                    target={fp}
                    icon={Icon.Pencil}
                  />
                )}
              </ActionPanel.Section>
            );
          })}
          <ActionPanel.Section>
            <Action.ShowInFinder
              path={filepath}
              title="Reveal in Finder"
              shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
            />
            <Action.CopyToClipboard
              content={filepath}
              title="Copy File Path"
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Delete Transcript"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd"], key: "delete" }}
              onAction={handleDelete}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
