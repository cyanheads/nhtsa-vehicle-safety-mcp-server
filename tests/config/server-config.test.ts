/**
 * @fileoverview NHTSA_CLAMP_LIMITS parsing at the server configuration boundary.
 * @module tests/config/server-config
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** A fresh module per call, since the accessor caches its first parse. */
async function loadConfig(value: string | undefined) {
  vi.stubEnv('NHTSA_CLAMP_LIMITS', value);
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('NHTSA_CLAMP_LIMITS', () => {
  it.each(['false', '0', 'no', 'off', 'FALSE', 'Off'])('%j selects strict mode', async (value) => {
    expect((await loadConfig(value))().clampLimits).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE'])('%j keeps clamping', async (value) => {
    expect((await loadConfig(value))().clampLimits).toBe(true);
  });

  /** The last is what a plugin host forwards for an option the user left blank. */
  it.each([undefined, '', `\${user_config.NHTSA_CLAMP_LIMITS}`])(
    '%j reads as unset and clamps',
    async (value) => {
      expect((await loadConfig(value))().clampLimits).toBe(true);
    },
  );

  it('rejects an unrecognized value, naming the variable', async () => {
    const getServerConfig = await loadConfig('maybe');

    expect(() => getServerConfig()).toThrow(/NHTSA_CLAMP_LIMITS/);
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.ConfigurationError }),
    );
  });
});
