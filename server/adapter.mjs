/**
 * adapter.mjs — Antigravity adapter over vendored SAOS-3624/dsh-video-storyboard (v0.7.6, Apache-2.0).
 *
 * Exposes all 6 upstream tools (`video_storyboard`, `video_zoom`, `video_probe`,
 * `video_locate`, `video_subtitles`, `video_help`) plus 3 Antigravity-native tools:
 * - `video_transcript`: extract untruncated timestamped transcripts (CC / embedded / ASR / SRT)
 * - `video_clip`: export a trimmed MP4/MP3 snippet for Antigravity `read_file` audio/motion inspection
 * - `video_cache_clean`: enforce immediate post-watch removal of cached media/transcript/preview files
 */

import {
  ensureEnvDefaults,
  PLUGIN_ROOT,
  VENDOR_ROOT,
  WORKSPACE_CACHE_ROOT,
  WORKSPACE_ROOT,
} from './env.mjs';

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export {
  ensureEnvDefaults,
  PLUGIN_ROOT,
  VENDOR_ROOT,
  WORKSPACE_CACHE_ROOT,
  WORKSPACE_ROOT,
};

import { defineToolCompat } from '../vendor/dsh-video-storyboard/src/define-tool.js';
import { applyTermMap, resolveAsrConfig } from '../vendor/dsh-video-storyboard/src/storyboard/asr.js';
import { isOwned, keepAlive, scheduleStop } from '../vendor/dsh-video-storyboard/src/storyboard/asr-lifecycle.js';
import { DEFAULT_FFMPEG, resolveMediaBinary } from '../vendor/dsh-video-storyboard/src/storyboard/binaries.js';
import { cacheDir, PROTECTED_FILES } from '../vendor/dsh-video-storyboard/src/storyboard/cache.js';
import { lookupCell } from '../vendor/dsh-video-storyboard/src/storyboard/cells.js';
import { resolveInput } from '../vendor/dsh-video-storyboard/src/storyboard/fetch.js';
import { rememberSegments } from '../vendor/dsh-video-storyboard/src/storyboard/locate.js';
import { mediaDir, mediaKey } from '../vendor/dsh-video-storyboard/src/storyboard/media-store.js';
import { DEFAULT_FFPROBE, probeVideo } from '../vendor/dsh-video-storyboard/src/storyboard/probe.js';
import { storyboardTools } from '../vendor/dsh-video-storyboard/src/storyboard/register.js';
import { fetchRemoteSubtitles } from '../vendor/dsh-video-storyboard/src/storyboard/subtitles.js';
import { resolveTranscript } from '../vendor/dsh-video-storyboard/src/storyboard/transcript-pass.js';
import { isHttpUrl, normalizeUrl } from '../vendor/dsh-video-storyboard/src/storyboard/url.js';

const runFile = promisify(execFile);
const BV_RE = /^(BV[0-9A-Za-z]{8,14})$/;
const HOST_PREFIX_RE = /^(?:b23\.tv|www\.bilibili\.com|bilibili\.com|youtu\.be|www\.youtube\.com|youtube\.com)\//i;
const TRANSCRIPT_LONG_THRESHOLD_SEC = 1800;
const TRANSCRIPT_DEFAULT_PAGE_SEC = 1200;
const TRANSCRIPT_INLINE_SAVE_LIMIT = 24_000;
const TRANSCRIPT_PREVIEW_CHARS = 2_000;

/**
 * Apply high-level profile presets (`summary` | `lecture`) without leaking `preset` upstream.
 */
export function applyStoryboardPreset(rawArgs = {}) {
  const next = { ...(rawArgs ?? {}) };
  const rawPreset = next.preset;
  delete next.preset;

  if (rawPreset === undefined || rawPreset === null || rawPreset === '' || rawPreset === 'summary') {
    return next;
  }
  if (rawPreset === 'lecture') {
    if (next.detail === undefined) next.detail = 'high';
    if (next.ocr === undefined) next.ocr = true;
    if (next.quality === undefined && next.scanHeight === undefined) {
      next.quality = 'medium';
    }
    return next;
  }
  throw new RangeError('preset must be "summary" or "lecture"');
}

function formatClockWhole(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function computeTranscriptWindow({ duration, from, to, segment, full = false } = {}) {
  const hasFrom = from !== undefined && from !== null;
  const winStart = hasFrom ? Number(from) : 0;
  if (!Number.isFinite(winStart) || winStart < 0) {
    throw new RangeError('from must be a non-negative number');
  }
  const hasTo = to !== undefined && to !== null;
  const explicitTo = hasTo ? Number(to) : null;
  if (hasTo && (!Number.isFinite(explicitTo) || explicitTo <= winStart)) {
    throw new RangeError('to must be greater than from');
  }
  const hasSegment = segment !== undefined && segment !== null;
  const explicitSeg = hasSegment ? Math.round(Number(segment)) : null;
  if (hasSegment && (!Number.isFinite(Number(segment)) || explicitSeg < 1)) {
    throw new RangeError('segment must be a positive integer');
  }

  const total = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;
  let winEnd;
  if (hasTo) {
    winEnd = total ? Math.min(total, explicitTo) : explicitTo;
  } else if (hasSegment) {
    winEnd = total ? Math.min(total, winStart + explicitSeg) : (winStart + explicitSeg);
  } else if (full !== true && total !== null && total > TRANSCRIPT_LONG_THRESHOLD_SEC && (total - winStart) > TRANSCRIPT_DEFAULT_PAGE_SEC) {
    winEnd = Math.min(total, winStart + TRANSCRIPT_DEFAULT_PAGE_SEC);
  } else {
    winEnd = total ?? winStart;
  }

  const nextSegment = hasSegment ? explicitSeg : TRANSCRIPT_DEFAULT_PAGE_SEC;
  const hasMore = !hasTo && total !== null && winEnd < total - 0.5;
  return {
    winStart,
    winEnd,
    hasMore,
    nextFrom: hasMore ? Math.floor(winEnd) : null,
    nextSegment: hasMore ? nextSegment : null,
  };
}

export function formatTranscriptSegments(segments, format = 'timestamped') {
  if (format !== 'timestamped' && format !== 'plain') {
    throw new RangeError('format must be "timestamped" or "plain"');
  }
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) return '';

  if (format === 'timestamped') {
    return list
      .map((s) => `[${formatClockWhole(s.from)}-${formatClockWhole(s.to)}] ${String(s.text ?? '').trim()}`)
      .filter((line) => !line.endsWith('] '))
      .join('\n');
  }

  const paragraphs = [];
  let paraTexts = [];
  let paraStart = 0;
  let prevTo = 0;
  let paraChars = 0;

  for (const seg of list) {
    const text = String(seg.text ?? '').trim();
    if (!text) continue;
    const sFrom = Number(seg.from) || 0;
    const sTo = Math.max(sFrom, Number(seg.to) || sFrom);
    const gap = sFrom - prevTo;
    const span = sTo - paraStart;
    if (paraTexts.length > 0 && (gap >= 4 || span >= 60 || paraChars >= 400)) {
      paragraphs.push(`[${formatClockWhole(paraStart)}] ${paraTexts.join(' ')}`);
      paraTexts = [];
      paraChars = 0;
    }
    if (paraTexts.length === 0) paraStart = sFrom;
    paraTexts.push(text);
    paraChars += text.length;
    prevTo = sTo;
  }
  if (paraTexts.length > 0) {
    paragraphs.push(`[${formatClockWhole(paraStart)}] ${paraTexts.join(' ')}`);
  }
  return paragraphs.join('\n\n');
}

/**
 * Normalize bare Bilibili BV IDs or scheme-less URLs before handing to upstream tools.
 */
export function normalizeSourceInput(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (BV_RE.test(trimmed)) return `https://www.bilibili.com/video/${trimmed}`;
  if (HOST_PREFIX_RE.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function sanitizeFilename(name) {
  return String(name || 'image.png').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${r}`
    : `${String(m).padStart(2, '0')}:${r}`;
}

function shortInputHash(input) {
  const norm = isHttpUrl(input) ? normalizeUrl(input) : String(input).replace(/\\/g, '/').toLowerCase();
  return createHash('sha1').update(norm).digest('hex').slice(0, 8);
}

/**
 * Build a minimal Cordis-compatible context implementing `get()` and `attachments.saveImage()`.
 */
export function createAntigravityContext({ saveDir = null } = {}) {
  let seq = 0;
  const attachments = {
    async saveImage({ data, mediaType = 'image/png', name = 'image.png' } = {}) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const base64 = buf.toString('base64');
      const safeName = sanitizeFilename(name);
      let savedPath = null;
      if (saveDir) {
        await mkdir(saveDir, { recursive: true });
        seq += 1;
        const outFile = join(saveDir, `${Date.now()}-${seq}-${safeName}`);
        await writeFile(outFile, buf);
        savedPath = outFile;
      }
      return {
        __mcpImage: true,
        data: base64,
        mimeType: mediaType || 'image/png',
        name: safeName,
        savedPath,
      };
    },
  };

  const services = { attachments };
  return {
    attachments,
    get(name) {
      return services[name] ?? null;
    },
  };
}

function buildClipTool() {
  return defineToolCompat({
    name: 'video_clip',
    description: [
      'Export a trimmed MP4 video or MP3 audio clip (capped at 90s) for a storyboard cellId or time window',
      'so Antigravity can inspect actual audio, voice tone, BGM, or fluid motion directly via `read_file`.',
      'Reuses cached downloaded media when available. Remember to call `video_cache_clean` after watching.',
    ].join(' '),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local file path, http(s) URL, or bare BV ID.',
      },
      cellId: {
        type: 'integer',
        description: '1-based cell number from the most recent `video_storyboard` call on this input.',
      },
      from: {
        type: 'number',
        description: 'Explicit start timestamp in seconds (alternative to cellId).',
      },
      to: {
        type: 'number',
        description: 'Explicit end timestamp in seconds (alternative to cellId).',
      },
      audioOnly: {
        type: 'boolean',
        description: 'Export MP3 audio only instead of MP4 (default false).',
      },
      maxHeight: {
        type: 'integer',
        description: 'Maximum vertical resolution for exported MP4 clip, 240..1080 (default 480).',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt path for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    async execute(rawArgs) {
      const args = rawArgs ?? {};
      if (!args.input || typeof args.input !== 'string') {
        throw new Error('input is required');
      }
      const normInput = normalizeSourceInput(args.input);
      let from = args.from;
      let to = args.to;

      if (args.cellId !== undefined && args.cellId !== null) {
        if (!Number.isInteger(args.cellId) || args.cellId < 1) {
          throw new Error('cellId must be a positive integer');
        }
        const hit = await lookupCell(normInput, args.cellId);
        if (!hit) {
          throw new Error(
            `no cell map recorded for this input (cellId ${args.cellId}). Run video_storyboard first, or pass from/to.`,
          );
        }
        from = hit.from;
        to = hit.to;
      } else {
        if (from === undefined && Number.isFinite(to) && to > 0) from = 0;
        if (!Number.isFinite(from) || from < 0) {
          throw new Error('from is required and must be >= 0 (or pass cellId)');
        }
        if (!Number.isFinite(to) || to <= from) {
          throw new Error('to is required and must be greater than from (or pass cellId)');
        }
      }

      const resolved = await resolveInput(normInput, {
        cookies: args.cookies,
        allowAnonymous: args.allowAnonymous === true,
        reuseCached: true,
      });
      const info = await probeVideo(resolved.path).catch(() => null);
      const duration = Number(info?.duration);

      const s0 = Math.max(0, Number(from));
      const rawEnd = Number(to);
      const s1 = Number.isFinite(duration) && duration > 0 ? Math.min(duration, rawEnd) : rawEnd;
      if (s1 <= s0) {
        throw new Error(`invalid clipped range [${s0.toFixed(2)}, ${s1.toFixed(2)}]`);
      }
      const span = Math.max(0.5, Math.min(90.0, s1 - s0));

      const clipsDir = join(WORKSPACE_CACHE_ROOT, 'clips');
      await mkdir(clipsDir, { recursive: true });

      const ffmpegBin = resolveMediaBinary('ffmpeg') || DEFAULT_FFMPEG;
      const hash8 = shortInputHash(normInput);
      const tag = args.cellId != null
        ? `cell${args.cellId}`
        : `${Math.round(s0)}_${Math.round(s0 + span)}`;
      const audioOnly = args.audioOnly === true;

      let outPath;
      let ffmpegArgs;
      if (audioOnly) {
        if (info && info.hasAudio === false) {
          throw new Error('video has no audio stream; cannot export audio-only clip');
        }
        outPath = join(clipsDir, `clip_${hash8}_${tag}.mp3`);
        ffmpegArgs = [
          '-hide_banner', '-v', 'error', '-y',
          '-ss', s0.toFixed(3), '-t', span.toFixed(3),
          '-i', resolved.path,
          '-vn', '-c:a', 'libmp3lame', '-b:a', '128k',
          outPath,
        ];
      } else {
        const mh = Math.max(240, Math.min(1080, Number.isInteger(args.maxHeight) ? args.maxHeight : 480));
        outPath = join(clipsDir, `clip_${hash8}_${tag}.mp4`);
        ffmpegArgs = [
          '-hide_banner', '-v', 'error', '-y',
          '-ss', s0.toFixed(3), '-t', span.toFixed(3),
          '-i', resolved.path,
          '-vf', `scale=-2:'min(${mh},ih)'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          outPath,
        ];
      }

      await runFile(ffmpegBin, ffmpegArgs, {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      const st = await stat(outPath);
      const sizeKb = (st.size / 1024).toFixed(1);

      const text = [
        `## Exported ${audioOnly ? 'Audio' : 'Video'} Clip`,
        `- **Path:** \`${outPath}\` (${sizeKb} KB)`,
        `- **Range:** ${formatClock(s0)} - ${formatClock(s0 + span)} (${span.toFixed(1)}s)`,
        `- **Next step:** Call \`read_file\` on the path above to inspect directly, then call \`video_cache_clean\` when done watching.`,
      ].join('\n');

      return { text };
    },
  });
}

async function pathBytes(targetPath) {
  let total = 0;
  let count = 0;
  let st;
  try {
    st = await stat(targetPath);
  } catch {
    return { total: 0, count: 0 };
  }
  if (st.isFile()) return { total: st.size, count: 1 };
  if (!st.isDirectory()) return { total: 0, count: 0 };

  let entries = [];
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return { total: 0, count: 0 };
  }
  for (const e of entries) {
    const sub = await pathBytes(join(targetPath, e.name));
    total += sub.total;
    count += sub.count;
  }
  return { total, count };
}

async function clearDirEntries(dir, { skipNames = new Set() } = {}) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removedItems: 0, freedBytes: 0 };
  }
  let removedItems = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const p = join(dir, entry.name);
    const { total } = await pathBytes(p);
    await rm(p, { recursive: true, force: true }).catch(() => {});
    removedItems += 1;
    freedBytes += total;
  }
  return { removedItems, freedBytes };
}

async function cleanByInput(rawInput, { includeScanCache = false } = {}) {
  const normInput = normalizeSourceInput(rawInput);
  const hash8 = shortInputHash(normInput);
  let removedItems = 0;
  let freedBytes = 0;
  const details = [];

  const mRoot = mediaDir();
  if (isHttpUrl(normInput)) {
    const normalized = normalizeUrl(normInput);
    const keySet = new Set([360, 480, 720, 1080].map((h) => mediaKey(normalized, h)));
    const entries = await readdir(mRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(mRoot, entry.name);
      let matched = keySet.has(entry.name);
      if (!matched) {
        try {
          const meta = JSON.parse(await readFile(join(dirPath, 'meta.json'), 'utf8'));
          if (meta?.url && normalizeUrl(meta.url) === normalized) matched = true;
        } catch { /* ignore unreadable meta.json */ }
      }
      if (matched) {
        const { total } = await pathBytes(dirPath);
        await rm(dirPath, { recursive: true, force: true }).catch(() => {});
        removedItems += 1;
        freedBytes += total;
        details.push(`media/${entry.name}`);
      }
    }
  }

  for (const [subDir, prefix] of [
    ['clips', `clip_${hash8}_`],
    ['transcripts', `transcript_${hash8}_`],
  ]) {
    const subRoot = join(WORKSPACE_CACHE_ROOT, subDir);
    const entries = await readdir(subRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const p = join(subRoot, entry.name);
      const { total } = await pathBytes(p);
      await rm(p, { force: true }).catch(() => {});
      removedItems += 1;
      freedBytes += total;
      details.push(`${subDir}/${entry.name}`);
    }
  }

  // CLI temporary outputs under out/ are preview images not keyed long-term
  const outRes = await clearDirEntries(join(WORKSPACE_CACHE_ROOT, 'out'));
  removedItems += outRes.removedItems;
  freedBytes += outRes.freedBytes;
  if (outRes.removedItems > 0) details.push(`out/ (${outRes.removedItems})`);

  if (includeScanCache) {
    const cRes = await clearDirEntries(cacheDir(), { skipNames: new Set() });
    removedItems += cRes.removedItems;
    freedBytes += cRes.freedBytes;
    if (cRes.removedItems > 0) details.push(`cache/ (${cRes.removedItems})`);
  }

  return { removedItems, freedBytes, details };
}

function buildTranscriptTool() {
  return defineToolCompat({
    name: 'video_transcript',
    description: [
      'Extract an untruncated timestamped or plain-text transcript for a video (0 image tokens, skips visual decoding/cuts).',
      'Best for 2h+ lectures and study notes: reuses site CC subtitles without downloading when available, auto-pages >30m videos at 1200s (or `full: true`), and shares ASR cache with `video_storyboard`.',
    ].join(' '),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local file path, http(s) URL, or bare BV ID.',
      },
      from: {
        type: 'number',
        description: 'Start seconds (default 0).',
      },
      to: {
        type: 'number',
        description: 'End seconds — or pass `segment` with `from`.',
      },
      segment: {
        type: 'integer',
        description: 'Window seconds when `to` is omitted (long videos >30m auto-page at 1200s unless `full: true`).',
      },
      full: {
        type: 'boolean',
        description: 'Return the entire transcript from `from` to end without 1200s auto-paging (default false).',
      },
      format: {
        type: 'string',
        enum: ['timestamped', 'plain'],
        description: 'Output style: timestamped (default, [MM:SS-MM:SS] per segment) or plain (grouped paragraphs with [MM:SS] anchors).',
      },
      saveFile: {
        type: 'boolean',
        description: 'Write the full untruncated Markdown transcript under workspace cache transcripts/ (default false).',
      },
      transcriptFile: {
        type: 'string',
        description: 'Existing SRT/JSON transcript file path (skips download & ASR).',
      },
      hotwords: {
        type: 'string',
        description: 'Space-separated terms to bias ASR transcription.',
      },
      cookies: {
        type: 'string',
        description: 'cookies.txt path for links (or DSH_VIDEO_COOKIES).',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Allow links without cookies (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    async execute(rawArgs) {
      const args = rawArgs ?? {};
      if (!args.input || typeof args.input !== 'string') {
        throw new Error('input is required');
      }
      const format = args.format === undefined ? 'timestamped' : String(args.format);
      if (format !== 'timestamped' && format !== 'plain') {
        throw new RangeError('format must be "timestamped" or "plain"');
      }
      const normInput = normalizeSourceInput(args.input);
      const ffmpegPath = resolveMediaBinary('ffmpeg') || DEFAULT_FFMPEG;
      const ffprobePath = resolveMediaBinary('ffprobe') || DEFAULT_FFPROBE;
      const full = args.full === true;
      const saveFile = args.saveFile === true;

      let allSegments = [];
      let totalDuration = 0;
      let win;
      let sourceLabel = 'none';
      let subtitleNeedsLogin = false;
      let asrSeconds = null;
      let asrCached = null;
      let localMediaPath = null;
      let title = null;
      let statusNote = null;

      if (args.transcriptFile) {
        const tr = await resolveTranscript({
          input: normInput,
          info: { hasAudio: true, hasSubtitle: false },
          transcript: 'auto',
          transcriptFile: String(args.transcriptFile),
          winStart: 0,
          winDur: 0,
          silences: [],
          ffmpegPath,
          hotwords: args.hotwords,
          cache: false,
        });
        const ti = tr.transcriptInfo ?? {};
        allSegments = Array.isArray(ti.segments) ? ti.segments : [];
        totalDuration = allSegments.reduce((m, s) => Math.max(m, Number(s.to) || 0), 0);
        win = computeTranscriptWindow({
          duration: totalDuration,
          from: args.from,
          to: args.to,
          segment: args.segment,
          full,
        });
        sourceLabel = ti.model || ti.source || 'file';
        if (ti.source === 'file-failed') {
          statusNote = `Transcript file error: ${ti.error || 'unreadable file'}`;
        }
      } else {
        let remoteResolved = false;
        if (isHttpUrl(normInput)) {
          const remote = await fetchRemoteSubtitles({
            url: normInput,
            cookies: args.cookies ?? null,
          }).catch(() => null);
          if (remote?.ok && Array.isArray(remote.segments) && remote.segments.length > 0) {
            const applied = applyTermMap(remote.segments, resolveAsrConfig().terms);
            allSegments = applied.segments;
            totalDuration = allSegments.reduce((m, s) => Math.max(m, Number(s.to) || 0), 0);
            win = computeTranscriptWindow({
              duration: totalDuration,
              from: args.from,
              to: args.to,
              segment: args.segment,
              full,
            });
            sourceLabel = `subtitle (site-cc${remote.lang ? `:${remote.lang}` : ''})`;
            remoteResolved = true;
          } else if (remote && !remote.ok && remote.reason === 'needs-login') {
            subtitleNeedsLogin = true;
          }
        }

        if (!remoteResolved) {
          const resolved = await resolveInput(normInput, {
            cookies: args.cookies,
            allowAnonymous: args.allowAnonymous === true,
            reuseCached: true,
            ffmpegPath,
          });
          localMediaPath = resolved.path;
          title = resolved.source?.title ?? null;
          const info = await probeVideo(resolved.path, { ffprobePath });
          totalDuration = Number.isFinite(Number(info?.duration)) ? Number(info.duration) : 0;
          win = computeTranscriptWindow({
            duration: totalDuration,
            from: args.from,
            to: args.to,
            segment: args.segment,
            full,
          });

          if (isOwned()) keepAlive();
          let tr;
          let asrLife = null;
          try {
            tr = await resolveTranscript({
              input: resolved.path,
              info,
              sourceInfo: resolved.source,
              fetchOptions: { cookies: args.cookies ?? null, siteSubtitles: false },
              transcript: 'auto',
              transcriptFile: null,
              winStart: win.winStart,
              winDur: Math.max(0.2, win.winEnd - win.winStart),
              silences: [],
              ffmpegPath,
              hotwords: args.hotwords,
              asrMaxChunk: 45,
              cache: true,
            });
            asrLife = tr?.asrLife ?? null;
          } finally {
            if (asrLife?.owned || isOwned()) {
              const c = resolveAsrConfig();
              scheduleStop({ owned: true, config: c, baseUrl: c.baseUrl });
            }
          }

          const ti = tr?.transcriptInfo ?? {};
          allSegments = Array.isArray(ti.segments) ? ti.segments : [];
          asrSeconds = tr?.asrSeconds ?? null;
          asrCached = tr?.asrCached ?? null;
          sourceLabel = ti.source === 'subtitle'
            ? `subtitle (${ti.model || 'embedded'})`
            : `${ti.source || 'none'}${ti.model ? ` (${ti.model})` : ''}`;

          if (ti.source === 'no-key') {
            statusNote = 'No subtitle track found and no ASR configured. Run `node server/cli.mjs setup-asr` for offline ASR, or use `video_subtitles` for burned-in captions.';
          } else if (ti.source === 'no-audio') {
            statusNote = 'No audio stream found in this video; use `video_subtitles` if captions are burned into frames.';
          } else if (ti.source === 'asr-failed') {
            statusNote = `ASR failed: ${ti.error || 'unknown error'}`;
          } else if (ti.source === 'asr-empty') {
            statusNote = 'ASR completed but detected no spoken speech in this window (try `video_subtitles` for burned-in captions).';
          }
        }
      }

      const inWindow = allSegments.filter((s) => Number(s.to) > win.winStart && Number(s.from) < win.winEnd);
      if (localMediaPath && inWindow.length > 0) {
        rememberSegments(localMediaPath, inWindow);
      }

      const formattedBody = formatTranscriptSegments(inWindow, format);
      const totalChars = formattedBody.length;
      const totalLabel = totalDuration > 0 ? formatClockWhole(totalDuration) : 'unknown';
      const asrTiming = asrCached === true
        ? 'cached (0s)'
        : (asrSeconds !== null ? `${asrSeconds}s` : 'n/a');

      const headerLines = [
        '## Video Transcript',
        ...(title ? [`- **Title:** ${title}`] : []),
        `- **Source:** ${sourceLabel}`,
        `- **Window:** ${formatClockWhole(win.winStart)} - ${formatClockWhole(win.winEnd)} / ${totalLabel}`,
        `- **Segments:** ${inWindow.length}`,
        `- **Chars:** ${totalChars}`,
        `- **ASR time:** ${asrTiming}`,
        ...(subtitleNeedsLogin ? ['- **Note:** Site CC subtitles require login (`cookies.txt`); fell back to local stream/ASR.'] : []),
        ...(statusNote ? [`- **Status:** ${statusNote}`] : []),
      ];

      let savedPath = null;
      if (saveFile) {
        const transcriptsDir = join(WORKSPACE_CACHE_ROOT, 'transcripts');
        await mkdir(transcriptsDir, { recursive: true });
        const hash8 = shortInputHash(normInput);
        const isWhole = win.winStart === 0 && !win.hasMore && totalDuration > 0 && win.winEnd >= totalDuration - 0.5;
        const tag = isWhole ? 'full' : `${Math.round(win.winStart)}_${Math.round(win.winEnd)}`;
        savedPath = join(transcriptsDir, `transcript_${hash8}_${tag}.md`);
        const fileContent = `${headerLines.join('\n')}\n\n${formattedBody || '(no speech segments in this window)'}\n`;
        await writeFile(savedPath, fileContent, 'utf8');
        headerLines.push(`- **Saved file:** \`${savedPath}\``);
      }

      let bodySection;
      if (!formattedBody) {
        bodySection = '(no speech segments in this window)';
      } else if (saveFile && formattedBody.length > TRANSCRIPT_INLINE_SAVE_LIMIT) {
        const fullLines = `${headerLines.join('\n')}\n\n${formattedBody}\n`.split('\n').length;
        bodySection = [
          formattedBody.slice(0, TRANSCRIPT_PREVIEW_CHARS),
          '',
          `[Preview truncated at ${TRANSCRIPT_PREVIEW_CHARS} chars because \`saveFile: true\` wrote the full ${fullLines}-line (${totalChars} chars) transcript to \`${savedPath}\`. Read it in chunks with \`read_file\` (\`StartLine\`/\`EndLine\`).]`,
        ].join('\n');
      } else {
        bodySection = formattedBody;
      }

      const parts = [headerLines.join('\n'), '', bodySection];
      if (win.hasMore) {
        parts.push('', `Next window: call \`video_transcript\` with \`from: ${win.nextFrom}, segment: ${win.nextSegment}\`.`);
      }
      return { text: parts.join('\n') };
    },
  });
}

function buildCleanTool() {
  return defineToolCompat({
    name: 'video_cache_clean',
    description: [
      'Delete cached downloaded video files, exported transcripts, trimmed clips, and preview images after finishing a video.',
      'Pass `input` to remove cache for one video, or omit/set `all: true` to clear all media, transcripts, clips, and previews.',
    ].join(' '),
    parameters: {
      input: {
        type: 'string',
        description: 'Optional URL, BV ID, or local path to clean cache for a specific video.',
      },
      all: {
        type: 'boolean',
        description: 'Clear all downloaded media, transcripts, clips, and preview images (default true when input omitted).',
      },
      includeScanCache: {
        type: 'boolean',
        description: 'Also clear JSON scan/ASR cache files under cache/ (default false).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    async execute(rawArgs) {
      const args = rawArgs ?? {};
      const includeScanCache = args.includeScanCache === true;

      let removedItems = 0;
      let freedBytes = 0;
      const details = [];

      if (args.input && typeof args.input === 'string' && args.input.trim()) {
        const res = await cleanByInput(args.input, { includeScanCache });
        removedItems += res.removedItems;
        freedBytes += res.freedBytes;
        details.push(...res.details);
      }

      const shouldCleanAll = args.all === true || (!args.input && args.all !== false);
      if (shouldCleanAll) {
        for (const [label, dirPath] of [
          ['media', mediaDir()],
          ['transcripts', join(WORKSPACE_CACHE_ROOT, 'transcripts')],
          ['clips', join(WORKSPACE_CACHE_ROOT, 'clips')],
          ['out', join(WORKSPACE_CACHE_ROOT, 'out')],
        ]) {
          const r = await clearDirEntries(dirPath);
          removedItems += r.removedItems;
          freedBytes += r.freedBytes;
          if (r.removedItems > 0) details.push(`${label}/ (${r.removedItems})`);
        }
        if (includeScanCache) {
          const r = await clearDirEntries(cacheDir());
          removedItems += r.removedItems;
          freedBytes += r.freedBytes;
          if (r.removedItems > 0) details.push(`cache/ (${r.removedItems})`);
        } else {
          void PROTECTED_FILES;
        }
      }

      const mb = (freedBytes / (1024 * 1024)).toFixed(2);
      const summary = removedItems > 0
        ? `Cleaned ${removedItems} cached item(s), freed ${mb} MB [${details.join(', ')}].`
        : 'Cache already clean (0 items removed, 0.00 MB freed).';
      return { text: summary };
    },
  });
}

function wrapStoryboardTool(tool) {
  const baseParams = tool.parameters && typeof tool.parameters === 'object'
    ? tool.parameters
    : { type: 'object', properties: {} };
  return {
    ...tool,
    parameters: {
      ...baseParams,
      properties: {
        ...(baseParams.properties ?? {}),
        preset: {
          type: 'string',
          enum: ['summary', 'lecture'],
          description: 'Mode preset: summary (default, lowest tokens) or lecture (auto detail=high, ocr=true, quality=medium for slides/notes).',
        },
      },
    },
    execute: (args) => tool.execute(applyStoryboardPreset(args)),
  };
}

export function buildAllTools(ctx) {
  const upstream = storyboardTools(defineToolCompat, ctx)
    .map((t) => (t.name === 'video_storyboard' ? wrapStoryboardTool(t) : t));
  return [...upstream, buildTranscriptTool(), buildClipTool(), buildCleanTool()];
}

export function listMcpTools() {
  const ctx = createAntigravityContext({ saveDir: null });
  return buildAllTools(ctx).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

export async function callMcpTool(name, rawArgs = {}, { saveDir = null } = {}) {
  ensureEnvDefaults();
  const ctx = createAntigravityContext({ saveDir });
  const tools = buildAllTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  let args = { ...(rawArgs ?? {}) };
  if (name === 'video_storyboard') {
    args = applyStoryboardPreset(args);
  }
  if (typeof args.input === 'string') {
    args.input = normalizeSourceInput(args.input);
  }

  const value = await tool.execute(args);
  const blocks = tool.output.render(args, value);

  const content = [];
  const savedImages = [];
  for (const blk of blocks) {
    if (blk?.type === 'image' && blk.attachment?.__mcpImage) {
      content.push({
        type: 'image',
        data: blk.attachment.data,
        mimeType: blk.attachment.mimeType || 'image/png',
      });
      if (blk.attachment.savedPath) {
        savedImages.push(blk.attachment.savedPath);
      }
    } else if (blk?.type === 'text') {
      content.push({
        type: 'text',
        text: String(blk.text ?? ''),
      });
    }
  }

  return { content, savedImages };
}
