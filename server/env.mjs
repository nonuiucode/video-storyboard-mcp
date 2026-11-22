/**
 * env.mjs — Pre-import environment bootstrap for `video-storyboard`.
 *
 * Must be imported FIRST by ESM entrypoints before upstream modules so
 * `DEFAULT_FFMPEG` / `DEFAULT_FFPROBE` in `binaries.js` resolve absolute paths
 * and cache/ASR directories initialize cleanly.
 */

import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PLUGIN_ROOT = resolve(__dirname, '..');
export const VENDOR_ROOT = join(PLUGIN_ROOT, 'vendor', 'dsh-video-storyboard');

function isDirSync(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSync(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function findWorkspaceRoot() {
  let cur = PLUGIN_ROOT;
  for (let i = 0; i < 6; i += 1) {
    if (isDirSync(join(cur, '.agents')) && resolve(cur, '.agents') !== resolve(PLUGIN_ROOT, '..')) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(PLUGIN_ROOT, '..', '..', '..');
}

export const WORKSPACE_ROOT = findWorkspaceRoot();

export function resolveCacheRoot(env = process.env) {
  const explicit = typeof env.VIDEO_STORYBOARD_CACHE_DIR === 'string' && env.VIDEO_STORYBOARD_CACHE_DIR.trim();
  if (explicit) return env.VIDEO_STORYBOARD_CACHE_DIR.trim();
  const scratchDir = join(WORKSPACE_ROOT, 'scratch');
  if (isDirSync(scratchDir)) return join(scratchDir, 'video-storyboard-cache');
  return join(tmpdir(), 'video-storyboard-mcp');
}

export const WORKSPACE_CACHE_ROOT = resolveCacheRoot();
export const DEFAULT_ASR_DIR = (typeof process.env.VIDEO_STORYBOARD_ASR_DIR === 'string' && process.env.VIDEO_STORYBOARD_ASR_DIR.trim())
  ? process.env.VIDEO_STORYBOARD_ASR_DIR.trim()
  : join(PLUGIN_ROOT, '.asr-runtime');

export function findOnPathSync(name, env = process.env) {
  const rawPath = env.PATH || env.Path || '';
  const dirs = rawPath
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];

  for (const dir of dirs) {
    if (process.platform === 'win32' && /\.(?:exe|cmd|bat|com)$/i.test(name)) {
      const exact = join(dir, name);
      if (isFileSync(exact)) return exact;
    }
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (isFileSync(candidate)) return candidate;
    }
  }
  return null;
}

export function ensureEnvDefaults(env = process.env) {
  const cacheRoot = resolveCacheRoot(env);
  if (!env.DSH_VIDEO_MEDIA_DIR) env.DSH_VIDEO_MEDIA_DIR = join(cacheRoot, 'media');
  if (!env.DSH_VIDEO_CACHE_DIR) env.DSH_VIDEO_CACHE_DIR = join(cacheRoot, 'cache');

  if (!env.DSH_FFMPEG_PATH && !env.FFMPEG_PATH) {
    const ffmpegAbs = findOnPathSync('ffmpeg', env);
    if (ffmpegAbs) env.DSH_FFMPEG_PATH = ffmpegAbs;
  }
  if (!env.DSH_FFPROBE_PATH && !env.FFPROBE_PATH) {
    const ffprobeAbs = findOnPathSync('ffprobe', env);
    if (ffprobeAbs) env.DSH_FFPROBE_PATH = ffprobeAbs;
  }

  const asrDir = (typeof env.VIDEO_STORYBOARD_ASR_DIR === 'string' && env.VIDEO_STORYBOARD_ASR_DIR.trim())
    ? env.VIDEO_STORYBOARD_ASR_DIR.trim()
    : DEFAULT_ASR_DIR;
  const managedAsr = join(asrDir, 'asr.json');
  if (!env.DSH_ASR_FALLBACK_CONFIG && isFileSync(managedAsr)) {
    env.DSH_ASR_FALLBACK_CONFIG = managedAsr;
  }
}

ensureEnvDefaults();
