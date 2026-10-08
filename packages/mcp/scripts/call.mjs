#!/usr/bin/env node
// Calls one tool of the built server over stdio, the way an MCP host does, and prints its text block.
//   node scripts/call.mjs <tool> '<json arguments>' [--json]
//   node scripts/call.mjs --list
// The server gets this process's environment (SPECFIRST_API_BASE, MONAD_TESTNET_RPC and the rest).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const [tool, argsJson = '{}', flag] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/call.mjs <tool> '<json arguments>' [--json] | --list");
  process.exit(2);
}

const client = new Client({ name: 'specfirst-call', version: '0.0.1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env }, stderr: 'inherit' });
await client.connect(transport);
try {
  if (tool === '--list') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\n  input: ${JSON.stringify(t.inputSchema)}\n`);
  } else {
    const res = await client.callTool({ name: tool, arguments: JSON.parse(argsJson) });
    if (flag === '--json') console.log(JSON.stringify(res.structuredContent ?? res, null, 2));
    else console.log(res.content?.[0]?.text ?? JSON.stringify(res));
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
