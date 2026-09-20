/**
 * @fileoverview Pins the session posture this server hands `createApp()`. The mode is
 * otherwise invisible from the outside on stdio and on a 2026-07-28 HTTP client, which
 * behave identically either way, so the declared value is the only decidable signal here.
 * The HTTP-observable half lives in `tests/index.http-session.test.ts`.
 * @module tests/index.session-mode
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * `src/index.ts` calls `createApp()` at module top level, so the only way to read the
 * options it passes is to stand in for the call. Everything else on the barrel stays real —
 * the tool definitions import `tool` and `z` from it.
 */
vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(async () => ({ services: {}, shutdown: async () => {} })),
}));

import { createApp } from '@cyanheads/mcp-ts-core';

/**
 * Captured at module scope: the entry point runs its `createApp()` call once, on first
 * import, and per-test mock state is reset before the first `it` body runs.
 */
await import('@/index.js');
const calls = vi.mocked(createApp).mock.calls;
const options = calls[0]?.[0] as
  | Partial<{ sessionMode: unknown; setup: unknown; teardown: unknown }>
  | undefined;

describe('createApp session posture', () => {
  it('builds exactly one createApp() call', () => {
    expect(calls).toHaveLength(1);
    expect(options).toBeDefined();
  });

  it('declares stateless in code rather than leaving it to MCP_SESSION_MODE', () => {
    expect(options?.sessionMode).toBe('stateless');
  });

  it('does not require stateful — no tool suspends on ctx.requestInput', () => {
    /**
     * The object form carrying `require: 'stateful'` refuses startup under stateless.
     * The bare string is the shape that must not regress into it.
     */
    expect(typeof options?.sessionMode).toBe('string');
  });

  it('declares no teardown — setup allocates nothing that needs releasing', () => {
    expect(options?.setup).toBeTypeOf('function');
    expect(options?.teardown).toBeUndefined();
  });
});
