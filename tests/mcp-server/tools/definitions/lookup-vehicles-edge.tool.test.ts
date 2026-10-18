/**
 * @fileoverview Additional coverage for nhtsa_lookup_vehicles — vehicle_types operation,
 * manufacturer empty results, and format edge cases.
 * @module tests/mcp-server/tools/definitions/lookup-vehicles-edge.tool
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Keeps the real MANUFACTURER_RESULT_CAP so cap assertions track the service constant. */
vi.mock('@/services/nhtsa/nhtsa-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nhtsa/nhtsa-service.js')>()),
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { getNhtsaService, MANUFACTURER_RESULT_CAP } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

const mockService = {
  getAllMakes: vi.fn(),
  getModels: vi.fn(),
  getVehicleTypes: vi.fn(),
  getManufacturer: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

describe('lookupVehicles — vehicle_types operation', () => {
  it.each(['makes', 'models', 'vehicle_types', 'manufacturer'] as const)(
    'assembles one recovery for %s (#39)',
    async (operation) => {
      mockService.getAllMakes.mockResolvedValue([{ makeId: 1, makeName: 'TOYOTA' }]);
      mockService.getModels.mockResolvedValue([
        { makeId: 1, makeName: 'TOYOTA', modelId: 1, modelName: 'CAMRY' },
      ]);
      mockService.getVehicleTypes.mockResolvedValue([{ vehicleTypeId: 2, vehicleTypeName: 'Car' }]);
      mockService.getManufacturer.mockResolvedValue([
        { manufacturerId: 1, manufacturerName: 'TOYOTA', vehicleTypes: [] },
      ]);
      const args =
        operation === 'manufacturer'
          ? { manufacturer: 'Toyota' }
          : operation === 'makes'
            ? {}
            : { make: 'Toyota' };
      const result = await runToolContract(lookupVehicles, {
        operation,
        ...args,
        offset: 99,
        limit: 1,
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text.split('try a smaller offset').length - 1).toBe(1);
      expect(text).not.toMatch(/spelling/i);
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        returned: 0,
        notice: expect.stringContaining('try a smaller offset'),
      });
    },
  );

  it('assembles one cap disclosure and one recovery (#39)', async () => {
    mockService.getManufacturer.mockResolvedValue(
      Array.from({ length: MANUFACTURER_RESULT_CAP }, (_, manufacturerId) => ({
        manufacturerId,
        manufacturerName: 'Synthetic manufacturer',
        vehicleTypes: [],
      })),
    );
    const result = await runToolContract(lookupVehicles, {
      operation: 'manufacturer',
      manufacturer: 'a',
      offset: MANUFACTURER_RESULT_CAP,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text.split('try a smaller offset').length - 1).toBe(1);
    expect(text.split('Retrieval stopped at').length - 1).toBe(1);
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      cap: MANUFACTURER_RESULT_CAP,
      shown: MANUFACTURER_RESULT_CAP,
    });
  });
  it('returns vehicle types for a make', async () => {
    mockService.getVehicleTypes.mockResolvedValue([
      { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
      { vehicleTypeId: 7, vehicleTypeName: 'Multipurpose Passenger Vehicle (MPV)' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types', make: 'Toyota' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.operation).toBe('vehicle_types');
    expect(result.totalCount).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.vehicleTypes).toHaveLength(2);
    expect(result.vehicleTypes![0]!.vehicleTypeName).toBe('Passenger Car');
    expect(mockService.getVehicleTypes).toHaveBeenCalledWith('Toyota', expect.anything());
  });

  it('vehicle_types: empty result populates enrichment notice', async () => {
    mockService.getVehicleTypes.mockResolvedValue([]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types', make: 'UnknownMake' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/verify the make spelling/i);
  });

  it('vehicle_types: out-of-bounds offset surfaces recovery notice', async () => {
    mockService.getVehicleTypes.mockResolvedValue([
      { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'vehicle_types',
      make: 'Toyota',
      offset: 10,
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.returned).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/try a smaller offset/i);
  });

  it('vehicle_types: effectiveQuery includes make name', async () => {
    mockService.getVehicleTypes.mockResolvedValue([
      { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types', make: 'Toyota' });
    await lookupVehicles.handler(input, ctx);

    expect(getEnrichment(ctx).effectiveQuery).toContain('vehicle_types');
    expect(getEnrichment(ctx).effectiveQuery).toContain('Toyota');
  });
});

describe('lookupVehicles — manufacturer operation edges', () => {
  it('empty manufacturer result surfaces enrichment notice', async () => {
    mockService.getManufacturer.mockResolvedValue([]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'manufacturer',
      manufacturer: 'UnknownManufacturer',
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/manufacturers matching/i);
  });

  it('manufacturer: discloses the retrieval cap via truncation enrichment', async () => {
    mockService.getManufacturer.mockResolvedValue(
      Array.from({ length: MANUFACTURER_RESULT_CAP }, (_, i) => ({
        manufacturerId: i,
        manufacturerName: `MFR ${i}`,
        vehicleTypes: [],
      })),
    );

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'manufacturer',
      manufacturer: 'a',
      limit: 2,
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(MANUFACTURER_RESULT_CAP);
    expect(result.returned).toBe(2);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(MANUFACTURER_RESULT_CAP);
    expect(enrichment.cap).toBe(MANUFACTURER_RESULT_CAP);
    expect(enrichment.notice as string).toMatch(/more may exist/i);
  });

  it('manufacturer: leaves truncation unset when the match set is under the cap', async () => {
    mockService.getManufacturer.mockResolvedValue([
      { manufacturerId: 987, manufacturerName: 'TOYOTA', country: 'JAPAN', vehicleTypes: [] },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'manufacturer', manufacturer: 'Toyota' });
    await lookupVehicles.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('manufacturer: composes the out-of-bounds notice with the cap disclosure', async () => {
    mockService.getManufacturer.mockResolvedValue(
      Array.from({ length: MANUFACTURER_RESULT_CAP }, (_, i) => ({
        manufacturerId: i,
        manufacturerName: `MFR ${i}`,
        vehicleTypes: [],
      })),
    );

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'manufacturer',
      manufacturer: 'a',
      offset: MANUFACTURER_RESULT_CAP,
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.returned).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no results for this page/i);
    expect(notice).toMatch(/more may exist/i);
  });

  it('manufacturer: out-of-bounds offset surfaces recovery notice', async () => {
    mockService.getManufacturer.mockResolvedValue([
      {
        manufacturerId: 987,
        manufacturerName: 'TOYOTA',
        country: 'JAPAN',
        vehicleTypes: [],
      },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'manufacturer',
      manufacturer: 'Toyota',
      offset: 99,
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.returned).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/try a smaller offset/i);
  });
});

describe('lookupVehicles — makes effectiveQuery', () => {
  it('effectiveQuery reflects offset and limit for makes operation', async () => {
    mockService.getAllMakes.mockResolvedValue([
      { makeId: 1, makeName: 'A' },
      { makeId: 2, makeName: 'B' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'makes', limit: 10, offset: 5 });
    await lookupVehicles.handler(input, ctx);

    const query = getEnrichment(ctx).effectiveQuery as string;
    expect(query).toContain('offset=5');
    expect(query).toContain('limit=10');
  });
});

describe('lookupVehicles — format', () => {
  it('format renders vehicle_types list', () => {
    const output = {
      operation: 'vehicle_types',
      totalCount: 2,
      returned: 2,
      offset: 0,
      limit: 100,
      vehicleTypes: [
        { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
        { vehicleTypeId: 7, vehicleTypeName: 'MPV' },
      ],
    };
    const text = firstText(lookupVehicles.format!(output));
    expect(text).toContain('Passenger Car');
    expect(text).toContain('MPV');
  });

  it('format renders models list with make and IDs', () => {
    const output = {
      operation: 'models',
      totalCount: 2,
      returned: 2,
      offset: 0,
      limit: 100,
      models: [
        { modelId: 1, modelName: 'CAMRY', makeId: 441, makeName: 'TOYOTA' },
        { modelId: 2, modelName: 'COROLLA', makeId: 441, makeName: 'TOYOTA' },
      ],
    };
    const text = firstText(lookupVehicles.format!(output));
    expect(text).toContain('CAMRY');
    expect(text).toContain('COROLLA');
    expect(text).toContain('TOYOTA');
    expect(text).toContain('Model ID: 1');
  });

  it('format renders "No results" message when returned is 0', () => {
    const output = {
      operation: 'makes',
      totalCount: 0,
      returned: 0,
      offset: 0,
      limit: 100,
    };
    const text = firstText(lookupVehicles.format!(output));
    expect(text).toContain('No results');
    expect(text).toContain('Check the spelling');
  });

  it('format explains an out-of-range page rather than blaming the spelling', () => {
    const output = {
      operation: 'makes',
      totalCount: 12309,
      returned: 0,
      offset: 99000,
      limit: 5,
    };
    const text = firstText(lookupVehicles.format!(output));

    expect(text).toBe('**12309 makes result(s)** (showing 0, offset 99000, limit 5)');
    // The name was fine; only the offset was wrong.
    expect(text).not.toMatch(/spelling/i);
  });

  it('format leaves recovery and cap disclosure to enrichment when a manufacturer page overshoots', () => {
    const output = {
      operation: 'manufacturer',
      totalCount: MANUFACTURER_RESULT_CAP,
      returned: 0,
      offset: MANUFACTURER_RESULT_CAP,
      limit: 100,
      manufacturers: [],
    };
    const text = firstText(lookupVehicles.format!(output));

    expect(text).toContain(`**${MANUFACTURER_RESULT_CAP} manufacturer result(s)**`);
    expect(text).not.toContain('try a smaller offset');
    expect(text).not.toContain('Retrieval stopped at');
    expect(text).not.toMatch(/spelling/i);
  });

  it('format leaves the cap disclosure off an uncapped out-of-range page', () => {
    const output = {
      operation: 'manufacturer',
      totalCount: 12,
      returned: 0,
      offset: 500,
      limit: 100,
      manufacturers: [],
    };
    const text = firstText(lookupVehicles.format!(output));

    expect(text).toContain('**12 manufacturer result(s)** (showing 0, offset 500, limit 100)');
    expect(text).not.toMatch(/retrieval stopped/i);
  });

  it('format renders manufacturer without country when absent', () => {
    const output = {
      operation: 'manufacturer',
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 100,
      manufacturers: [
        {
          manufacturerId: 955,
          manufacturerName: 'TESLA, INC.',
          vehicleTypes: [{ id: 2, name: 'Passenger Car' }],
        },
      ],
    };
    const text = firstText(lookupVehicles.format!(output));
    expect(text).toContain('TESLA, INC.');
    expect(text).toContain('Not available');
  });
});
