/**
 * adapter.mjs — Antigravity adapter over vendored SAOS-3624/dsh-video-storyboard (v0.7.6, Apache-2.0).
 *
 * Exposes all 6 upstream tools (`video_storyboard`, `video_zoom`, `video_probe`,
 * `video_locate`, `video_subtitles`, `video_help`) plus 2 Antigravity-native tools:
 * - `video_clip`: export a trimmed MP4/MP3 snippet for Antigravity `read_file` audio/motion inspection
 * - `video_cache_clean`: enforce immediate post-watch removal of cached media/preview files
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
import { DEFAULT_FFMPEG, resolveMediaBinary } from '../vendor/dsh-video-storyboard/src/storyboard/binaries.js';
import { cacheDir, PROTECTED_FILES } from '../vendor/dsh-video-storyboard/src/storyboard/cache.js';
import { lookupCell } from '../vendor/dsh-video-storyboard/src/storyboard/cells.js';
import { resolveInput } from '../vendor/dsh-video-storyboard/src/storyboard/fetch.js';
import { mediaDir, mediaKey } from '../vendor/dsh-video-storyboard/src/storyboard/media-store.js';
import { probeVideo } from '../vendor/dsh-video-storyboard/src/storyboard/probe.js';
import { storyboardTools } from '../vendor/dsh-video-storyboard/src/storyboard/register.js';
import { isHttpUrl, normalizeUrl } from '../vendor/dsh-video-storyboard/src/storyboard/url.js';

const runFile = promisify(execFile);
const BV_RE = /^(BV[0-9A-Za-z]{8,14})$/;
const HOST_PREFIX_RE = /^(?:b23\.tv|www\.bilibili\.com|bilibili\.com|youtu\.be|www\.youtube\.com|youtube\.com)\//i;

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

  const clipsDir = join(WORKSPACE_CACHE_ROOT, 'clips');
  const clipEntries = await readdir(clipsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of clipEntries) {
    if (!entry.isFile() || !entry.name.startsWith(`clip_${hash8}_`)) continue;
    const p = join(clipsDir, entry.name);
    const { total } = await pathBytes(p);
    await rm(p, { force: true }).catch(() => {});
    removedItems += 1;
    freedBytes += total;
    details.push(`clips/${entry.name}`);
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

function buildCleanTool() {
  return defineToolCompat({
    name: 'video_cache_clean',
    description: [
      'Delete cached downloaded video files, trimmed clips, and preview images after finishing a video.',
      'Pass `input` to remove cache for one video, or omit/set `all: true` to clear all media, clips, and previews.',
    ].join(' '),
    parameters: {
      input: {
        type: 'string',
        description: 'Optional URL, BV ID, or local path to clean cache for a specific video.',
      },
      all: {
        type: 'boolean',
        description: 'Clear all downloaded media, clips, and preview images (default true when input omitted).',
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
          // Prune unprotected scan cache JSONs? Leave cache/ intact unless requested, just remove empty protected check? No, leave cache/ untouched when false.
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

export function buildAllTools(ctx) {
  const upstream = storyboardTools(defineToolCompat, ctx);
  return [...upstream, buildClipTool(), buildCleanTool()];
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

  const args = { ...(rawArgs ?? {}) };
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
