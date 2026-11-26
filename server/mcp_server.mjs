/**
 * mcp_server.mjs — Stdio JSON-RPC 2.0 MCP server for Antigravity (`video-storyboard` v2.0.0).
 *
 * Pure Node.js stdlib over newline-delimited JSON on stdin/stdout.
 * Redirects console.log/info/debug to stderr BEFORE importing adapter/upstream
 * modules so stdout carries valid JSON-RPC frames exclusively.
 */

import readline from 'node:readline';

// Guard stdout before dynamic import of adapter + vendored upstream modules.
const writeStderr = (...args) => {
  const line = args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  process.stderr.write(`${line}\n`);
};
console.log = writeStderr;
console.info = writeStderr;
console.debug = writeStderr;
console.warn = writeStderr;

const { callMcpTool, listMcpTools } = await import('./adapter.mjs');

const SERVER_INFO = { name: 'video-storyboard', version: '2.2.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleRequest(req) {
  const reqId = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params && typeof req.params === 'object' ? req.params : {};

  if (method.startsWith('notifications/') || reqId === undefined || reqId === null) {
    return null;
  }

  if (method === 'initialize') {
    const proto = typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
      ? params.protocolVersion.trim()
      : DEFAULT_PROTOCOL_VERSION;
    return {
      jsonrpc: '2.0',
      id: reqId,
      result: {
        protocolVersion: proto,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id: reqId, result: {} };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id: reqId, result: { resources: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id: reqId, result: { prompts: [] } };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: reqId, result: { tools: listMcpTools() } };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const { content } = await callMcpTool(toolName, args, { saveDir: null });
      return { jsonrpc: '2.0', id: reqId, result: { content } };
    } catch (err) {
      const stack = err?.stack || String(err);
      process.stderr.write(`${stack}\n`);
      return {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }],
          isError: true,
        },
      };
    }
  }

  return errorResponse(reqId, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

// Serialize message processing so async tool calls keep clean output ordering.
let queue = Promise.resolve();
rl.on('line', (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  queue = queue.then(async () => {
    let req;
    try {
      req = JSON.parse(line);
    } catch (err) {
      writeMessage(errorResponse(null, -32700, `Parse error: ${err.message}`));
      return;
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      writeMessage(errorResponse(null, -32600, 'Invalid Request'));
      return;
    }
    const resp = await handleRequest(req);
    if (resp !== null) writeMessage(resp);
  }).catch((err) => {
    process.stderr.write(`Fatal request error: ${err?.stack || err}\n`);
  });
});

rl.on('close', () => {
  queue.finally(() => process.exit(0));
});
