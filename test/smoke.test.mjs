import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

test('MCP stdio JSON-RPC exposes all 8 tools and serves video_help cleanly', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'vs-mcp-test-'));
  try {
    const res = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, 'server', 'mcp_server.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSH_HOME: join(tmpDir, 'dsh'),
          VIDEO_STORYBOARD_CACHE_DIR: join(tmpDir, 'cache'),
          VIDEO_STORYBOARD_ASR_DIR: join(tmpDir, 'asr-none'),
        },
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolveRun({ code, out, err }));

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'video_help', arguments: { topic: 'strategy' } },
      })}\n`);
      child.stdin.end();
    });

    assert.equal(res.code, 0);
    assert.equal(res.err, '', `Unexpected stderr: ${res.err}`);

    const messages = res.out.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.result?.serverInfo?.name, 'video-storyboard');
    assert.equal(messages[0]?.result?.serverInfo?.version, '2.1.1');

    const tools = messages[1]?.result?.tools || [];
    const expected = [
      'video_storyboard',
      'video_zoom',
      'video_probe',
      'video_locate',
      'video_subtitles',
      'video_help',
      'video_clip',
      'video_cache_clean',
    ];
    assert.deepEqual(tools.map((t) => t.name), expected);
    for (const tool of tools) {
      assert.equal(tool.inputSchema?.type, 'object');
      assert.equal(typeof tool.inputSchema?.properties, 'object');
    }

    assert.notEqual(messages[2]?.result?.isError, true);
    const helpText = messages[2]?.result?.content?.[0]?.text || '';
    assert.ok(helpText.length > 100);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('cli setup-asr --dry-run outputs install plan without downloading or creating files', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'vs-asr-dry-'));
  const targetAsrDir = join(tmpDir, '.asr-runtime');
  try {
    const { stdout } = await runFile(
      process.execPath,
      [join(REPO_ROOT, 'server', 'cli.mjs'), 'setup-asr', '--dry-run', '--json'],
      {
        env: { ...process.env, VIDEO_STORYBOARD_ASR_DIR: targetAsrDir },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const plan = JSON.parse(stdout);
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.model, 'sherpa-sensevoice-int8');
    assert.ok(plan.downloads.some((d) => String(d.url).includes('sense-voice')));
    assert.ok(plan.downloads.some((d) => String(d.url).includes('silero_vad.onnx')));
    assert.ok(plan.asrJsonPreview?.manage?.start?.some((s) => String(s).includes('asr_server.py')));
    assert.equal(existsSync(targetAsrDir), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('install.mjs --print-mcp outputs valid portable MCP JSON config', async () => {
  const { stdout } = await runFile(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'install.mjs'), '--print-mcp'],
    { timeout: 15_000, windowsHide: true },
  );
  const parsed = JSON.parse(stdout);
  const entry = parsed?.mcpServers?.['video-storyboard'];
  assert.equal(entry?.command, 'node');
  assert.ok(Array.isArray(entry?.args) && entry.args[0].endsWith('mcp_server.mjs'));
});

test('built-in asr_server.py --mock auto-starts via asr-lifecycle, transcribes into storyboard, and shuts down', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'vs-asr-e2e-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const healthUrl = `http://127.0.0.1:${port}/health`;

  try {
    const dshHome = join(tmpDir, 'empty-dsh');
    const cacheRoot = join(tmpDir, 'vcache');
    await mkdir(dshHome, { recursive: true });
    await mkdir(cacheRoot, { recursive: true });

    // Resolve ffmpeg and python cleanly using repo helpers
    const envMod = await import(`file://${join(REPO_ROOT, 'server', 'env.mjs').replace(/\\/g, '/')}`);
    const pyMod = await import(`file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'python.js').replace(/\\/g, '/')}`);
    const pyExe = envMod.findOnPathSync('python')
      || envMod.findOnPathSync('python3')
      || pyMod.pythonCandidates().find((c) => existsSync(c))
      || 'python';
    const ffmpegExe = process.env.DSH_FFMPEG_PATH || envMod.findOnPathSync('ffmpeg') || 'ffmpeg';

    const mp4Path = join(tmpDir, 'mock_audio_test.mp4');
    await runFile(
      ffmpegExe,
      [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1e3a8a:s=320x180:d=3',
        '-f', 'lavfi', '-i', 'color=c=0x991b1b:s=320x180:d=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=44100',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        mp4Path,
      ],
      { timeout: 30_000, windowsHide: true },
    );

    const mockAsrConfigPath = join(tmpDir, 'asr.json');
    await writeFile(
      mockAsrConfigPath,
      JSON.stringify({
        baseUrl,
        key: 'local',
        model: 'mock-sherpa-asr',
        language: 'zh',
        manage: {
          start: [pyExe, join(REPO_ROOT, 'server', 'asr_server.py'), '--mock', '--host', '127.0.0.1', '--port', String(port)],
          idleMs: 1000,
          waitMs: 15000,
        },
      }),
      'utf8',
    );

    const childScript = `
      import { callMcpTool } from ${JSON.stringify(`file://${join(REPO_ROOT, 'server', 'adapter.mjs').replace(/\\/g, '/')}`)};
      const sb = await callMcpTool('video_storyboard', { input: ${JSON.stringify(mp4Path)}, strategy: 'compact' }, { saveDir: ${JSON.stringify(join(cacheRoot, 'out'))} });
      const text = sb.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
      const healthDuring = await fetch(${JSON.stringify(healthUrl)}).then((r) => r.status).catch(() => 0);
      const cleaned = await callMcpTool('video_cache_clean', { all: true, includeScanCache: true });
      let downAfterIdle = false;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        const alive = await fetch(${JSON.stringify(healthUrl)}).then((r) => r.ok).catch(() => false);
        if (!alive) { downAfterIdle = true; break; }
      }
      console.log(JSON.stringify({ text, imageCount: sb.savedImages.length, healthDuring, cleanedText: cleaned.content[0]?.text || '', downAfterIdle }));
    `;

    const { stdout } = await runFile(
      process.execPath,
      ['--input-type=module', '-e', childScript],
      {
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DSH_ASR_FALLBACK_CONFIG: mockAsrConfigPath,
          VIDEO_STORYBOARD_CACHE_DIR: cacheRoot,
        },
        timeout: 60_000,
        windowsHide: true,
      },
    );

    const result = JSON.parse(stdout);
    assert.ok(result.imageCount >= 1);
    assert.equal(result.healthDuring, 200);
    assert.match(result.text, /mock local asr transcript/);
    assert.match(result.cleanedText, /Cleaned/);
    assert.equal(result.downAfterIdle, true, 'Expected managed asr_server.py to stop after idleMs');
  } finally {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('probeUrl sends canonical Bilibili Referer initially and retries transient HTTP 403 without duplicate headers', async () => {
  const { probeUrl } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'fetch.js').replace(/\\/g, '/')}`
  );
  const { DEFAULT_UA } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'ytdlp.js').replace(/\\/g, '/')}`
  );

  const calls = [];
  const fakeRun = async (_tool, args) => {
    calls.push(args);
    if (calls.length === 1) {
      return {
        code: 1,
        stdout: '',
        stderr: 'ERROR: [BiliBili] BV1mock: Unable to download JSON metadata: HTTP Error 403: Forbidden',
      };
    }
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        title: 'Mock Bili',
        duration: 120,
        formats: [{ vcodec: 'avc1', height: 720, url: 'https://example.com/v.mp4' }],
      }),
    };
  };

  const result = await probeUrl('https://b23.tv/mock123', {
    allowAnonymous: true,
    ytdlp: { bin: 'yt-dlp', prefix: [] },
    run: fakeRun,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--add-header'));
  assert.ok(calls[0].includes('Referer:https://www.bilibili.com/'));
  assert.equal(calls[0].includes('Referer:https://b23.tv/'), false);
  assert.ok(calls[0].includes('--user-agent'));
  assert.ok(calls[0].includes(DEFAULT_UA));

  assert.ok(calls[1].includes('--sleep-requests'));
  assert.ok(calls[1].includes('1'));
  assert.equal(calls[1].filter((arg) => arg === '--add-header').length, 1);
  assert.equal(calls[1].filter((arg) => arg === '--user-agent').length, 1);
  assert.equal(result.title, 'Mock Bili');
  assert.equal(result.duration, 120);
  assert.equal(result.maxHeight, 720);
});

test('runProcess injects expanded Bilibili NO_PROXY hosts and falls back to --proxy "" on HTTP 403', async () => {
  const { runProcess } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'ytdlp.js').replace(/\\/g, '/')}`
  );

  const calls = [];
  const spawnOnce = async (_tool, args, opts = {}) => {
    calls.push({ args, noProxy: opts.env?.NO_PROXY || '' });
    if (calls.length === 1) {
      return {
        code: 1,
        stdout: '',
        stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden',
      };
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  };

  const res = await runProcess(
    { bin: 'yt-dlp', prefix: [] },
    ['-J', 'https://www.bilibili.com/video/BV1rx4n6FEgg'],
    { env: { NO_PROXY: 'localhost' }, spawnOnce },
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].noProxy, /\.bilibili\.com/);
  assert.match(calls[0].noProxy, /\.bilivideo\.net/);
  assert.match(calls[0].noProxy, /\.acgvideo\.com/);
  assert.match(calls[0].noProxy, /\.szbdyd\.com/);
  assert.deepEqual(calls[1].args.slice(0, 2), ['--proxy', '']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'ok');
});

test('explainYtdlpError translates HTTP Error 403 into actionable guidance', async () => {
  const { explainYtdlpError } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'ytdlp.js').replace(/\\/g, '/')}`
  );

  const msg = explainYtdlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden', 1);
  assert.match(msg, /HTTP 403/i);
  assert.match(msg, /Referer/i);
  assert.match(msg, /yt-dlp/i);
  assert.match(msg, /cookies\.txt/i);
});

test('directFromSummary and resolveDirectUrl fill canonical Bilibili Referer and retry transient HTTP 403', async () => {
  const { directFromSummary, resolveDirectUrl } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'direct-url.js').replace(/\\/g, '/')}`
  );
  const { BILIBILI_REFERER, DEFAULT_UA } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'ytdlp.js').replace(/\\/g, '/')}`
  );

  const direct = directFromSummary(
    { formats: [{ vcodec: 'avc1', height: 1080, url: 'https://upos-sz.bilivideo.com/test.m4s' }] },
    1080,
    'https://b23.tv/mock456',
  );
  assert.equal(direct?.referer, BILIBILI_REFERER);

  const calls = [];
  const fakeRun = async (_tool, args) => {
    calls.push(args);
    if (calls.length === 1) {
      return {
        code: 1,
        stdout: '',
        stderr: 'ERROR: HTTP Error 403: Forbidden',
      };
    }
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        formats: [{ vcodec: 'avc1', height: 720, url: 'https://upos-sz.bilivideo.com/zoom.mp4' }],
      }),
    };
  };

  const resolved = await resolveDirectUrl('https://b23.tv/mock456', {
    allowAnonymous: true,
    ytdlp: { bin: 'yt-dlp', prefix: [] },
    run: fakeRun,
    useCache: false,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(`Referer:${BILIBILI_REFERER}`));
  assert.ok(calls[0].includes(DEFAULT_UA));
  assert.ok(calls[1].includes('--sleep-requests'));
  assert.ok(calls[1].includes('1'));
  assert.equal(calls[1].filter((arg) => arg === '--add-header').length, 1);
  assert.equal(calls[1].filter((arg) => arg === '--user-agent').length, 1);
  assert.equal(resolved.referer, BILIBILI_REFERER);

  const { buildRetryArgsWithHeaders } = await import(
    `file://${join(REPO_ROOT, 'vendor', 'dsh-video-storyboard', 'src', 'storyboard', 'ytdlp.js').replace(/\\/g, '/')}`
  );
  const dropped = buildRetryArgsWithHeaders(
    'https://b23.tv/mock456',
    ['--continue', '--add-header', `Referer:${BILIBILI_REFERER}`, 'https://b23.tv/mock456'],
    { dropContinue: true },
  );
  assert.equal(dropped.includes('--continue'), false);
  assert.ok(dropped.includes('--no-continue'));
  assert.equal(dropped.filter((arg) => arg === '--add-header').length, 1);
  assert.equal(dropped.at(-1), 'https://b23.tv/mock456');
});
