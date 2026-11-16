/**
 * @fileoverview Pins the error envelope a client actually receives from these tools, across
 * both consumption surfaces. The handler tests elsewhere call handlers directly and see the
 * thrown `McpError`; `runToolContract` routes through the production rejection and rendering
 * path instead, which is where the code, the `Recovery:` line, and the reason/retryable
 * suffix are decided, and where an upstream's error body is kept off the wire. Nothing else in
 * the suite covers that boundary.
 * @module tests/error-envelope
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { decodeVin } from '@/mcp-server/tools/definitions/decode-vin.tool.js';
import { getSafetyRatings } from '@/mcp-server/tools/definitions/get-safety-ratings.tool.js';
import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { searchComplaints } from '@/mcp-server/tools/definitions/search-complaints.tool.js';
import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { initNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { readerText } from './helpers/content.js';

/**
 * The argument cases reject before any upstream call and the upstream cases stub `fetch`, so the
 * real service is safe here and keeps the seam wide enough to include the accessor the handlers
 * go through.
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
    [decodeVin, { vin: '1HGCM-82633A004352' }, 'invalid_vin'],
    [lookupVehicles, { operation: 'models', make: ' ' }, 'missing_operation_arg'],
    [lookupVehicles, { operation: 'dataset_models', make: 'Chevrolet' }, 'missing_operation_arg'],
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

  it('accepts make on makes as a name filter (#62)', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(new URL(url).hostname).toBe('vpic.nhtsa.dot.gov');
      return Response.json({
        Count: 3,
        Message: 'Response returned successfully',
        SearchCriteria: null,
        Results: [
          { Make_ID: 448, Make_Name: 'TOYOTA' },
          { Make_ID: 449, Make_Name: 'MERCEDES-BENZ' },
          { Make_ID: 10_004, Make_Name: 'TOYOTA TSUSHO AMERICA' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(lookupVehicles, {
      operation: 'makes',
      make: 'Toyota',
      offset: 1,
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      returned: 1,
      makes: [{ makeId: 10_004, makeName: 'TOYOTA TSUSHO AMERICA' }],
      effectiveQuery: 'makes make=Toyota offset=1 limit=2',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
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

/**
 * What a `content[]`-reading client sees in `content[0]`, read through a CommonMark parse: the
 * error message, hint, and reason render with Markdown escapes, so the raw text is not the value.
 */
function textOf(result: { content?: unknown }): string {
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  expect(typeof first?.text).toBe('string');
  return first ? readerText([first]) : '';
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
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected upstream work'));
    vi.stubGlobal('fetch', fetch);
    /** 501 full VINs in one joined string: past the per-call ceiling, which no mode clamps. */
    const result = await runToolContract(decodeVin, {
      vin: Array.from({ length: 501 }, (_, i) => `1HGCM82633A${String(i).padStart(6, '0')}`).join(
        ' ',
      ),
    });

    expect(fetch).not.toHaveBeenCalled();
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

describe('notices in content[]', () => {
  it('render caller text quoted in a notice as written', async () => {
    const make = '*x* [y](z)';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Count: 0, Message: '', SearchCriteria: '', Results: [] })),
    );

    const result = await runToolContract(lookupVehicles, { operation: 'models', make });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain(`"${make}"`);
    expect(readerText(result.content as { type: string; text?: string }[])).toContain(notice);
  });

  it.each([
    ['nhtsa_decode_vin', decodeVin],
    ['nhtsa_get_safety_ratings', getSafetyRatings],
    ['nhtsa_get_vehicle_safety', getVehicleSafety],
    ['nhtsa_lookup_vehicles', lookupVehicles],
    ['nhtsa_search_complaints', searchComplaints],
    ['nhtsa_search_investigations', searchInvestigations],
    ['nhtsa_search_recalls', searchRecalls],
  ] as const)('%s renders its notice so a reader sees it as written', (_name, definition) => {
    const notice = 'No match for "*x* `y` [z](w)".\n- not a list item';
    const { enrichmentTrailer } = definition as {
      enrichmentTrailer?: { notice?: { render?(value: string): string } };
    };
    const rendered = enrichmentTrailer?.notice?.render?.(notice);

    expect(rendered).toBeTypeOf('string');
    expect(readerText([{ type: 'text', text: rendered! }])).toBe(notice);
  });
});

describe('upstream HTML error pages', () => {
  /** The page a proxy in front of an NHTSA host serves in place of the data it asked for. */
  const HTML_ERROR_PAGE =
    '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>';

  it.each([
    [
      'a JSON API answering 414',
      searchRecalls,
      { make: 'Toyota', model: 'Camry', modelYear: 2020 },
      { status: 414, statusText: 'URI Too Long' },
      { code: -32600, message: 'NHTSA returned HTTP 414 URI Too Long.' },
    ],
    [
      'a bulk file answering 502',
      searchInvestigations,
      { make: 'Toyota' },
      { status: 502, statusText: 'Bad Gateway' },
      { code: -32000, message: 'Fetch failed for https://static.nhtsa.gov/…. Status: 502' },
    ],
  ] as const)(
    'keeps the page from %s off both surfaces',
    async (_label, definition, args, init, wire) => {
      const fetch = vi.fn(
        async () =>
          new Response(HTML_ERROR_PAGE, { ...init, headers: { 'Content-Type': 'text/html' } }),
      );
      vi.stubGlobal('fetch', fetch);

      const result = await runToolContract(definition as typeof searchRecalls, args as never);

      expect(result.isError).toBe(true);
      expect(envelopeOf(result)).toMatchObject({ ...wire, data: { status: init.status } });
      expect(envelopeOf(result).data).not.toHaveProperty('body');
      expect(envelopeOf(result).data).not.toHaveProperty('responseBody');
      expect(textOf(result)).toContain(wire.message);
      expect(JSON.stringify(result)).not.toContain('<');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
