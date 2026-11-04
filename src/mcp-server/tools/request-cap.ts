/**
 * @fileoverview Caps on how much one call takes on: a `limit` page size or a VIN batch. An
 * over-cap request is clamped to its cap and disclosed with a notice, one log line, and one
 * counter increment. With clamping turned off it comes back rejected, for the handler to throw
 * its declared reason. The advertised schemas read no configuration, so `tools/list` is the
 * same in both modes.
 * @module mcp-server/tools/request-cap
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** A capped input, named as the caller sends it. A bounded set, so safe as a metric attribute. */
export type CappedInput = 'limit' | 'vin';

/** What holding a caller's count to its cap decided. */
export type CapOutcome =
  | { readonly kind: 'within'; readonly applied: number }
  | { readonly kind: 'clamped'; readonly applied: number; readonly requested: number }
  | { readonly kind: 'rejected'; readonly requested: number; readonly cap: number };

/** A tool's page: what an omitted `limit` takes, and the most one page holds. */
export interface PageLimit {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly tool: string;
}

let clamps: ReturnType<typeof createCounter> | undefined;

/**
 * The `limit` input every paginated tool advertises: a positive whole number with no maximum,
 * so an over-cap value reaches the handler to be clamped or rejected there. Not `.int()`, which
 * Zod 4 emits as `maximum: 9007199254740991` and which rejects `1e21` instead of letting it
 * clamp. `multipleOf(1)` advertises the whole-number rule; the refinement catches what it lets
 * through (`1.0000000000000002`) without adding a second message to a value already failed.
 */
export function limitSchema() {
  return z
    .number()
    .multipleOf(1, 'limit must be a whole number')
    .min(1)
    .refine(Number.isInteger, {
      message: 'limit must be a whole number',
      when: ({ issues }) => issues.length === 0,
    });
}

/**
 * Hold a caller's count to `cap`. Within the cap, nothing happens. Over it, the count is clamped,
 * writing one `info` log line and one increment of the `nhtsa.request_cap.clamps` counter; or,
 * when the server is set to reject over-cap requests, it comes back `rejected` and writes
 * neither, for the handler to throw its declared reason.
 * @throws {McpError} `ConfigurationError` from the first configuration read, on an invalid value.
 */
export function holdToCap(
  ctx: Pick<Context, 'log'>,
  request: { cap: number; input: CappedInput; requested: number; tool: string },
): CapOutcome {
  const { cap, input, requested, tool } = request;
  if (requested <= cap) return { kind: 'within', applied: requested };
  if (!getServerConfig().clampLimits) return { kind: 'rejected', requested, cap };

  ctx.log.info('Clamped an over-cap request', { tool, input, requested, applied: cap });
  /** Created on first use: one made before the OTel SDK registers its meter provider stays a no-op. */
  clamps ??= createCounter(
    'nhtsa.request_cap.clamps',
    'Over-cap requests clamped to their cap',
    '{clamp}',
  );
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'nhtsa.request_cap.input': input });
  return { kind: 'clamped', applied: cap, requested };
}

/** {@link holdToCap} for a tool's `limit`; an omitted limit takes the page default. */
export function resolveLimit(
  ctx: Pick<Context, 'log'>,
  page: PageLimit,
  requested: number | undefined,
): CapOutcome {
  return holdToCap(ctx, {
    tool: page.tool,
    input: 'limit',
    requested: requested ?? page.defaultLimit,
    cap: page.maxLimit,
  });
}

/** The `limit_too_large` message, naming the requested limit and the cap it exceeds. */
export function limitTooLargeMessage(outcome: Extract<CapOutcome, { kind: 'rejected' }>): string {
  return `limit ${outcome.requested} exceeds the maximum of ${outcome.cap}.`;
}

/**
 * The notice disclosing a clamped `limit`, or undefined for any other outcome. It names the next
 * offset only while rows remain past this page. `ctx.enrich.notice` is last-wins, so the caller
 * joins this with the call's other notices into one.
 */
export function limitClampNotice(
  outcome: CapOutcome,
  page: { offset: number; returned: number; totalCount: number },
): string | undefined {
  if (outcome.kind !== 'clamped') return;
  const head = `limit ${outcome.requested} exceeds the maximum of ${outcome.applied}; returned ${page.returned}`;
  const next = page.offset + page.returned;
  return next < page.totalCount ? `${head} — continue at offset=${next}.` : `${head}.`;
}
