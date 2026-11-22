---
name: video-storyboard
description: "Watch Bilibili/YouTube/local videos efficiently via vendored SAOS-3624/dsh-video-storyboard v0.7.6 (video_probe, video_storyboard with 1/1..1/8 shot tiers & DP row packing, video_zoom, video_locate, video_subtitles, video_help) plus video_clip and mandatory video_cache_clean."
---

# Video Storyboard

Token-efficient, scene-aware video watching for MCP clients & Antigravity, built on `SAOS-3624/dsh-video-storyboard` (`v0.7.6`, Apache-2.0) with optional built-in offline `sherpa-onnx` ASR, trimmed clip inspection (`video_clip`), and post-watch cache cleanup (`video_cache_clean`).

## Tools (8)

1. **`video_probe`** — Read container/link metadata (duration, resolution, FPS, tracks, available heights) with **zero image tokens** and without downloading.
2. **`video_storyboard`** — Variable-tier (`1/1`..`1/8`) DP row-packed storyboard sheets + aligned subtitle/ASR transcript + `dryRun` estimator + targeted RapidOCR (`detail: "high"` or `ocr: true`).
3. **`video_zoom`** — Close-up re-read of a `cellId` or `[from, to]` interval at higher per-cell resolution.
4. **`video_locate`** — Pure-text fuzzy phrase search returning timestamped matches (`zero image tokens`).
5. **`video_subtitles`** — Crop the burned-in subtitle band across time intervals and stack strips vertically into one timestamped image.
6. **`video_help`** — Print the upstream parameter, strategy, tier, and token cost manual (`zero image tokens`).
7. **`video_clip`** — Export a short trimmed `.mp4` or audio-only `.mp3` snippet (capped at 90s) for native `read_file` inspection.
8. **`video_cache_clean`** — Remove cached downloaded videos, clips, and preview images after finishing.

## CLI Usage

Run commands from `<plugin-dir>`:

```bash
node server/cli.mjs doctor
node server/cli.mjs setup-asr --dry-run
node server/cli.mjs probe "<source>" --allow-anonymous
node server/cli.mjs storyboard "<source>" --allow-anonymous
node server/cli.mjs clean --all --include-scan-cache
```

## Recommended Workflow

1. **Probe first (`video_probe`)**: check duration, tracks, and ASR/subtitle readiness without downloading or spending image tokens. For long videos (>10 minutes), read in windows (`from` + `segment`, e.g. `300` seconds).
2. **Watch overview (`video_storyboard`)**: keep `strategy: "auto"` (default) or run `dryRun: true` first to preview image counts. Pass `detail: "high"` when burned-in captions need OCR spot-checking.
3. **Inspect details as needed**:
   - Dense rapid cuts or small UI text -> `video_zoom` (`cellId` or `[from, to]`)
   - Find a spoken quote -> `video_locate`
   - Hard-coded lyrics/bilingual subs with no ASR/track -> `video_subtitles` (pass `band: [y0, y1]` if needed)
   - Voice tone, music, or motion -> `video_clip` (inspect with native file reader)
4. **Mandatory cleanup (`video_cache_clean`)**: once done summarizing and no further `zoom`/`clip` calls are needed, call `video_cache_clean` immediately so downloaded media do not accumulate on disk.
