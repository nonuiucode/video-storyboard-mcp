# video-storyboard-mcp

[中文文档](README.zh.md)

Portable **MCP server**, **CLI**, and **Antigravity plugin** built on vendored [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) (`v0.7.6`, Apache-2.0). Watch long local or online videos (Bilibili, YouTube, etc.) in **Antigravity, Claude Code, Cursor, Gemini CLI, or Codex** using a single compact storyboard image + timestamped transcript, with zero third-party npm dependencies.

## Features

- **Variable-Tier Scene Storyboards (`1/1`..`1/8`)**: One representative frame per shot, scaled by cut-point density (`1/1` for long takes, `1/8` for rapid cuts) and DP row-packed onto tightly cropped canvases (~222 vision tokens per default sheet).
- **Audio + Multi-Source Transcript Alignment**: Renders a bottom loudness waveform strip (`audio="present"`) and resolves transcripts cleanly from site CC subtitles, embedded subtitle tracks, local ASR, or targeted burned-in RapidOCR.
- **Built-In Offline `sherpa-onnx` ASR Lifecycle**: Includes a zero-framework stdlib HTTP ASR server (`server/asr_server.py`) and one-command installer (`setup-asr`) supporting **SenseVoice** (`zh`/`en`/`ja`/`ko`/`yue`) and **Paraformer** + **Silero VAD** with automatic launch and 5-second idle shutdown.
- **Native Clip & Cache Hygiene Extensions**: Adds `video_clip` (export short `.mp4`/`.mp3` slices for native multimodal inspection) and `video_cache_clean` (wipe downloaded video caches after watching).
- **Bilibili Proxy Split & Error Surfacing**: Automatically routes domestic Bilibili hosts (`bilibili.com`, `b23.tv`, `bilivideo.com`, `hdslb.com`) around `HTTP_PROXY`/`HTTPS_PROXY` while preserving proxies for international CDNs, with `--proxy ""` fallback.

## 8 Tools Exposed Over MCP & CLI

| Tool | Purpose | Image Tokens |
|---|---|---|
| `video_probe` | Inspect duration, resolution, FPS, tracks, and available link heights (no download) | `0` |
| `video_storyboard` | Generate variable-tier DP-packed storyboard sheet(s) + aligned transcript + `dryRun` estimator | ~222 / sheet |
| `video_zoom` | Re-read a `cellId` or `[from, to]` window at higher resolution | ~222 |
| `video_locate` | Fuzzy search spoken transcript lines to find exact timestamps | `0` |
| `video_subtitles` | Crop the burned-in subtitle band vertically across timestamps into one strip image | ~222 |
| `video_help` | Print the upstream parameter, strategy, `tierMap`, and cost manual | `0` |
| `video_clip` | Export trimmed `.mp4` or `.mp3` slice (max 90s) for native inspection | `0` |
| `video_cache_clean` | Delete cached downloaded videos, clips, and preview images | `0` |

## Prerequisites

- **Node.js `>= 20`**
- **`ffmpeg` + `ffprobe`** (`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`)
- **`yt-dlp`** (optional, for URLs such as Bilibili / YouTube: `pip install --user -U yt-dlp`)
- **Python `>= 3.9`** (optional, for `setup-asr` offline speech transcription and optional `rapidocr` hard-subtitle checking)

## 3-Step Quick Start

### 1. Install into Antigravity or print your MCP config

```bash
# Antigravity global plugin (~/.gemini/config/plugins/video-storyboard/)
node scripts/install.mjs --antigravity-global

# Or install into a specific workspace (.agents/plugins/video-storyboard/)
node scripts/install.mjs --antigravity-workspace /path/to/workspace

# Or print ready-to-paste MCP config for Claude Code / Cursor / Gemini CLI / Codex
node scripts/install.mjs --print-mcp
```

### 2. Run diagnostics

```bash
node server/cli.mjs doctor
```

### 3. (Optional) Enable offline speech transcription (`sherpa-onnx`)

By default, videos without subtitle tracks report visual storyboards cleanly without transcribing audio (`asr-status` shows not configured). To add free offline transcription (downloads ~156 MB SenseVoice int8 + Silero VAD into `.asr-runtime/`):

```bash
# Preview exact URLs and paths without downloading
node server/cli.mjs setup-asr --dry-run

# Install local sherpa-onnx + SenseVoice int8 + Silero VAD and configure auto-lifecycle
node server/cli.mjs setup-asr

# Check active ASR state
node server/cli.mjs asr-status
```

> Uses `DSH_ASR_FALLBACK_CONFIG` when neither `~/.dsh/asr.json` nor `$DSH_HOME/asr.json` exists, so any existing user ASR config takes precedence automatically.

## CLI Examples

```bash
node server/cli.mjs probe "https://b23.tv/..." --allow-anonymous
node server/cli.mjs storyboard "/path/to/video.mp4" --strategy auto
node server/cli.mjs zoom "/path/to/video.mp4" --cell 2
node server/cli.mjs locate "/path/to/video.mp4" "keyword"
node server/cli.mjs subtitles "/path/to/video.mp4" --max-strips 12
node server/cli.mjs clip "/path/to/video.mp4" --cell 2 --audio-only
node server/cli.mjs clean --all --include-scan-cache
```

## Notes on Auth Cookies & Cost

- Anonymous Bilibili/YouTube links may be capped or rate-limited (`HTTP 403` / `567`). For higher bitrates or platform CC tracks, export a Netscape `cookies.txt` and configure `{"cookies": "/path/to/cookies.txt"}` in `~/.dsh/video.json` (or pass `--cookies`). Never commit `cookies.txt` to version control.
- Use `video_probe` first and `dryRun: true` on long videos before committing sheets. Use `from` + `segment: 300` to scan long videos in 5-minute windows.

## Running Tests

```bash
npm test
```

Includes offline smoke coverage for MCP stdio JSON-RPC (`8` tools), `setup-asr --dry-run`, `install.mjs --print-mcp`, and end-to-end `asr_server.py --mock` auto-launch + transcription + idle shutdown.

## Attribution & License

Licensed under the **Apache License, Version 2.0**. Built on vendored source from [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) (`v0.7.6`). See [LICENSE](LICENSE), [NOTICE](NOTICE), and [vendor/dsh-video-storyboard/CREDITS.md](vendor/dsh-video-storyboard/CREDITS.md) for upstream copyright, third-party credits, and documented modifications.
