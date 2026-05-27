# Audio Transcriber for Raycast

A [Raycast](https://www.raycast.com) extension that transcribes local audio and video files with speaker diarization and a few output formats. Supports two backends: **AssemblyAI** (cloud, any Mac) and **Local Parakeet** (on-device via [FluidAudio](https://github.com/FluidInference/FluidAudio), Apple Silicon only).

Pick a file from disk, get back a clean transcript you can copy, paste, or save next to the source file. Speakers are labeled (`Speaker A`, `Speaker B`, ...) and can be renamed in-place.

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
   - `⌘S` to save next to the source file as `<name>.transcript.{md,txt,json}`
   - `⌘R` to rename speakers (e.g., "Speaker A" → "Nichole")
   - `⌘⇧M` / `⌘⇧T` / `⌘⇧J` to switch between Markdown / Text / JSON live

## Configuration

Open Raycast → ⌘ + , → Extensions → Audio Transcriber for Raycast.

| Preference | What it does |
| --- | --- |
| **AssemblyAI API Key** | Get one at [assemblyai.com/dashboard](https://www.assemblyai.com/dashboard). Not needed if you only use the Local Parakeet backend. |
| **Default output format** | Which format the dropdown starts on. You can still switch per-transcript. |
| **Default key terms** | Comma-separated names/terms that pre-fill the Key terms field on every run. Edit per-transcription to override (e.g., remove "Vaughn Wallace" and add "Vaughan" for one interview). AssemblyAI only — ignored by Local Parakeet. |
| **Transcription backend** | AssemblyAI (default), Local Parakeet, or Parakeet-with-AssemblyAI-fallback. |
| **Parakeet binary path** | Full path to the `fluidaudiocli` binary. Required for Local Parakeet. See below. |

## Local Parakeet backend (optional, Apple Silicon only)

The Local Parakeet backend runs transcription (NVIDIA Parakeet TDT v3) and speaker diarization entirely on your Mac — no audio leaves the machine. On an M-series chip it typically processes an hour of audio in under a minute.

**Requires:** Apple Silicon (M1 or newer). Does not work on Intel Macs.

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
- **Parakeet binary path** → `/Users/yourname/FluidAudio/.build/release/fluidaudiocli`

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
- Cancelling a transcription mid-flight isn't supported in this version.

## License

MIT
