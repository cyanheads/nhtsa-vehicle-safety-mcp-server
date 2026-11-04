/**
 * @fileoverview Server-specific configuration, parsed from the environment on first read.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Clamp an over-cap page size or VIN batch to its cap with a notice; false rejects it instead',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * The parsed server configuration, cached after the first read.
 * @throws {McpError} `ConfigurationError` naming the variable when a value fails to parse.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, { clampLimits: 'NHTSA_CLAMP_LIMITS' });
  return _config;
}
