---
name: video-storyboard
description: "Watch Bilibili/YouTube/local videos efficiently via vendored SAOS-3624/dsh-video-storyboard v0.7.6 (video_probe, video_storyboard with 1/1..1/8 shot tiers & DP row packing, video_zoom, video_locate, video_subtitles, video_help) plus video_clip and mandatory video_cache_clean."
---

# Video Storyboard

Token-efficient, scene-aware video watching for MCP clients & Antigravity, built on `SAOS-3624/dsh-video-storyboard` (`v0.7.6`, Apache-2.0), with dual **Summary (`summary`) vs Lecture Notes (`lecture`)** presets, untruncated transcript extraction (`video_transcript`), optional offline `sherpa-onnx` ASR, trimmed clip inspection (`video_clip`), and post-watch cache cleanup (`video_cache_clean`).

## Tools (9)

1. **`video_probe`** — Read container/link metadata (duration, resolution, FPS, tracks, available heights) with **zero image tokens** and without downloading.
2. **`video_transcript`** — Extract **untruncated** timestamped (or grouped plain-text) transcripts for lectures and long courses (`0` image tokens, skips decoding/cuts, auto-pages >30m videos at 1200s or exports `full: true` + `saveFile: true` `.md`, reuses site CC / embedded subs / cached or local ASR).
3. **`video_storyboard`** — Variable-tier (`1/1`..`1/8`) DP row-packed storyboard sheets + aligned transcript + `dryRun` estimator. Supports `preset: "summary"` (default, lowest token cost) or `preset: "lecture"` (auto-applies `detail: "high"`, `ocr: true`, `quality: "medium"`).
4. **`video_zoom`** — Close-up re-read of a `cellId` or `[from, to]` interval at higher per-cell resolution (essential for lecture formulas, code, and dense slides).
5. **`video_locate`** — Pure-text fuzzy phrase search returning timestamped matches (`zero image tokens`).
6. **`video_subtitles`** — Crop the burned-in subtitle band across time intervals and stack strips vertically into one timestamped image.
7. **`video_help`** — Print the upstream parameter, strategy, tier, and token cost manual (`zero image tokens`).
8. **`video_clip`** — Export a short trimmed `.mp4` or audio-only `.mp3` snippet (capped at 90s) for native `read_file` inspection.
9. **`video_cache_clean`** — Remove cached downloaded videos, exported transcripts, clips, and preview images after finishing.

## CLI Usage

Run commands from `<plugin-dir>`:

```bash
node server/cli.mjs doctor
node server/cli.mjs setup-asr --dry-run
node server/cli.mjs probe "<source>" --allow-anonymous
node server/cli.mjs transcript "<source>" --allow-anonymous --save-file
node server/cli.mjs storyboard "<source>" --allow-anonymous --preset summary
node server/cli.mjs storyboard "<source>" --allow-anonymous --preset lecture --from 0 --segment 600
node server/cli.mjs clean --all --include-scan-cache
```

## Two-Mode Workflow (Summary vs Lecture Notes)

Always start with **`video_probe`** (`0` image tokens, no download) to inspect duration and available tracks, then choose the mode matching the user's goal:

### Mode A: General Video Summary (`preset: "summary"`, default — lowest tokens)
Use for everyday videos, short clips, vlogs, reviews, and general summaries:
1. Run `video_storyboard` with default `preset: "summary"` (`strategy: "auto"`, `detail: "med"`). For videos >10 minutes, scan in `300`-second windows (`from` + `segment: 300`).
2. Drill down only where needed (`video_zoom`, `video_locate`, `video_subtitles`, `video_clip`). Do not run full-video `video_transcript` unless the user asks for verbatim quotes.
3. Finish with `video_cache_clean`.

### Mode B: Long Lectures / Study Notes & PDF (`preset: "lecture"` — zero missed details)
Use for courses, technical talks, tutorials, meetings, or whenever the user wants study notes or a PDF:
1. **Get the complete spoken record first (`video_transcript`)**:
   - Call `video_transcript` without downloading the full video when site CC subtitles exist, or let it page locally at `1200` seconds (20 minutes) — or pass `full: true, saveFile: true` to save a complete `.md` transcript under cache and read it cleanly in sections without hitting `60`/`120`/`400`-char per-cell truncation.
2. **Capture slide transitions & board content (`video_storyboard` with `preset: "lecture"`)**:
   - Scan in `600`-second (10-minute) windows (`from` + `segment: 600`, `preset: "lecture"`). It automatically sets `quality: "medium"` (720p), `detail: "high"`, and `ocr: true`, and **reuses the transcript already cached by `video_transcript`** so ASR does not run twice.
3. **Read formulas, small text & code (`video_zoom`)**:
   - Whenever a slide frame contains math, diagrams, or code, call `video_zoom` on that `cellId` or `[from, to]` before writing the final notes/PDF.
4. **Build notes/PDF incrementally & clean up**:
   - Synthesize per-section notes after each window (never rely on a single compressed 2-hour overview), compile the final notes/PDF, and immediately call `video_cache_clean`.

## Sandboxed Clients & Troubleshooting

- **Never bypass this plugin with bare HTTP downloaders**: When inspecting Bilibili or YouTube audio/video URLs, **do not** extract direct stream URLs (`.m4a`/`.mp4`) and download them with `curl`, custom scripts, or a client's generic HTTP downloader — Bilibili CDNs reject bare or IP-mismatched requests immediately with `HTTP 403 Forbidden (0B)`. Always use `video_probe`, `video_storyboard`, `video_zoom`, and `video_clip` (with `yt-dlp`).
- **Network & local ASR port binding**: Fetching remote URLs (`probe`, `storyboard`, `locate`) and auto-starting the built-in local ASR HTTP server (`127.0.0.1:18321`) require outbound network or localhost port-binding permission when executed inside a restricted sandbox. Visual-only CLI calls on local or already-cached media (`storyboard --transcript off`, `subtitles`, `clean`) require neither network nor port binding.
- **Transient Bilibili `HTTP 403` / rate limits**: Bilibili requests (including `b23.tv` short links) automatically send `Referer: https://www.bilibili.com/` + browser `User-Agent`, inject `NO_PROXY` for Bilibili CDN domains, and fall back to `--proxy ""` or `--no-continue --sleep-requests 1` on `HTTP 403/412/429/567`. If `HTTP 403` persists, upgrade `yt-dlp` (`pip install --user -U yt-dlp`) or configure `cookies.txt`.
