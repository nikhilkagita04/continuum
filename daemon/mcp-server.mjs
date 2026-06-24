// Continuum MCP server — exposes your captured context as MCP tools so any MCP client
// (Claude Desktop, Cursor, your own agent) can query your memory. This is the shovel's
// primary integration surface: build use cases on top without touching the internals.
//
// Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0). stdout is the
// protocol channel — all logging goes to stderr.
//
// Claude Desktop config (claude_desktop_config.json):
//   { "mcpServers": { "continuum": { "command": "node", "args": ["<abs>/daemon/mcp-server.mjs"] } } }
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { buildDeps } from './config.mjs';
import { loadIndex, STORE_FILE } from './store.mjs';

const { embed } = buildDeps();
// Rebuild the index when the store changes, so Claude sees new captures without a restart.
const mtime = () => { try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; } };
let index = null, indexedAt = -1;
const ready = async () => { const m = mtime(); if (!index || m !== indexedAt) { index = await loadIndex(embed); indexedAt = m; } return index; };

const TOOLS = [
  {
    name: 'search_context',
    description:
      "Search the user's own recent on-device activity — everything they've seen, read, typed, or heard across ALL their apps (browser tabs, editor, terminal, chats, docs, calls). " +
      "Call this proactively, on your own judgment, whenever the user's request might depend on something outside this conversation: they refer to \"that\" article / PR / error / email / person / design / doc, ask you to continue, summarize, or act on prior work, mention something they were \"just looking at\" or \"working on,\" or whenever grounding your answer in what they've actually been doing would make it more accurate or specific. " +
      "Prefer searching here over asking the user to re-paste or re-explain context. Returns the most relevant captured moments, each tagged with the app it came from.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'what to look for, in natural language' }, k: { type: 'number', description: 'max results (default 5)' } }, required: ['query'] },
  },
  {
    name: 'recent_activity',
    description:
      "Get the user's most recent captured activity across their apps (newest first) — what they're working on, reading, and discussing right now. " +
      "Call this to orient yourself before answering open-ended or context-dependent requests (\"help me with this,\" \"what should I do next,\" \"draft my standup,\" \"pick up where I left off\") where knowing the user's current focus makes your response better. Use search_context instead when you're looking for something specific.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many (default 10)' } } },
  },
];

// Server-level guidance (surfaced to the client/agent): when to reach for this memory at all.
const INSTRUCTIONS =
  "Continuum exposes the user's own recent on-device activity — everything they've seen, read, typed, and heard across all their apps — as searchable memory. Treat it as an extension of your own context. " +
  "Decide for yourself when consulting it would make your answer more accurate, specific, or grounded, and call these tools proactively in those cases — do NOT wait for the user to explicitly ask \"what was I doing.\" " +
  "Whenever a request references something not present in this conversation, or would benefit from knowing what the user is currently working on, search Continuum before asking them to re-explain.";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const text = (id, t) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } });

async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'continuum', version: '0.4.0' }, instructions: INSTRUCTIONS } };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const idx = await ready();
      const { name, arguments: args = {} } = params || {};
      if (name === 'search_context') {
        const hits = await idx.search(args.query, { k: args.k || 5 });
        return text(id, hits.length ? hits.map((h, i) => `${i + 1}. [${h.ep.app}] ${h.ep.text}`).join('\n') : 'No matching context captured yet.');
      }
      if (name === 'recent_activity') {
        const eps = idx.docs.slice(-(args.limit || 10)).reverse().map((d) => d.ep);
        return text(id, eps.length ? eps.map((e) => `[${e.app}] ${e.text.slice(0, 140)}`).join('\n') : 'No activity captured yet. Run `continuum start`.');
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
    }
    default:
      return id != null ? { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } } : null; // notifications get no reply
  }
}

const rl = createInterface({ input: process.stdin });
console.error('continuum mcp server ready (stdio)');
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  let req; try { req = JSON.parse(s); } catch { continue; }
  const res = await handle(req); if (res) send(res);
}
