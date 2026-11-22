#!/usr/bin/env node
/**
 * cli.mjs — CLI entrypoint for Antigravity `video-storyboard` (v2.0.0).
 *
 * Subcommands:
 *   doctor | probe | storyboard | zoom | locate | subtitles | help | clip | clean
 */

import './env.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import {
  callMcpTool,
  ensureEnvDefaults,
  VENDOR_ROOT,
  WORKSPACE_CACHE_ROOT,
} from './adapter.mjs';
import {
  DEFAULT_ASR_PORT,
  getLocalAsrStatus,
  setupLocalAsr,
} from './asr_setup.mjs';

ensureEnvDefaults();

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  const valueFlags = new Set([
    'from', 'to', 'segment', 'strategy', 'budget', 'max-frames', 'max-sheets',
    'cut-floor', 'scan-gap', 'integral-seconds', 'tier-map', 'pick', 'burn',
    'transcript', 'transcript-file', 'detail', 'hotwords', 'quality', 'scan-height',
    'zoom-height', 'cell-range', 'cookies', 'cell', 'frames', 'max', 'max-strips',
    'step-sec', 'band', 'times', 'max-height',
    'model', 'mirror', 'port', 'language', 'python',
  ]);
  const boolFlags = new Set([
    'json', 'allow-anonymous', 'dry-run', 'text-only', 'audio-only',
    'all', 'include-scan-cache', 'help',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--no-integral') {
      flags.integral = false;
      continue;
    }
    if (tok === '--integral') {
      flags.integral = true;
      continue;
    }
    if (tok === '--no-ocr') {
      flags.ocr = false;
      continue;
    }
    if (tok === '--ocr') {
      flags.ocr = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      let key;
      let val;
      if (eq !== -1) {
        key = tok.slice(2, eq);
        val = tok.slice(eq + 1);
      } else {
        key = tok.slice(2);
        if (boolFlags.has(key)) {
          val = true;
        } else if (valueFlags.has(key) || (i + 1 < argv.length && !argv[i + 1].startsWith('--'))) {
          val = argv[++i];
        } else {
          val = true;
        }
      }
      flags[key] = val;
    } else if (tok === '-h') {
      flags.help = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function numFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const n = Number(flags[key]);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number (got "${flags[key]}")`);
  return n;
}

function intFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const n = Number(flags[key]);
  if (!Number.isInteger(n)) throw new Error(`--${key} must be an integer (got "${flags[key]}")`);
  return n;
}

function numListFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const raw = String(flags[key]).trim();
  const parsed = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(',').map((s) => Number(s.trim()));
  if (!Array.isArray(parsed) || parsed.some((v) => !Number.isFinite(v))) {
    throw new Error(`--${key} must be a comma-separated number list or JSON array`);
  }
  return parsed;
}

function intPairFlag(flags, key) {
  const arr = numListFlag(flags, key);
  if (arr === undefined) return undefined;
  if (arr.length !== 2 || arr.some((v) => !Number.isInteger(v))) {
    throw new Error(`--${key} must contain 2 integers`);
  }
  return arr;
}

function buildCommonFetchFlags(flags, args) {
  if (flags.cookies !== undefined) args.cookies = String(flags.cookies);
  if (flags['allow-anonymous']) args.allowAnonymous = true;
}

function printHelp() {
  console.log([
    'Usage: node cli.mjs <command> [options]',
    '',
    'Commands:',
    '  doctor                            Run upstream environment & ASR diagnostic',
    '  probe <source>                    Read container/link metadata (no download, zero image tokens)',
    '  storyboard <source>               Generate variable-tier DP-packed storyboard + transcript',
    '  zoom <source> [--cell N]          High-res close-up of a cell or [--from A --to B]',
    '  locate <source> <query>           Fuzzy text search in transcript -> timestamps',
    '  subtitles <source>                Clip hard-coded subtitle band into one tall strip image',
    '  clip <source> [--cell N]          Export trimmed MP4/MP3 snippet for read_file inspection',
    '  clean [<source>] [--all]          Delete cached videos, clips, and preview images',
    '  setup-asr [options]               Install local offline sherpa-onnx ASR service & models',
    '  asr-status [--json]               Inspect active ASR endpoint & lifecycle configuration',
    '  help [topic]                      Show upstream video_help manual',
  ].join('\n'));
}

async function runDoctor() {
  const doctorPath = join(VENDOR_ROOT, 'bin', 'doctor.mjs');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [doctorPath], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    });
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 0));
  });
  return code;
}

async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || (cmd === 'cli' && flags.help) || (flags.help && !cmd)) {
    printHelp();
    return 0;
  }

  if (cmd === 'doctor') {
    return runDoctor();
  }

  if (cmd === 'asr-status') {
    const status = getLocalAsrStatus();
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log([
        `ASR ready: ${status.ready ? 'yes' : 'no'} (source=${status.source})`,
        `Endpoint: ${status.baseUrl} (model=${status.model}, language=${status.language})`,
        `Config path: ${status.configPath || '(none)'}`,
        `User ~/.dsh/asr.json: ${status.userConfigExists ? status.userConfigPath : 'not found'}`,
        `Plugin managed ASR: ${status.managedInstalled ? status.managedConfigPath : 'not installed (run setup-asr)'}`,
        `Auto lifecycle manage.start: ${status.managedLifecycle ? 'enabled' : 'disabled'}`,
      ].join('\n'));
    }
    return 0;
  }

  if (cmd === 'setup-asr') {
    const model = flags.model ? String(flags.model) : 'sensevoice';
    const mirror = flags.mirror ? String(flags.mirror) : 'auto';
    const port = flags.port !== undefined ? intFlag(flags, 'port') : DEFAULT_ASR_PORT;
    const language = flags.language ? String(flags.language) : 'auto';
    const python = flags.python ? String(flags.python) : null;
    const dryRun = Boolean(flags['dry-run']);
    const result = await setupLocalAsr({ model, mirror, port, language, python, dryRun });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (dryRun) {
      console.log([
        `[dry-run] Local ASR setup plan (${result.model}, mirror=${result.mirror})`,
        `- Python: ${result.python}`,
        `- Target dir: ${result.asrDir}`,
        `- Package: ${result.pipPackage}`,
        `- Approx download: ~${result.approxDownloadMb} MB`,
        ...result.downloads.map((d) => `  - ${d.url}`),
        `- Managed config preview: ${result.configPath} -> ${result.asrJsonPreview.baseUrl}`,
      ].join('\n'));
    } else {
      console.log([
        `Installed local ASR (${result.model}) into ${result.asrDir}`,
        `- Config: ${result.configPath}`,
        `- Auto-starts on http://127.0.0.1:${result.port}/v1 with 5s idle shutdown`,
      ].join('\n'));
    }
    return 0;
  }

  if (cmd === 'help') {
    const args = positionals[1] ? { topic: positionals[1] } : {};
    const { content } = await callMcpTool('video_help', args);
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (flags.json) console.log(JSON.stringify({ text }, null, 2));
    else console.log(text);
    return 0;
  }

  const outDir = join(WORKSPACE_CACHE_ROOT, 'out');
  const asJson = Boolean(flags.json);

  let toolName;
  const args = {};

  if (cmd === 'probe') {
    if (!positionals[1]) throw new Error('probe requires <source>');
    toolName = 'video_probe';
    args.input = positionals[1];
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'storyboard') {
    if (!positionals[1]) throw new Error('storyboard requires <source>');
    toolName = 'video_storyboard';
    args.input = positionals[1];
    if (flags.from !== undefined) args.from = numFlag(flags, 'from');
    if (flags.to !== undefined) args.to = numFlag(flags, 'to');
    if (flags.segment !== undefined) args.segment = intFlag(flags, 'segment');
    if (flags.strategy !== undefined) args.strategy = String(flags.strategy);
    if (flags.budget !== undefined) args.budget = intFlag(flags, 'budget');
    if (flags['max-frames'] !== undefined) args.maxFrames = intFlag(flags, 'max-frames');
    if (flags['max-sheets'] !== undefined) args.maxSheets = intFlag(flags, 'max-sheets');
    if (flags['cut-floor'] !== undefined) args.cutFloor = intFlag(flags, 'cut-floor');
    if (flags['scan-gap'] !== undefined) args.scanGap = numFlag(flags, 'scan-gap');
    if (flags.integral !== undefined) args.integral = Boolean(flags.integral);
    if (flags['integral-seconds'] !== undefined) args.integralSeconds = numFlag(flags, 'integral-seconds');
    if (flags['tier-map'] !== undefined) args.tierMap = JSON.parse(String(flags['tier-map']));
    if (flags.pick !== undefined) args.pick = String(flags.pick);
    if (flags.burn !== undefined) args.burn = String(flags.burn);
    if (flags.transcript !== undefined) args.transcript = String(flags.transcript);
    if (flags['transcript-file'] !== undefined) args.transcriptFile = String(flags['transcript-file']);
    if (flags.detail !== undefined) args.detail = String(flags.detail);
    if (flags.ocr !== undefined) args.ocr = Boolean(flags.ocr);
    if (flags.hotwords !== undefined) args.hotwords = String(flags.hotwords);
    if (flags.quality !== undefined) args.quality = String(flags.quality);
    if (flags['scan-height'] !== undefined) args.scanHeight = intFlag(flags, 'scan-height');
    if (flags['dry-run']) args.dryRun = true;
    if (flags['text-only']) args.textOnly = true;
    if (flags['cell-range'] !== undefined) args.cellRange = intPairFlag(flags, 'cell-range');
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'zoom') {
    if (!positionals[1]) throw new Error('zoom requires <source>');
    toolName = 'video_zoom';
    args.input = positionals[1];
    if (flags.cell !== undefined) args.cellId = intFlag(flags, 'cell');
    if (flags.from !== undefined) args.from = numFlag(flags, 'from');
    if (flags.to !== undefined) args.to = numFlag(flags, 'to');
    if (flags.frames !== undefined) args.maxFrames = intFlag(flags, 'frames');
    if (flags['max-frames'] !== undefined) args.maxFrames = intFlag(flags, 'max-frames');
    if (flags.strategy !== undefined) args.strategy = String(flags.strategy);
    if (flags.quality !== undefined) args.quality = String(flags.quality);
    if (flags['zoom-height'] !== undefined) args.zoomHeight = intFlag(flags, 'zoom-height');
    if (flags['scan-height'] !== undefined) args.scanHeight = intFlag(flags, 'scan-height');
    if (flags.pick !== undefined) args.pick = String(flags.pick);
    if (flags.burn !== undefined) args.burn = String(flags.burn);
    if (flags.transcript !== undefined) args.transcript = String(flags.transcript);
    if (flags['transcript-file'] !== undefined) args.transcriptFile = String(flags['transcript-file']);
    if (flags.detail !== undefined) args.detail = String(flags.detail);
    if (flags.ocr !== undefined) args.ocr = Boolean(flags.ocr);
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'locate') {
    if (!positionals[1] || !positionals[2]) throw new Error('locate requires <source> <query>');
    toolName = 'video_locate';
    args.input = positionals[1];
    args.query = positionals.slice(2).join(' ');
    if (flags.from !== undefined) args.from = numFlag(flags, 'from');
    if (flags.to !== undefined) args.to = numFlag(flags, 'to');
    if (flags.max !== undefined) args.max = intFlag(flags, 'max');
    if (flags['transcript-file'] !== undefined) args.transcriptFile = String(flags['transcript-file']);
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'subtitles') {
    if (!positionals[1]) throw new Error('subtitles requires <source>');
    toolName = 'video_subtitles';
    args.input = positionals[1];
    if (flags.from !== undefined) args.from = numFlag(flags, 'from');
    if (flags.to !== undefined) args.to = numFlag(flags, 'to');
    if (flags['max-strips'] !== undefined) args.maxStrips = intFlag(flags, 'max-strips');
    if (flags['step-sec'] !== undefined) args.stepSec = numFlag(flags, 'step-sec');
    if (flags.band !== undefined) args.band = numListFlag(flags, 'band');
    if (flags.times !== undefined) args.times = numListFlag(flags, 'times');
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'clip') {
    if (!positionals[1]) throw new Error('clip requires <source>');
    toolName = 'video_clip';
    args.input = positionals[1];
    if (flags.cell !== undefined) args.cellId = intFlag(flags, 'cell');
    if (flags.from !== undefined) args.from = numFlag(flags, 'from');
    if (flags.to !== undefined) args.to = numFlag(flags, 'to');
    if (flags['audio-only']) args.audioOnly = true;
    if (flags['max-height'] !== undefined) args.maxHeight = intFlag(flags, 'max-height');
    buildCommonFetchFlags(flags, args);
  } else if (cmd === 'clean') {
    toolName = 'video_cache_clean';
    if (positionals[1]) args.input = positionals[1];
    if (flags.all) args.all = true;
    if (flags['include-scan-cache']) args.includeScanCache = true;
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }

  const { content, savedImages } = await callMcpTool(toolName, args, { saveDir: outDir });
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');

  if (asJson) {
    console.log(JSON.stringify({ tool: toolName, images: savedImages, text }, null, 2));
  } else {
    if (savedImages.length > 0) {
      for (const imgPath of savedImages) {
        console.log(`Image: ${imgPath}`);
      }
      console.log('');
    }
    console.log(text);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${err?.message ?? err}`);
    process.exit(1);
  });
