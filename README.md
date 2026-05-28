# Audio Transcriber for Raycast

A [Raycast](https://www.raycast.com) extension that transcribes local audio and video files with speaker diarization and a few output formats. Supports two backends: **AssemblyAI** (cloud, any Mac) and **Local Parakeet** (on-device via [FluidAudio](https://github.com/FluidInference/FluidAudio), Apple Silicon only).

Pick a file from disk, get back a clean transcript you can copy, paste, save, and browse later from a library folder. Speakers are labeled (`Speaker A`, `Speaker B`, ...) and can be renamed in-place.

**Commands shipped with this extension:**

- **Transcribe** — pick a file and transcribe it.
- **Review Transcriptions** — browse, reopen, re-export, and manage past transcripts in your library folder.
- **Transcription Status** (menu bar) — auto-appears in the menu bar while a background Parakeet job is running, hides itself when idle. Enable once in extension settings.

**Note: This is NOT in the Raycast Store.** You install it by cloning this repo and registering it as a local extension with Raycast. The install is a one-time setup. Details below.

## Requirements

- macOS with [Raycast](https://www.raycast.com) installed
- [Node.js](https://nodejs.org) 20.x or newer (`node --version` to check)
- **AssemblyAI backend:** an [AssemblyAI API key](https://www.assemblyai.com/dashboard) (free tier works)
- **Local Parakeet backend:** Apple Silicon (M1 or newer) + Xcode Command Line Tools (see below)

## Install

```bash
# 1. Clone the repo somewhere you'll keep it long-term.
#    Raycast references the extension from this folder on disk —
#    don't move or delete it after installing.
git clone https://github.com/frankreporting/raycast-audio-transcriber.git
cd raycast-audio-transcriber

# 2. Install dependencies.
npm install

# 3. Register the extension with Raycast.
#    This starts a dev session that adds the extension to Raycast.
npm run dev
```

When `npm run dev` is running, open Raycast and type **Transcribe**. The command should appear and be runnable. Once you've confirmed it works, **press `Ctrl+C` in the terminal to stop the dev session** — the extension stays installed and runnable in Raycast on its own. No background server required.

The first time you run the command, Raycast prompts for your AssemblyAI API key. Paste it once and it's stored in macOS Keychain via Raycast preferences.

### Updating later

```bash
cd raycast-audio-transcriber
git pull
npm install   # only needed if dependencies changed
npm run dev   # re-register, then Ctrl+C to stop
```

### Uninstalling

In Raycast, open the extension's settings (⌘ + , → Extensions → Audio Transcriber for Raycast → uninstall). Then delete the cloned folder if you want.

## Usage

1. Open Raycast and run **Transcribe**.
2. Pick an audio or video file (mp3, m4a, wav, mp4, mov, and most common formats).
3. Optionally:
   - Choose an output format (Markdown with timestamps, plain text, or raw JSON).
   - Tell it how many speakers to expect — helps diarization on ambiguous audio.
   - Paste a comma-separated list of **key terms** (names, brands, jargon). This significantly improves accuracy on proper nouns. Up to 1,000 terms.
4. Hit **Transcribe**. A toast shows progress; for an hour of audio, expect 4–12 minutes end-to-end.
5. On the results view:
   - `⌘C` to copy
   - `⌘V` to paste to the frontmost app
   - `⌘S` to save (to your library folder if set, otherwise next to the source file)
   - `⌘⇧R` to reveal the source file in Finder
   - `⌘R` to rename speakers (e.g., "Speaker A" → "Nichole")
   - `⌘⇧M` / `⌘⇧T` / `⌘⇧J` to switch between Markdown / Text / JSON live

## Transcriptions library

Set a **Transcripts library folder** in preferences and every successful transcription auto-saves there as two files:

- A canonical `.transcript.json` (the source of truth — what Review Transcriptions reads from)
- A readable `.transcript.md` or `.transcript.txt` sidecar in your default output format (skipped if your default is already JSON)

The first time you open Transcribe without a library folder set, you'll be prompted to choose one (or dismiss for that session). Once set, every successful run silently adds files — the manual `⌘S` save action in the results view is hidden because it's redundant.

Run the **Review Transcriptions** command to browse, reopen, re-export, or delete past transcripts. Each entry shows speaker count, utterance count, and duration, plus actions to:

- **Open Transcript** — load it back into the same rich results view as a fresh run (rename speakers, switch format, copy, etc.)
- **Open [Format] in [DefaultApp]** — opens each related file (md/txt/json) in your system default app for that file type (dynamically labeled, e.g. "Open Markdown in TextEdit")
- **Open [Format] With…** — submenu of every installed app that can open the file
- **Reveal in Finder**, **Copy File Path**, **Delete Transcript**

Items added since your last visit to Review Transcriptions get a green **New** tag so you can see what's fresh at a glance.

If you don't set a library folder, nothing auto-saves and **Review Transcriptions** shows a "configure folder" prompt.

### Menu bar status (auto-hides when idle)

The extension also ships a **Transcription Status** menu bar command. Enable it once in Raycast → ⌘ + , → Extensions → Audio Transcriber for Raycast → click the toggle next to Transcription Status. Once enabled, the menu bar:

- **Only appears when there's something happening** — a running transcription, a completed-but-unviewed result, or a failed job. When all your jobs have been opened (and transitioned to the library), the icon disappears completely from your menu bar.
- Polls once per minute and updates on its own (no need to click anything to refresh)
- Shows a count next to the icon: `2` for running, `✓ 1` for ready to view, `⚠ 1` for failed
- Click → dropdown listing in-flight jobs, completed-but-unviewed jobs, recent transcripts from your library, and quick actions (New Transcription, Review All, Open Library Folder, Preferences)
- Clicking a "ready" item opens Raycast → Transcribe to load the result; clicking a recent transcript opens the JSON file in your default editor

It pairs especially well with the silent-completion default — start a long Parakeet transcription, the icon appears in your menu bar to show it's working, and quietly disappears when you've handled the result.

## Configuration

Open Raycast → ⌘ + , → Extensions → Audio Transcriber for Raycast.

| Preference | What it does |
| --- | --- |
| **AssemblyAI API Key** | Get one at [assemblyai.com/dashboard](https://www.assemblyai.com/dashboard). Not needed if you only use the Local Parakeet backend. |
| **Default output format** | Which format the dropdown starts on. You can still switch per-transcript. |
| **Default key terms** | Comma-separated names/terms that pre-fill the Key terms field on every run. Edit per-transcription to override (e.g., remove "Vaughn Wallace" and add "Vaughan" for one interview). AssemblyAI only — ignored by Local Parakeet. |
| **Transcription backend** | AssemblyAI (paid, default), Local Parakeet, or Parakeet-with-AssemblyAI-fallback. |
| **Parakeet binary path** | Full path to the `fluidaudiocli` binary. Required for Local Parakeet. See below. |
| **Transcripts library folder** | Folder where every successful transcription auto-saves a JSON sidecar. Enables the **Review Transcriptions** browse command. Leave blank to keep the old "save next to source file" behavior with no library. |
| **Alert when background transcription completes** | Off by default — background Parakeet jobs complete silently and you check Review Transcriptions when you're ready. Turn on to get a macOS notification + auto-open Raycast. See the Local Parakeet section for `terminal-notifier` install notes. |
| **Polish Parakeet output (on-device)** | Off by default. When on, every Parakeet transcript is polished via Apple's on-device language model (FoundationModels framework) to add disfluency commas ("um", "ah"), em-dashes for self-corrections ("code coding" → "code—coding"), missing punctuation, and proper capitalization. Fully local — nothing leaves the machine, no API key, no cost. Requires macOS 26 Tahoe or later with Apple Intelligence enabled; on older macOS the setting silently no-ops. AssemblyAI already polishes server-side, so this only runs for Parakeet. |

## Local Parakeet backend (optional, Apple Silicon only)

The Local Parakeet backend runs transcription (NVIDIA Parakeet TDT v3) and speaker diarization entirely on your Mac — no audio leaves the machine. On an M-series chip it typically processes an hour of audio in under a minute.

**Requires:** Apple Silicon (M1 or newer). Does not work on Intel Macs.

### How it works (background mode)

Because Raycast kills its extension process the instant you dismiss the window, Parakeet transcriptions run as a **detached background job**:

1. Pick a file, hit **Start Transcription in Background**. A confirmation screen tells you what's happening.
2. Close Raycast and go do other work — `fluidaudiocli` keeps running on its own.
3. When it finishes, the transcript is silently added to your library. **Open Review Transcriptions periodically** to check on it (newest is at the top). If the job is still running when you reopen Transcribe, you'll see a "running in background" toast. If it errored, you'll see the last few lines of the log.

Multiple jobs run in parallel and surface one at a time as you reopen the command.

### Optional: completion alerts

If you'd rather get a heads-up the instant a job finishes instead of checking back, turn on **Alert when background transcription completes** in extension preferences. When enabled:

- A macOS system notification fires when the job is done.
- Raycast auto-opens to the result.

**Strongly recommended for that mode:** `brew install terminal-notifier`. If installed, the notification appears with the **Raycast icon** and clicking it takes you straight into Raycast. Without terminal-notifier, the extension falls back to `osascript` notifications (works, but they appear with the generic "Script Editor" icon and aren't clickable).

> The other two backend modes (**AssemblyAI** and **Parakeet w/ AssemblyAI fallback**) still use the inline/sync flow — cloud upload is fast enough that keeping Raycast open isn't a problem.

### 1. Install Xcode Command Line Tools

If you haven't already:

```bash
xcode-select --install
```

### 2. Build the FluidAudio CLI

Clone the FluidAudio repo somewhere permanent (don't delete it after building):

```bash
git clone https://github.com/FluidInference/FluidAudio.git ~/FluidAudio
cd ~/FluidAudio
swift build -c release
```

This takes a few minutes the first time. The binary ends up at:

```
~/FluidAudio/.build/release/fluidaudiocli
```

### 3. Configure Raycast

Open Raycast → ⌘ + , → Extensions → Audio Transcriber for Raycast and set:

- **Transcription backend** → `Local Parakeet (on-device, Apple Silicon)`
- **Parakeet binary path** → the full path to the binary from step 2. To get the exact path, run this in Terminal:
  ```bash
  echo ~/FluidAudio/.build/release/fluidaudiocli
  ```
  Copy that output and paste it into the preference field.

### 4. First run — model download

The first time you run a transcription with Parakeet, FluidAudio automatically downloads the required ML models (~500 MB) from Hugging Face. This happens once; subsequent runs use the cached models. Expect the first transcription to take longer than usual while models download.

### Updating FluidAudio later

```bash
cd ~/FluidAudio
git pull
swift build -c release
```

No Raycast changes needed — the binary path stays the same.

## Notes & limitations

- **AssemblyAI** uploads your audio to the cloud. Use Local Parakeet if that's a concern.
- **Key terms** (proper noun boosting) are only supported by the AssemblyAI backend; they're silently ignored on Local Parakeet.
- Very large video files (>1 GB) may time out during AssemblyAI upload. Extract the audio first with `ffmpeg` if you hit this.
- AssemblyAI requires audio longer than ~160 ms.
- Cancelling a transcription mid-flight isn't supported in this version. Detached Parakeet jobs continue even if you close Raycast — to kill one, run `pkill -f fluidaudiocli` in Terminal.
- Parakeet job state is stored in `~/Library/Caches/raycast-transcribe/jobs/`. Safe to delete that directory at any time; you'll only lose unviewed completed transcripts.

## License

MIT
