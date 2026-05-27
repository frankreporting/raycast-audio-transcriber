# Audio Transcriber for Raycast

A [Raycast](https://www.raycast.com) extension that transcribes local audio and video files using [AssemblyAI](https://www.assemblyai.com), with speaker diarization, key-term boosting, and a few output formats.

Pick a file from disk, get back a clean transcript you can copy, paste, or save next to the source file. Speakers are labeled (`Speaker A`, `Speaker B`, ...) and can be renamed in-place.

## Heads up: this is not in the Raycast Store

This extension is distributed as source on GitHub, not through the Raycast Store. You install it by cloning this repo and registering it as a local extension with Raycast. The install is a one-time setup — once Raycast knows about it, you don't need to keep a dev server running. Details below.

## Requirements

- macOS with [Raycast](https://www.raycast.com) installed
- [Node.js](https://nodejs.org) 20.x or newer (`node --version` to check)
- An [AssemblyAI](https://www.assemblyai.com/dashboard) API key (free tier works fine for trying it out)

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
   - `⌘S` to save next to the source file as `<name>.transcript.{md,txt,json}`
   - `⌘R` to rename speakers (e.g., "Speaker A" → "Nichole")
   - `⌘⇧M` / `⌘⇧T` / `⌘⇧J` to switch between Markdown / Text / JSON live

## Configuration

Open Raycast → ⌘ + , → Extensions → Audio Transcriber for Raycast.

| Preference | What it does |
| --- | --- |
| **AssemblyAI API Key** | Required. Get one at [assemblyai.com/dashboard](https://www.assemblyai.com/dashboard). |
| **Default output format** | Which format the dropdown starts on. You can still switch per-transcript. |

## Notes & limitations

- The extension uploads your audio to AssemblyAI's API. If that's a problem for your use case, this isn't the right tool — a local-model backend is on the roadmap but not shipped.
- Very large video files (>1 GB) may time out during upload. Extract the audio first with `ffmpeg` if you hit this.
- AssemblyAI requires audio longer than ~160 ms.
- Cancelling a transcription mid-flight isn't supported in this version.

## License

MIT
