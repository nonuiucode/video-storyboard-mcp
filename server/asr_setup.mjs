/**
 * asr_setup.mjs — Installer & status inspector for the bundled local sherpa-onnx ASR service.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PLUGIN_ROOT, findOnPathSync } from './env.mjs';
import { canTranscribe, resolveAsrConfig } from '../vendor/dsh-video-storyboard/src/storyboard/asr.js';
import { pythonCandidates } from '../vendor/dsh-video-storyboard/src/storyboard/python.js';

const runFile = promisify(execFile);

export const DEFAULT_ASR_PORT = 18321;

export const MODEL_REGISTRY = Object.freeze({
  sensevoice: {
    id: 'sherpa-sensevoice-int8',
    engine: 'sensevoice',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
    archiveFolder: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    approxDownloadMb: 156,
    hfFiles: {
      'model.int8.onnx': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      'tokens.txt': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
    },
    hfApproxMb: 229,
  },
  paraformer: {
    id: 'sherpa-paraformer-zh',
    engine: 'paraformer',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2',
    archiveFolder: 'sherpa-onnx-paraformer-zh-2024-03-09',
    approxDownloadMb: 950,
    hfFiles: {
      'model.int8.onnx': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/model.int8.onnx',
      'tokens.txt': 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/tokens.txt',
    },
    hfApproxMb: 217,
  },
});

export const VAD_MODEL = Object.freeze({
  filename: 'silero_vad.onnx',
  githubUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  hfUrl: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-vad/resolve/main/silero_vad.onnx',
  approxKb: 629,
});

export function defaultAsrDir(env = process.env) {
  const explicit = typeof env.VIDEO_STORYBOARD_ASR_DIR === 'string' && env.VIDEO_STORYBOARD_ASR_DIR.trim();
  return explicit ? env.VIDEO_STORYBOARD_ASR_DIR.trim() : join(PLUGIN_ROOT, '.asr-runtime');
}

export function managedAsrConfigPath(env = process.env) {
  return join(defaultAsrDir(env), 'asr.json');
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

function resolveBasePython(explicitPython) {
  if (explicitPython && String(explicitPython).trim()) {
    return String(explicitPython).trim();
  }
  const onPath = findOnPathSync('python') || findOnPathSync('python3');
  if (onPath) return onPath;
  const fromCandidates = pythonCandidates().find((c) => existsSync(c));
  if (fromCandidates) return fromCandidates;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function buildDownloadsPlan(spec, mirror, modelDir, vadPath) {
  const preferHf = mirror === 'hf' || (mirror === 'auto' && spec.engine === 'paraformer');
  const downloads = [];
  if (preferHf && spec.hfFiles) {
    for (const [name, url] of Object.entries(spec.hfFiles)) {
      downloads.push({ kind: 'file', url, dest: join(modelDir, name) });
    }
  } else {
    downloads.push({
      kind: 'tar_bz2',
      url: spec.archiveUrl,
      extractDir: modelDir,
      archiveFolder: spec.archiveFolder,
    });
  }
  downloads.push({
    kind: 'file',
    url: mirror === 'hf' ? VAD_MODEL.hfUrl : VAD_MODEL.githubUrl,
    fallbackUrl: VAD_MODEL.githubUrl,
    dest: vadPath,
  });
  return { preferHf, downloads };
}

export function getLocalAsrStatus(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const userConfigPath = join(home, 'asr.json');
  const managedPath = managedAsrConfigPath(env);
  const cfg = resolveAsrConfig(env);
  const ready = canTranscribe(cfg);

  return {
    ready,
    source: cfg.source,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    language: cfg.language,
    configPath: cfg.configPath || null,
    userConfigExists: existsSync(userConfigPath),
    userConfigPath,
    managedInstalled: existsSync(managedPath),
    managedConfigPath: managedPath,
    managedLifecycle: Boolean(cfg.manage?.start),
  };
}

export async function setupLocalAsr({
  model = 'sensevoice',
  mirror = 'auto',
  port = DEFAULT_ASR_PORT,
  language = 'auto',
  python = null,
  dryRun = false,
} = {}) {
  const key = String(model || 'sensevoice').toLowerCase();
  const spec = MODEL_REGISTRY[key];
  if (!spec) {
    throw new Error(`Unsupported ASR model '${model}'. Choose 'sensevoice' or 'paraformer'.`);
  }
  const mirrorChoice = String(mirror || 'auto').toLowerCase();
  if (!['auto', 'github', 'hf'].includes(mirrorChoice)) {
    throw new Error(`Unsupported mirror '${mirror}'. Choose 'auto', 'github', or 'hf'.`);
  }

  const basePy = resolveBasePython(python);
  const asrDir = defaultAsrDir();
  const venvDir = join(asrDir, '.venv');
  const venvPy = venvPythonPath(venvDir);
  const modelDir = join(asrDir, 'models', key);
  const vadPath = join(asrDir, 'models', VAD_MODEL.filename);
  const serverScript = join(PLUGIN_ROOT, 'server', 'asr_server.py');
  const configPath = join(asrDir, 'asr.json');

  const { preferHf, downloads } = buildDownloadsPlan(spec, mirrorChoice, modelDir, vadPath);
  const approxMb = (preferHf ? spec.hfApproxMb : spec.approxDownloadMb) + 1;

  const asrJsonPreview = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    key: 'local',
    model: spec.id,
    language: language === 'auto' ? 'zh' : language,
    manage: {
      start: [
        venvPy,
        serverScript,
        '--engine',
        spec.engine,
        '--model-dir',
        modelDir,
        '--vad',
        vadPath,
        '--port',
        String(port),
        '--language',
        language,
      ],
      idleMs: 5000,
      waitMs: 60000,
    },
  };

  const plan = {
    ok: true,
    dryRun: Boolean(dryRun),
    model: spec.id,
    engine: spec.engine,
    mirror: mirrorChoice,
    port,
    python: basePy,
    asrDir,
    venvDir,
    venvPython: venvPy,
    modelDir,
    vadPath,
    configPath,
    pipPackage: 'sherpa-onnx',
    approxDownloadMb: approxMb,
    downloads,
    asrJsonPreview,
  };

  if (dryRun) {
    return plan;
  }

  await mkdir(asrDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });

  if (!existsSync(venvPy)) {
    await runFile(basePy, ['-m', 'venv', venvDir], { timeout: 120_000, windowsHide: true });
  }

  const pipArgs = ['-m', 'pip', 'install', '--upgrade', 'sherpa-onnx'];
  if (mirrorChoice === 'hf') {
    pipArgs.push('-i', 'https://pypi.tuna.tsinghua.edu.cn/simple');
  }
  await runFile(venvPy, pipArgs, { timeout: 300_000, windowsHide: true });

  // Download & unpack using Python stdlib so Windows/macOS/Linux require no extra tar/bzip2 binaries.
  const dlScript = [
    'import json, pathlib, shutil, sys, tarfile, urllib.request',
    'items = json.loads(sys.argv[1])',
    'def fetch(url, dest):',
    '  req = urllib.request.Request(url, headers={"User-Agent": "video-storyboard-mcp/2.1.0"})',
    '  with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:',
    '    shutil.copyfileobj(r, f)',
    'for item in items:',
    '  if item["kind"] == "file":',
    '    dest = pathlib.Path(item["dest"])',
    '    dest.parent.mkdir(parents=True, exist_ok=True)',
    '    try:',
    '      fetch(item["url"], dest)',
    '    except Exception:',
    '      fb = item.get("fallbackUrl")',
    '      if fb:',
    '        fetch(fb, dest)',
    '      else:',
    '        raise',
    '  elif item["kind"] == "tar_bz2":',
    '    out_dir = pathlib.Path(item["extractDir"])',
    '    out_dir.mkdir(parents=True, exist_ok=True)',
    '    tmp_arc = out_dir / "_archive.tar.bz2"',
    '    fetch(item["url"], tmp_arc)',
    '    with tarfile.open(tmp_arc, "r:bz2") as tf:',
    '      for member in tf.getmembers():',
    '        name = pathlib.Path(member.name).name',
    '        if member.isfile() and name in ("model.int8.onnx", "model.onnx", "tokens.txt"):',
    '          src = tf.extractfile(member)',
    '          if src:',
    '            with open(out_dir / name, "wb") as dst:',
    '              shutil.copyfileobj(src, dst)',
    '    tmp_arc.unlink(missing_ok=True)',
  ].join('\n');

  await runFile(venvPy, ['-c', dlScript, JSON.stringify(downloads)], {
    timeout: 600_000,
    windowsHide: true,
  });

  await writeFile(configPath, `${JSON.stringify(asrJsonPreview, null, 2)}\n`, 'utf8');
  return { ...plan, dryRun: false, installed: true };
}
