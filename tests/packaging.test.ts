/**
 * @fileoverview Guards `manifest.json` against a defect `JSON.parse` cannot surface: a key
 * declared twice in the same object. The parser keeps the last value and discards the first
 * silently, so every check that reads the parsed manifest — `lint:packaging` included —
 * passes over it, and the file can sit for releases carrying a stale line nobody reads.
 * @module tests/packaging
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The `mcp_config.env` block as `manifest.json` carried it before the duplicate was
 * removed: a stale literal shadowed by the `${user_config.…}` reference that supersedes it.
 * Kept verbatim so the detector below is exercised against the real defect, not a sketch.
 */
const MANIFEST_WITH_DUPLICATE = `{
  "server": {
    "mcp_config": {
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "MCP_LOG_LEVEL": "\${user_config.MCP_LOG_LEVEL}"
      }
    }
  }
}`;

/**
 * Returns every `path.to.key` that its enclosing object declares more than once.
 *
 * Walks the raw text rather than a parsed value, because the duplicate is gone by the time
 * `JSON.parse` returns. Only a string in key position matters, so the scanner tracks
 * whether the last token was a `{` or `,` inside an object, and skips escaped quotes.
 */
function findDuplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: { key: string | undefined; seen: Set<string> }[] = [];
  const path: string[] = [];
  let expectKey = false;
  let pendingKey: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      let value = '';
      i++;
      for (; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          value += text[i] + (text[i + 1] ?? '');
          i++;
          continue;
        }
        value += text[i];
      }
      if (expectKey) {
        pendingKey = value;
        expectKey = false;
        const frame = stack.at(-1);
        if (frame) {
          if (frame.seen.has(value)) duplicates.push([...path, value].join('.'));
          frame.seen.add(value);
        }
      }
      continue;
    }

    if (ch === '{') {
      stack.push({ key: pendingKey, seen: new Set() });
      if (pendingKey !== undefined) path.push(pendingKey);
      pendingKey = undefined;
      expectKey = true;
      continue;
    }

    if (ch === '}') {
      const frame = stack.pop();
      if (frame?.key !== undefined) path.pop();
      expectKey = false;
      continue;
    }

    if (ch === ',') {
      expectKey = stack.length > 0;
      pendingKey = undefined;
      continue;
    }

    if (ch === ':') {
      expectKey = false;
    }
  }

  return duplicates;
}

/**
 * The only substitution an MCPB host performs on an `mcp_config.env` value, matched rather
 * than compared so the placeholder never appears as a string literal a linter reads as an
 * un-interpolated template.
 */
const USER_CONFIG_REF = /^\$\{user_config\.([\w-]+)\}$/;

const manifestText = readFileSync(new URL('../manifest.json', import.meta.url).pathname, 'utf8');
const manifest = JSON.parse(manifestText) as {
  server?: { mcp_config?: { env?: Record<string, string> } };
  user_config?: Record<string, unknown>;
};

describe('duplicate-key detection', () => {
  it('flags the shadowed MCP_LOG_LEVEL line the manifest used to carry', () => {
    expect(findDuplicateJsonKeys(MANIFEST_WITH_DUPLICATE)).toEqual([
      'server.mcp_config.env.MCP_LOG_LEVEL',
    ]);
  });

  it('reports nothing for an object whose keys are all distinct', () => {
    expect(findDuplicateJsonKeys('{"a": 1, "b": {"a": 2, "c": 3}}')).toEqual([]);
  });

  it('does not mistake a repeated string value for a repeated key', () => {
    expect(findDuplicateJsonKeys('{"a": "dup", "b": "dup"}')).toEqual([]);
  });

  it('descends past the first level into nested objects', () => {
    expect(findDuplicateJsonKeys('{"outer": {"inner": {"x": 1, "x": 2}}}')).toEqual([
      'outer.inner.x',
    ]);
  });
});

describe('manifest.json', () => {
  it('declares every key exactly once', () => {
    expect(findDuplicateJsonKeys(manifestText)).toEqual([]);
  });

  it('routes MCP_LOG_LEVEL through the declared user_config option', () => {
    const wired = manifest.server?.mcp_config?.env?.MCP_LOG_LEVEL ?? '';
    expect(USER_CONFIG_REF.exec(wired)?.[1]).toBe('MCP_LOG_LEVEL');
    expect(manifest.user_config).toHaveProperty('MCP_LOG_LEVEL');
  });

  it('declares every user_config option it references', () => {
    const env = manifest.server?.mcp_config?.env ?? {};
    const referenced = Object.values(env)
      .map((value) => USER_CONFIG_REF.exec(value)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) expect(manifest.user_config).toHaveProperty(name);
  });

  it('sets no env value to the empty string, which would mask an exported key', () => {
    for (const value of Object.values(manifest.server?.mcp_config?.env ?? {})) {
      expect(value).not.toBe('');
    }
  });
});
