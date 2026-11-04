/**
 * @fileoverview The over-cap mechanism the capped tools share: the advertised `limit` schema,
 * the clamp with its log line, counter increment, and notice, and the strict-mode rejection.
 * Each tool's own suite proves only that it is wired to this.
 * @module tests/mcp-server/tools/request-cap
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockLogger, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { type Attributes, createNoopMeter, metrics } from '@opentelemetry/api';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's clamp mode, flipped per test; the environment parsing has its own suite. */
const serverConfig = vi.hoisted(() => ({ clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => serverConfig }));

import {
  type CapOutcome,
  holdToCap,
  limitClampNotice,
  limitSchema,
  limitTooLargeMessage,
  resolveLimit,
} from '@/mcp-server/tools/request-cap.js';

/** Counters created and increments recorded through the meter provider registered below. */
const created: string[] = [];
const increments: { name: string; value: number; attributes: Attributes | undefined }[] = [];

/**
 * Registered after the module under test is imported, as the OTel SDK registers its provider
 * after a server's modules load: a counter created at import would miss it and stay a no-op.
 */
beforeAll(() => {
  const meter = Object.assign(createNoopMeter(), {
    createCounter: (name: string) => {
      created.push(name);
      return {
        add: (value: number, attributes?: Attributes) => {
          increments.push({ name, value, attributes });
        },
      };
    },
  });
  expect(metrics.setGlobalMeterProvider({ getMeter: () => meter })).toBe(true);
});

let log: MockContextLogger;

beforeEach(() => {
  serverConfig.clampLimits = true;
  increments.length = 0;
  log = createMockLogger();
});

describe('limitSchema', () => {
  it('advertises a positive whole number with no maximum in both modes', () => {
    const advertised = () =>
      z.toJSONSchema(z.object({ limit: limitSchema() }), { io: 'input' }).properties?.limit;

    const clamping = advertised();
    serverConfig.clampLimits = false;

    expect(clamping).toEqual({ type: 'number', minimum: 1, multipleOf: 1 });
    expect(advertised()).toEqual(clamping);
  });

  it.each([1, 50, 51, 1e21, Number.MAX_SAFE_INTEGER])('accepts %s for the handler', (value) => {
    expect(limitSchema().parse(value)).toBe(value);
  });

  it.each([
    [1.5, 'limit must be a whole number'],
    [1.0000000000000002, 'limit must be a whole number'],
    [0, 'Too small: expected number to be >=1'],
    [-1, 'Too small: expected number to be >=1'],
  ])('rejects %s with one message', (value, message) => {
    const result = limitSchema().safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([message]);
  });
});

describe('holdToCap', () => {
  const request = (requested: number) =>
    ({ tool: 'nhtsa_search_complaints', input: 'limit', requested, cap: 50 }) as const;

  it.each<[number, CapOutcome]>([
    [49, { kind: 'within', applied: 49 }],
    [50, { kind: 'within', applied: 50 }],
  ])('leaves %s alone and writes nothing', (requested, outcome) => {
    expect(holdToCap({ log }, request(requested))).toEqual(outcome);
    expect(log.calls).toEqual([]);
    expect(increments).toEqual([]);
  });

  it.each([51, 1e21])(
    'clamps %s to the cap with one log line and one counter increment',
    (requested) => {
      expect(holdToCap({ log }, request(requested))).toEqual({
        kind: 'clamped',
        applied: 50,
        requested,
      });
      expect(log.calls).toEqual([
        {
          level: 'info',
          msg: 'Clamped an over-cap request',
          data: { tool: 'nhtsa_search_complaints', input: 'limit', requested, applied: 50 },
        },
      ]);
      expect(increments).toEqual([
        {
          name: 'nhtsa.request_cap.clamps',
          value: 1,
          attributes: {
            'mcp.tool.name': 'nhtsa_search_complaints',
            'nhtsa.request_cap.input': 'limit',
          },
        },
      ]);
    },
  );

  it('labels a VIN batch clamp by its input', () => {
    expect(
      holdToCap({ log }, { tool: 'nhtsa_decode_vin', input: 'vin', requested: 57, cap: 50 }),
    ).toEqual({ kind: 'clamped', applied: 50, requested: 57 });
    expect(log.calls[0]?.data).toEqual({
      tool: 'nhtsa_decode_vin',
      input: 'vin',
      requested: 57,
      applied: 50,
    });
    expect(increments.map((i) => i.attributes)).toEqual([
      { 'mcp.tool.name': 'nhtsa_decode_vin', 'nhtsa.request_cap.input': 'vin' },
    ]);
  });

  it('creates its counter once, on the first clamp', () => {
    holdToCap({ log }, request(51));
    holdToCap({ log }, request(52));

    expect(created).toEqual(['nhtsa.request_cap.clamps']);
    expect(increments).toHaveLength(2);
  });

  it('returns an over-cap count rejected, writing nothing, when clamping is off', () => {
    serverConfig.clampLimits = false;

    expect(holdToCap({ log }, request(51))).toEqual({ kind: 'rejected', requested: 51, cap: 50 });
    expect(holdToCap({ log }, request(50))).toEqual({ kind: 'within', applied: 50 });
    expect(log.calls).toEqual([]);
    expect(increments).toEqual([]);
  });
});

describe('resolveLimit', () => {
  const page = { tool: 'nhtsa_lookup_vehicles', defaultLimit: 100, maxLimit: 200 } as const;

  it('takes the page default for an omitted limit', () => {
    expect(resolveLimit({ log }, page, undefined)).toEqual({ kind: 'within', applied: 100 });
    expect(log.calls).toEqual([]);
  });

  it('holds a supplied limit to the page maximum', () => {
    expect(resolveLimit({ log }, page, 201)).toEqual({
      kind: 'clamped',
      applied: 200,
      requested: 201,
    });
    expect(log.calls[0]?.data).toMatchObject({ tool: 'nhtsa_lookup_vehicles', input: 'limit' });
  });
});

describe('limitTooLargeMessage', () => {
  it('names the requested limit and the cap', () => {
    expect(limitTooLargeMessage({ kind: 'rejected', requested: 51, cap: 50 })).toBe(
      'limit 51 exceeds the maximum of 50.',
    );
  });
});

describe('limitClampNotice', () => {
  const clamped: CapOutcome = { kind: 'clamped', applied: 50, requested: 51 };

  it.each<
    [
      string,
      CapOutcome,
      { offset: number; returned: number; totalCount: number },
      string | undefined,
    ]
  >([
    [
      'nothing for a limit within the cap',
      { kind: 'within', applied: 50 },
      { offset: 0, returned: 50, totalCount: 60 },
      undefined,
    ],
    [
      'the next offset while rows remain',
      clamped,
      { offset: 0, returned: 50, totalCount: 51 },
      'limit 51 exceeds the maximum of 50; returned 50 — continue at offset=50.',
    ],
    [
      'the next offset from a later page',
      clamped,
      { offset: 100, returned: 50, totalCount: 400 },
      'limit 51 exceeds the maximum of 50; returned 50 — continue at offset=150.',
    ],
    [
      'no next offset on a page that ends the set exactly',
      clamped,
      { offset: 0, returned: 50, totalCount: 50 },
      'limit 51 exceeds the maximum of 50; returned 50.',
    ],
    [
      'no next offset on a short last page',
      clamped,
      { offset: 0, returned: 30, totalCount: 30 },
      'limit 51 exceeds the maximum of 50; returned 30.',
    ],
    [
      'no next offset past the end',
      clamped,
      { offset: 9000, returned: 0, totalCount: 3 },
      'limit 51 exceeds the maximum of 50; returned 0.',
    ],
    [
      'no next offset on an empty set',
      clamped,
      { offset: 0, returned: 0, totalCount: 0 },
      'limit 51 exceeds the maximum of 50; returned 0.',
    ],
  ])('gives %s', (_case, outcome, page, notice) => {
    expect(limitClampNotice(outcome, page)).toBe(notice);
  });
});
