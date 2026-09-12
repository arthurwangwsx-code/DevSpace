// Explicit integration check; writes only a fresh temporary workspace under the
// supplied approved directory and removes that fixture on completion.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/mcp-smoke.mjs APPROVED_PARENT [MCP_URL]');
const root = await mkdtemp(join(resolve(process.argv[2]), '.devspace-smoke-'));
const client = new Client({ name: 'devspace-smoke', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL(process.argv[3] ?? 'http://127.0.0.1:7676/mcp'));
let workspaceId;
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
  assert.ok(!result.isError, JSON.stringify(result.content).slice(0, 500));
  return result;
};
try {
  await client.connect(transport);
  workspaceId = (await call('open_workspace', { path: root })).structuredContent.workspaceId;
  const original = '中文🙂'.repeat(220_000) + '\nend\n';
  await call('apply_patch', { workspaceId, patch: `*** Begin Patch\n*** Add File: payload.txt\n+${original.replaceAll('\n', '\n+').replace(/\+$/, '')}*** End Patch` });
  const hash = createHash('sha256');
  let byteOffset = 0;
  let pages = 0;
  while (true) {
    const page = await call('read', { workspaceId, path: 'payload.txt', byteOffset });
    const text = page.structuredContent.result;
    const marker = text.match(/\n\[More content: continue with byteOffset=(\d+);[^\]]+\]$/);
    hash.update(marker ? text.slice(0, marker.index) : text);
    pages++;
    if (!marker) break;
    assert.ok(Number(marker[1]) > byteOffset);
    byteOffset = Number(marker[1]);
  }
  assert.equal(hash.digest('hex'), createHash('sha256').update(original).digest('hex'));
  const command = await call('exec_command', { workspaceId, cmd: 'pwd', yield_time_ms: 1000 });
  assert.equal(command.structuredContent.exitCode, 0);
  // Intentional release is part of the recovery test, never an end-of-chat policy.
  await call('release_workspace', { workspaceId });
  await call('read', { workspaceId, path: 'payload.txt', byteOffset: Buffer.byteLength(original) - 4 });
  console.log(JSON.stringify({ ok: true, payloadBytes: Buffer.byteLength(original), pages, hashVerified: true, workspaceRestored: true }));
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close();
  await rm(root, { recursive: true, force: true });
}
