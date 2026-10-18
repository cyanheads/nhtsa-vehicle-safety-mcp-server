/**
 * @fileoverview Pins the error envelope a client actually receives from these tools, across
 * both consumption surfaces. The handler tests elsewhere call handlers directly and see the
 * thrown `McpError`; `runToolContract` routes through the production rejection and rendering
 * path instead, which is where the code, the `Recovery:` line, and the reason/retryable
 * suffix are decided. Nothing else in the suite covers that boundary.
 * @module tests/error-envelope
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { decodeVin } from '@/mcp-server/tools/definitions/decode-vin.tool.js';
import { getSafetyRatings } from '@/mcp-server/tools/definitions/get-safety-ratings.tool.js';
import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { searchComplaints } from '@/mcp-server/tools/definitions/search-complaints.tool.js';
import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { initNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

/**
 * Both cases below reject before any upstream call, so the real service is safe here and
 * keeps the seam wide enough to include the accessor the handlers go through.
 */
beforeAll(() => {
  initNhtsaService();
});

afterEach(() => vi.unstubAllGlobals());

describe('normalized argument contracts (#36)', () => {
  it.each([
    [searchComplaints, { make: '  ', model: 'Camry', modelYear: 2020 }, 'invalid_arguments'],
    [searchComplaints, { make: 'Toyota', model: ' ', modelYear: 2020 }, 'invalid_arguments'],
    [getVehicleSafety, { make: ' ', model: 'Camry', modelYear: 2020 }, 'invalid_arguments'],
    [getVehicleSafety, { make: 'Toyota', model: '\t', modelYear: 2020 }, 'invalid_arguments'],
    [getSafetyRatings, { vehicleId: 14855, make: 'Toyota' }, 'mode_conflict'],
    [getSafetyRatings, { vehicleId: 14855, model: 'Camry' }, 'mode_conflict'],
    [getSafetyRatings, { vehicleId: 14855, modelYear: 2020 }, 'mode_conflict'],
    [decodeVin, { vin: ['1HGCM82633A004352', ' '] }, 'empty_vin_list'],
    [decodeVin, { vin: [' ', '\t'] }, 'empty_vin_list'],
    [lookupVehicles, { operation: 'models', make: ' ' }, 'missing_operation_arg'],
    [lookupVehicles, { operation: 'vehicle_types', make: ' ' }, 'missing_operation_arg'],
    [lookupVehicles, { operation: 'manufacturer', manufacturer: ' ' }, 'missing_operation_arg'],
  ] as const)('rejects before fetching: %s %j', async (definition, args, reason) => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected upstream work'));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(definition as typeof searchComplaints, args as never);
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).data?.reason).toBe(reason);
    expect(envelopeOf(result).data?.recovery?.hint).toBeTypeOf('string');
    expect(textOf(result)).toContain(envelopeOf(result).data!.recovery!.hint!);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['makes', { make: 'Toyota' }],
    ['makes', { modelYear: 2020 }],
    ['makes', { manufacturer: 'Honda' }],
    ['models', { make: 'Toyota', manufacturer: 'Honda' }],
    ['vehicle_types', { make: 'Toyota', modelYear: 2020 }],
    ['vehicle_types', { make: 'Toyota', manufacturer: 'Honda' }],
    ['manufacturer', { manufacturer: 'Honda', make: 'Toyota' }],
    ['manufacturer', { manufacturer: 'Honda', modelYear: 2020 }],
  ] as const)('rejects inactive %s arguments %j', async (operation, args) => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected upstream work'));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(lookupVehicles, {
      operation,
      ...args,
      offset: 1,
      limit: 2,
    });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).data?.reason).toBe('inactive_argument');
    expect(textOf(result)).toContain('Recovery:');
    expect(fetch).not.toHaveBeenCalled();
  });
});

interface ErrorEnvelope {
  code?: number;
  data?: { reason?: string; recovery?: { hint?: string }; retryable?: boolean };
  message?: string;
}

/** The `error` object a rejected call puts on `structuredContent`. */
function envelopeOf(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error?: ErrorEnvelope } | undefined)?.error ?? {};
}

/** The rendered `content[0].text` a `content[]`-reading client sees. */
function textOf(result: { content?: unknown }): string {
  const first = (result.content as { text?: string }[] | undefined)?.[0];
  expect(typeof first?.text).toBe('string');
  return first?.text ?? '';
}

describe('argument rejection', () => {
  it('is InvalidParams (-32602), not ValidationError', async () => {
    const result = await runToolContract(searchRecalls, {
      modelYear: 'two thousand twenty',
    } as never);

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).code).toBe(-32602);
  });

  it('names the offending field in text without pinning the whole string', async () => {
    const result = await runToolContract(searchRecalls, {
      modelYear: 'two thousand twenty',
    } as never);

    const text = textOf(result);
    expect(text).toContain('nhtsa_search_recalls');
    expect(text).toContain('modelYear');
  });

  it('carries the invalid_arguments reason and a synthesized recovery hint', async () => {
    const envelope = envelopeOf(
      await runToolContract(searchRecalls, { modelYear: 'two thousand twenty' } as never),
    );

    expect(envelope.data?.reason).toBe('invalid_arguments');
    expect(envelope.data?.recovery?.hint).toBeTypeOf('string');
    expect(envelope.data?.recovery?.hint?.length).toBeGreaterThan(0);
  });

  it('renders a missing required field as missing rather than as a wrong choice', async () => {
    /** `vin` is the only required field; omitting it must read as absent, not malformed. */
    const result = await runToolContract(decodeVin, {} as never);

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).code).toBe(-32602);
    expect(textOf(result)).toContain('vin');
  });
});

describe('declared contract reason', () => {
  it('forwards the declared recovery hint onto the wire', async () => {
    const envelope = envelopeOf(
      await runToolContract(searchRecalls, {
        campaignNumber: '20V682000',
        make: 'Toyota',
      }),
    );

    expect(envelope.data?.reason).toBe('mode_conflict');
    expect(envelope.data?.recovery?.hint).toBe(
      'Use either campaignNumber or make + model + modelYear, not both.',
    );
  });

  it('closes content text with the reason a caller branches on', async () => {
    const text = textOf(
      await runToolContract(searchRecalls, {
        campaignNumber: '20V682000',
        make: 'Toyota',
      }),
    );

    expect(text).toContain('(reason mode_conflict');
    expect(text).toContain('Recovery:');
  });

  it('applies the same shape to a second tool and reason', async () => {
    const result = await runToolContract(decodeVin, {
      vin: Array.from({ length: 51 }, (_, i) => `VIN${i}`),
    });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).data?.reason).toBe('batch_too_large');
    expect(textOf(result)).toContain('(reason batch_too_large');
  });

  it('keeps the numeric code out of content text and on structuredContent', async () => {
    const result = await runToolContract(decodeVin, { vin: '   ' });

    expect(envelopeOf(result).data?.reason).toBe('empty_vin_list');
    expect(envelopeOf(result).code).toBeTypeOf('number');
    expect(textOf(result)).not.toContain('-32007');
  });
});
