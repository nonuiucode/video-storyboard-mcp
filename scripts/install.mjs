#!/usr/bin/env node
/**
 * install.mjs — Cross-platform installer & MCP config generator for video-storyboard-mcp.
 *
 * Usage:
 *   node scripts/install.mjs [--print-mcp]
 *   node scripts/install.mjs --antigravity-global
 *   node scripts/install.mjs --antigravity-workspace <dir>
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const COPY_ITEMS = [
  'plugin.json',
  'LICENSE',
  'NOTICE',
  'package.json',
  'assets',
  'skills',
  'server',
  'vendor',
];

const SKIP_NAMES = new Set([
  '.asr-runtime',
  '.venv',
  'node_modules',
  '__pycache__',
  '.git',
  'out',
  'clips',
  'media',
  'cache',
  'tmp',
]);

function parseArgs(argv) {
  const opts = {
    mode: 'print-mcp',
    workspace: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--antigravity-global') {
      opts.mode = 'antigravity-global';
    } else if (arg === '--antigravity-workspace') {
      opts.mode = 'antigravity-workspace';
      opts.workspace = argv[++i] || '';
      if (!opts.workspace) {
        throw new Error('--antigravity-workspace requires a directory path');
      }
    } else if (arg === '--print-mcp') {
      opts.mode = 'print-mcp';
    } else if (arg === '--help' || arg === '-h') {
      opts.mode = 'help';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log([
    'Usage: node scripts/install.mjs [options]',
    '',
    'Options:',
    '  --print-mcp                     Print MCP JSON snippets for Antigravity/Claude/Cursor/Gemini/Codex (default)',
    '  --antigravity-global            Install plugin into ~/.gemini/config/plugins/video-storyboard/',
    '  --antigravity-workspace <dir>   Install plugin into <dir>/.agents/plugins/video-storyboard/',
    '  -h, --help                      Show this help message',
  ].join('\n'));
}

async function installIntoPluginDir(targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const item of COPY_ITEMS) {
    const srcPath = join(REPO_ROOT, item);
    const dstPath = join(targetDir, item);
    await cp(srcPath, dstPath, {
      recursive: true,
      force: true,
      filter: (p) => {
        const base = p.split(/[\\/]/).pop() || '';
        return !SKIP_NAMES.has(base);
      },
    });
  }

  const mcpServerPath = join(targetDir, 'server', 'mcp_server.mjs');
  const mcpConfig = {
    mcpServers: {
      'video-storyboard': {
        command: 'node',
        args: [mcpServerPath],
      },
    },
  };
  await writeFile(join(targetDir, 'mcp_config.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');

  const manifest = JSON.parse(await readFile(join(targetDir, 'plugin.json'), 'utf8'));
  return { targetDir, mcpServerPath, name: manifest.name, version: manifest.version };
}

function buildMcpPayload() {
  const mcpServerPath = join(REPO_ROOT, 'server', 'mcp_server.mjs');
  return {
    mcpServers: {
      'video-storyboard': {
        command: 'node',
        args: [mcpServerPath],
      },
    },
    clients: {
      antigravityGlobalInstall: 'node scripts/install.mjs --antigravity-global',
      antigravityWorkspaceInstall: 'node scripts/install.mjs --antigravity-workspace <workspace-dir>',
      claudeCode: `claude mcp add video-storyboard -- node "${mcpServerPath}"`,
      cursor: 'Copy `mcpServers` above into .cursor/mcp.json',
      geminiCli: 'Merge `mcpServers` above into ~/.gemini/settings.json',
      codex: `codex mcp add video-storyboard -- node "${mcpServerPath}"`,
    },
    nextStepOptionalLocalAsr: 'node server/cli.mjs setup-asr',
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help') {
    printHelp();
    return 0;
  }
  if (opts.mode === 'print-mcp') {
    console.log(JSON.stringify(buildMcpPayload(), null, 2));
    return 0;
  }

  const targetDir = opts.mode === 'antigravity-global'
    ? join(homedir(), '.gemini', 'config', 'plugins', 'video-storyboard')
    : join(resolve(opts.workspace), '.agents', 'plugins', 'video-storyboard');

  const info = await installIntoPluginDir(targetDir);
  console.log([
    `Installed ${info.name} v${info.version} -> ${info.targetDir}`,
    `- MCP server: node "${info.mcpServerPath}"`,
    `- Run diagnostics: node "${join(info.targetDir, 'server', 'cli.mjs')}" doctor`,
    `- Optional offline ASR setup: node "${join(info.targetDir, 'server', 'cli.mjs')}" setup-asr`,
  ].join('\n'));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Error: ${err?.message ?? err}`);
    process.exit(1);
  });
