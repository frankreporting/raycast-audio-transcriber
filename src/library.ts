import * as fs from "fs";
import * as path from "path";
import { getPreferenceValues } from "@raycast/api";
import { OutputFormat, Preferences, TranscriptResult } from "./types";
import { formatAsMarkdown, formatAsTxt, getExtension } from "./formatters";

const CANONICAL_SUFFIX = ".transcript.json";

export function getLibraryFolder(): string | null {
  const { transcriptsFolder } = getPreferenceValues<Preferences>();
  const folder = transcriptsFolder?.trim();
  return folder && folder.length > 0 ? folder : null;
}

function sanitize(s: string): string {
  // Keep alphanumerics, dashes, underscores, spaces, periods. Replace rest with _.
  return s.replace(/[^\w\-. ]+/g, "_").slice(0, 80) || "transcript";
}

function timestampSlug(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function canonicalFilename(result: TranscriptResult): string {
  const sourceBase = sanitize(
    path.basename(result.audioPath, path.extname(result.audioPath)),
  );
  return `${sourceBase}__${timestampSlug(result.createdAt)}${CANONICAL_SUFFIX}`;
}

// Writes the canonical JSON sidecar (machine-readable, source of truth for
// the Review Transcriptions browse command) plus a readable sibling in the
// user's chosen format if it's not JSON. Returns the canonical filepath, or
// null if no library folder is configured. Failures are swallowed —
// this is opportunistic and should never break the main flow.
export function saveCanonicalTranscript(
  result: TranscriptResult,
  preferredFormat?: OutputFormat,
): string | null {
  const folder = getLibraryFolder();
  if (!folder) return null;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const baseName = canonicalFilename(result).replace(CANONICAL_SUFFIX, "");
    const canonicalPath = path.join(folder, `${baseName}${CANONICAL_SUFFIX}`);
    const canonicalData = JSON.stringify(
      { ...result, createdAt: result.createdAt.toISOString() },
      null,
      2,
    );
    fs.writeFileSync(canonicalPath, canonicalData, "utf8");

    if (preferredFormat && preferredFormat !== "json") {
      const ext = getExtension(preferredFormat);
      const readablePath = path.join(folder, `${baseName}.transcript.${ext}`);
      const body =
        preferredFormat === "markdown"
          ? formatAsMarkdown(result)
          : formatAsTxt(result);
      fs.writeFileSync(readablePath, body, "utf8");
    }

    return canonicalPath;
  } catch (err) {
    console.error("Failed to save canonical transcript:", err);
    return null;
  }
}


export function loadCanonicalTranscript(filepath: string): TranscriptResult {
  const raw = fs.readFileSync(filepath, "utf8");
  const data = JSON.parse(raw) as TranscriptResult & { createdAt: string };
  return { ...data, createdAt: new Date(data.createdAt) };
}

export interface LibraryItem {
  filepath: string;
  result: TranscriptResult;
}

export function listLibrary(): LibraryItem[] {
  const folder = getLibraryFolder();
  if (!folder || !fs.existsSync(folder)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const items: LibraryItem[] = [];
  for (const name of entries) {
    if (!name.endsWith(CANONICAL_SUFFIX)) continue;
    const filepath = path.join(folder, name);
    try {
      const result = loadCanonicalTranscript(filepath);
      items.push({ filepath, result });
    } catch {
      // skip unreadable / malformed
    }
  }
  items.sort(
    (a, b) => b.result.createdAt.getTime() - a.result.createdAt.getTime(),
  );
  return items;
}

// Returns up to `limit` most-recent library items without parsing every JSON
// in the folder. Uses filesystem mtime to rank candidates first, then parses
// just the top N. For the menu bar's per-minute polling this matters when
// the library grows to hundreds of files.
export function listLibraryRecent(limit: number): LibraryItem[] {
  const folder = getLibraryFolder();
  if (!folder || !fs.existsSync(folder)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((name) => name.endsWith(CANONICAL_SUFFIX))
    .map((name) => {
      const filepath = path.join(folder, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filepath).mtimeMs;
      } catch {
        // best-effort
      }
      return { filepath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  const items: LibraryItem[] = [];
  for (const { filepath } of candidates) {
    try {
      const result = loadCanonicalTranscript(filepath);
      items.push({ filepath, result });
    } catch {
      // skip
    }
  }
  // Re-sort by authoritative createdAt (in case mtime drifted)
  items.sort(
    (a, b) => b.result.createdAt.getTime() - a.result.createdAt.getTime(),
  );
  return items;
}

export function deleteLibraryItem(filepath: string): void {
  // Also remove any sidecars (md/txt) that share the base name.
  for (const fp of findRelatedFiles(filepath)) {
    try {
      fs.unlinkSync(fp);
    } catch {
      // best-effort
    }
  }
}

// Given a canonical .transcript.json path, return all files in the library
// that belong to the same transcript (the JSON itself plus any .md/.txt
// sidecars). Existing files only — non-existent extensions are skipped.
export function findRelatedFiles(canonicalPath: string): string[] {
  const dir = path.dirname(canonicalPath);
  const stem = path
    .basename(canonicalPath)
    .replace(new RegExp(`${CANONICAL_SUFFIX.replace(/\./g, "\\.")}$`), "");
  const candidates = ["json", "md", "txt"];
  const found: string[] = [];
  for (const ext of candidates) {
    const fp = path.join(dir, `${stem}.transcript.${ext}`);
    if (fs.existsSync(fp)) found.push(fp);
  }
  return found;
}
