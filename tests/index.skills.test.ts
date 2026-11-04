/**
 * @fileoverview Boots the real entry point over HTTP and asserts the root `skills/` tree is
 * served through the MCP Skills extension: advertised at `initialize`, listed by
 * `resources/list` as `skill://<name>/SKILL.md`, and returned byte for byte by
 * `resources/read`. The entry resolves `skills` against the application root, so a missing
 * folder fails the boot before any assertion runs.
 * @module tests/index.skills
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Clear of the server's 3010 default and the session-mode test's port. Repeated below. */
const ORIGIN = 'http://127.0.0.1:39218';

const SKILL_NAME = 'nhtsa-vehicle-safety-guide';
const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
const SKILL_FILE = new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);

/** Hoisted above the module imports: the framework parses its config on first import. */
vi.hoisted(() => {
  process.env.MCP_TRANSPORT_TYPE = 'http';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.MCP_HTTP_PORT = '39218';
  process.env.MCP_AUTH_MODE = 'none';
  process.env.MCP_LOG_LEVEL = 'error';
  process.env.MCP_FORCE_CONSOLE_LOGGING = 'true';
});

let shutdown: () => Promise<void>;

beforeAll(async () => {
  const entry = await import('@/index.js');
  shutdown = () => entry.app.shutdown('test');
});

afterAll(async () => {
  await shutdown?.();
});

/** One JSON-RPC request; Hono answers as JSON or as SSE frames depending on Accept. */
async function rpc(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.ok).toBe(true);
  const body = await res.text();
  const frames = body.startsWith('event:')
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)))
    : [JSON.parse(body)];
  const reply = frames.find((frame) => frame.id === 1);
  expect(reply?.error).toBeUndefined();
  return reply?.result;
}

describe('published skills', () => {
  it('advertises the Skills extension at initialize', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'nhtsa-skills-test', version: '0.0.0' },
    });
    expect(result?.capabilities?.extensions).toHaveProperty(['io.modelcontextprotocol/skills']);
  });

  it('lists the skill as a skill:// resource', async () => {
    const result = await rpc('resources/list', {});
    const listed = (result?.resources ?? []) as { uri: string; name: string }[];
    expect(listed).toContainEqual(expect.objectContaining({ uri: SKILL_URI, name: SKILL_NAME }));
  });

  it('reads back the SKILL.md on disk', async () => {
    const result = await rpc('resources/read', { uri: SKILL_URI });
    const [content] = (result?.contents ?? []) as { uri: string; text?: string }[];
    expect(content?.uri).toBe(SKILL_URI);
    expect(content?.text).toBe(readFileSync(SKILL_FILE, 'utf8'));
  });
});
