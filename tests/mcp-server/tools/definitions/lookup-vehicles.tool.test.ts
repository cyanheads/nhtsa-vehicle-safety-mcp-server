/**
 * @fileoverview Tests for nhtsa_lookup_vehicles tool.
 * @module tests/mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Keeps the real MANUFACTURER_RESULT_CAP so cap assertions track the service constant. */
vi.mock('@/services/nhtsa/nhtsa-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nhtsa/nhtsa-service.js')>()),
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

/** The server's clamp mode, flipped per test; the environment parsing has its own suite. */
const serverConfig = vi.hoisted(() => ({ clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => serverConfig }));

import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { getNhtsaService, MANUFACTURER_RESULT_CAP } from '@/services/nhtsa/nhtsa-service.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = {
  getAllMakes: vi.fn(),
  getModels: vi.fn(),
  getVehicleTypes: vi.fn(),
  getManufacturer: vi.fn(),
  getProductModels: vi.fn(),
  getSafetyRatingModels: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
  serverConfig.clampLimits = true;
});

describe('lookupVehicles', () => {
  it('normalizes optional blanks before mode checks and trims required names', async () => {
    mockService.getAllMakes.mockResolvedValue([]);
    const ctx = createMockContext({ errors: lookupVehicles.errors });
    await lookupVehicles.handler(
      lookupVehicles.input.parse({
        operation: 'makes',
        make: ' ',
        manufacturer: '\t',
        limit: 1,
        offset: 0,
      }),
      ctx,
    );
    expect(mockService.getAllMakes).toHaveBeenCalledTimes(1);
    mockService.getModels.mockResolvedValue([]);
    await lookupVehicles.handler(
      lookupVehicles.input.parse({
        operation: 'models',
        make: ' Toyota ',
        manufacturer: ' ',
        modelYear: 1968,
      }),
      ctx,
    );
    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', 1968, expect.anything());
    mockService.getManufacturer.mockResolvedValue([]);
    await lookupVehicles.handler(
      lookupVehicles.input.parse({
        operation: 'manufacturer',
        manufacturer: ' Toyota ',
        make: ' ',
      }),
      ctx,
    );
    expect(mockService.getManufacturer).toHaveBeenCalledWith('Toyota', expect.anything());
  });
  it('"makes" operation returns makes', async () => {
    mockService.getAllMakes.mockResolvedValue([
      { makeId: 441, makeName: 'TOYOTA' },
      { makeId: 474, makeName: 'HONDA' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'makes' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.operation).toBe('makes');
    expect(result.totalCount).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(100);
    expect(result.makes).toHaveLength(2);
  });

  it('"makes" operation applies limit and offset pagination', async () => {
    mockService.getAllMakes.mockResolvedValue([
      { makeId: 1, makeName: 'A' },
      { makeId: 2, makeName: 'B' },
      { makeId: 3, makeName: 'C' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'makes', limit: 1, offset: 1 });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.returned).toBe(1);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.makes).toEqual([{ makeId: 2, makeName: 'B' }]);
  });

  it('"models" operation returns models and paginates', async () => {
    mockService.getModels.mockResolvedValue([
      { modelId: 1, modelName: 'CAMRY', makeId: 441, makeName: 'TOYOTA' },
      { modelId: 2, modelName: 'COROLLA', makeId: 441, makeName: 'TOYOTA' },
      { modelId: 3, modelName: 'RAV4', makeId: 441, makeName: 'TOYOTA' },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'models',
      make: 'Toyota',
      limit: 2,
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.operation).toBe('models');
    expect(result.totalCount).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.models).toHaveLength(2);
    expect(result.models?.[0]?.modelName).toBe('CAMRY');
    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', undefined, expect.anything());
  });

  it('"models" with modelYear passes year to service', async () => {
    mockService.getModels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'models',
      make: 'Toyota',
      modelYear: 2020,
    });
    await lookupVehicles.handler(input, ctx);

    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', 2020, expect.anything());
  });

  it('"models" throws when make missing', async () => {
    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'models' });
    await expect(lookupVehicles.handler(input, ctx)).rejects.toThrow(/make.*required/i);
  });

  it('"vehicle_types" throws when make missing', async () => {
    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types' });
    await expect(lookupVehicles.handler(input, ctx)).rejects.toThrow(/make.*required/i);
  });

  it('"manufacturer" throws when manufacturer param missing', async () => {
    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'manufacturer' });
    await expect(lookupVehicles.handler(input, ctx)).rejects.toThrow(/manufacturer.*required/i);
  });

  it('"manufacturer" returns manufacturer details', async () => {
    mockService.getManufacturer.mockResolvedValue([
      {
        manufacturerId: 987,
        manufacturerName: 'TOYOTA',
        country: 'JAPAN',
        vehicleTypes: [{ id: 2, name: 'Passenger Car' }],
      },
    ]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'manufacturer', manufacturer: 'Toyota' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.manufacturers?.[0]?.country).toBe('JAPAN');
  });

  it('out-of-bounds offset surfaces a recovery notice via enrichment', async () => {
    mockService.getAllMakes.mockResolvedValue([{ makeId: 1, makeName: 'A' }]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'makes', offset: 50 });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.returned).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/try a smaller offset/i);
  });

  it('empty models result surfaces a recovery notice via enrichment', async () => {
    mockService.getModels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({ operation: 'models', make: 'Nope' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/verify the make spelling/i);
  });

  it('format renders makes list', () => {
    const output = {
      operation: 'makes',
      totalCount: 2,
      returned: 2,
      offset: 0,
      limit: 100,
      makes: [
        { makeId: 1, makeName: 'TOYOTA' },
        { makeId: 2, makeName: 'HONDA' },
      ],
    };
    const blocks = lookupVehicles.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('TOYOTA');
    expect(text).toContain('HONDA');
  });

  it('format renders manufacturer details', () => {
    const output = {
      operation: 'manufacturer',
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 100,
      manufacturers: [
        {
          manufacturerId: 987,
          manufacturerName: 'TOYOTA',
          country: 'JAPAN',
          vehicleTypes: [{ id: 2, name: 'Passenger Car' }],
        },
      ],
    };
    const blocks = lookupVehicles.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('TOYOTA');
    expect(text).toContain('JAPAN');
    expect(text).toContain('Passenger Car');
  });

  it('format shows pagination line when slice is smaller than total', () => {
    const output = {
      operation: 'makes',
      totalCount: 500,
      returned: 100,
      offset: 0,
      limit: 100,
      makes: [{ makeId: 1, makeName: 'A' }],
    };
    const text = firstText(lookupVehicles.format!(output));
    expect(text).toContain('Showing 100 of 500');
    expect(text).toContain('offset 0');
    expect(text).toContain('limit 100');
  });

  it('rejects a fractional modelYear rather than building a fractional path segment', () => {
    expect(() =>
      lookupVehicles.input.parse({ operation: 'models', make: 'Toyota', modelYear: 2020.5 }),
    ).toThrow();
    expect(
      lookupVehicles.input.parse({ operation: 'models', make: 'Toyota', modelYear: 2020 })
        .modelYear,
    ).toBe(2020);
  });
});

/** `count` makes with ids 0 → count-1, in the order the service returns them. */
function makes(count: number) {
  return Array.from({ length: count }, (_, makeId) => ({ makeId, makeName: `MAKE ${makeId}` }));
}

describe('lookupVehicles — over-cap limit (#53)', () => {
  it('advertises a whole-number limit with no maximum', () => {
    expect(z.toJSONSchema(lookupVehicles.input, { io: 'input' }).properties?.limit).toEqual({
      type: 'number',
      minimum: 1,
      multipleOf: 1,
      description: expect.stringContaining('at most 200'),
    });
  });

  it('clamps limit 201 to a 200-row page and names the next offset', async () => {
    mockService.getAllMakes.mockResolvedValue(makes(205));

    const result = await runToolContract(lookupVehicles, { operation: 'makes', limit: 201 });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent as { makes: { makeId: number }[] };
    expect(out).toMatchObject({
      totalCount: 205,
      returned: 200,
      offset: 0,
      limit: 200,
      effectiveQuery: 'makes offset=0 limit=200',
      notice: 'limit 201 exceeds the maximum of 200; returned 200 — continue at offset=200.',
    });
    expect(out.makes.map((m) => m.makeId)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(readerText(result.content)).toContain(
      'limit 201 exceeds the maximum of 200; returned 200 — continue at offset=200.',
    );
  });

  it('composes the clamp, the out-of-range page, and the retrieval cap in the manufacturer branch', async () => {
    mockService.getManufacturer.mockResolvedValue(
      Array.from({ length: MANUFACTURER_RESULT_CAP }, (_, manufacturerId) => ({
        manufacturerId,
        manufacturerName: `MFR ${manufacturerId}`,
        vehicleTypes: [],
      })),
    );

    const result = await runToolContract(lookupVehicles, {
      operation: 'manufacturer',
      manufacturer: 'a',
      limit: 201,
      offset: MANUFACTURER_RESULT_CAP + 100,
    });

    expect(result.structuredContent).toMatchObject({
      returned: 0,
      limit: 200,
      truncated: true,
      cap: MANUFACTURER_RESULT_CAP,
      notice: expect.stringMatching(
        /^limit 201 exceeds the maximum of 200; returned 0\. .*try a smaller offset.*Retrieval stopped at/,
      ),
    });
    const text = readerText(result.content);
    expect(text.split('exceeds the maximum of 200').length - 1).toBe(1);
    expect(text.split('try a smaller offset').length - 1).toBe(1);
    expect(text.split('Retrieval stopped at').length - 1).toBe(1);
  });

  it('rejects limit 201 with limit_too_large naming the cap when clamping is off', async () => {
    serverConfig.clampLimits = false;

    const result = await runToolContract(lookupVehicles, { operation: 'makes', limit: 201 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: 'limit 201 exceeds the maximum of 200.',
        data: { reason: 'limit_too_large', recovery: { hint: expect.stringContaining('200') } },
      },
    });
    expect(readerText(result.content)).toContain('limit 201 exceeds the maximum of 200.');
    expect(mockService.getAllMakes).not.toHaveBeenCalled();
  });

  it('serves a limit at the cap unchanged when clamping is off', async () => {
    serverConfig.clampLimits = false;
    mockService.getAllMakes.mockResolvedValue(makes(205));

    const result = await runToolContract(lookupVehicles, { operation: 'makes', limit: 200 });

    expect(result.structuredContent).toMatchObject({ returned: 200, limit: 200 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});

/** VPIC model rows as `getModels` returns them, one per name. */
function vpicModels(...names: string[]) {
  return names.map((modelName, modelId) => ({
    modelId,
    modelName,
    makeId: 467,
    makeName: 'CHEVROLET',
  }));
}

/** Seed the three lists `dataset_models` merges. */
function seedLists(lists: { products?: string[]; ncap?: string[]; vpic?: string[] }) {
  mockService.getProductModels.mockResolvedValue(lists.products ?? []);
  mockService.getSafetyRatingModels.mockResolvedValue(lists.ncap ?? []);
  mockService.getModels.mockResolvedValue(vpicModels(...(lists.vpic ?? [])));
}

const CHEVROLET_2014 = { operation: 'dataset_models', make: 'Chevrolet', modelYear: 2014 } as const;

type DatasetModelsOut = {
  totalCount: number;
  returned: number;
  offset: number;
  limit: number;
  datasetModels: { modelName: string; listedBy: string[] }[];
};

describe('lookupVehicles — dataset_models (#47)', () => {
  it('merges the three lists case-insensitively, uppercased, each name tagged with its lists', async () => {
    seedLists({
      products: ['SILVERADO 1500', 'EXPRESS PASSENGER 1500', 'CAMARO'],
      ncap: ['SILVERADO 1500', 'EXPRESS PASSENGER 1500', 'Camaro'],
      vpic: ['Silverado', 'Express', 'Camaro', 'Camaro', ' Silverado '],
    });

    const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: 'dataset_models',
      totalCount: 5,
      returned: 5,
      offset: 0,
      limit: 100,
      effectiveQuery: 'dataset_models make=Chevrolet year=2014',
      datasetModels: [
        { modelName: 'CAMARO', listedBy: ['products', 'ncap', 'vpic'] },
        { modelName: 'EXPRESS', listedBy: ['vpic'] },
        { modelName: 'EXPRESS PASSENGER 1500', listedBy: ['products', 'ncap'] },
        { modelName: 'SILVERADO', listedBy: ['vpic'] },
        { modelName: 'SILVERADO 1500', listedBy: ['products', 'ncap'] },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const signal = expect.any(AbortSignal);
    expect(mockService.getProductModels).toHaveBeenCalledWith('Chevrolet', 2014, signal);
    expect(mockService.getSafetyRatingModels).toHaveBeenCalledWith(2014, 'Chevrolet', signal);
    expect(mockService.getModels).toHaveBeenCalledWith('Chevrolet', 2014, signal);

    const text = readerText(result.content);
    expect(text).toContain('SILVERADO 1500 — listed by products, ncap');
    expect(text).toContain('SILVERADO — listed by vpic');
    expect(text).toContain('CAMARO — listed by products, ncap, vpic');
  });

  it('keeps only the requested make from the VPIC list, which matches make names partially', async () => {
    seedLists({ products: ['FORTWO'] });
    mockService.getModels.mockResolvedValue([
      { modelId: 1, modelName: 'Fortwo', makeId: 1, makeName: 'SMART' },
      {
        modelId: 2,
        modelName: 'SMART TRAILERS, INC.',
        makeId: 2,
        makeName: 'SMART TRAILERS, INC.',
      },
      { modelId: 3, modelName: 'Tiny SMART House', makeId: 3, makeName: 'TINY SMART HOUSE' },
    ]);

    const result = await runToolContract(lookupVehicles, {
      operation: 'dataset_models',
      make: 'Smart',
      modelYear: 2016,
    });

    expect((result.structuredContent as DatasetModelsOut).datasetModels).toEqual([
      { modelName: 'FORTWO', listedBy: ['products', 'vpic'] },
    ]);
  });

  it('pages the merged list with limit and offset', async () => {
    seedLists({ products: ['D', 'B'], ncap: ['A', 'E'], vpic: ['C'] });

    const result = await runToolContract(lookupVehicles, {
      ...CHEVROLET_2014,
      limit: 2,
      offset: 1,
    });

    const out = result.structuredContent as DatasetModelsOut;
    expect(out).toMatchObject({ totalCount: 5, returned: 2, offset: 1, limit: 2 });
    expect(out.datasetModels.map((m) => m.modelName)).toEqual(['B', 'C']);
    const text = readerText(result.content);
    expect(text).toContain('Showing 2 of 5 (offset 1, limit 2)');
    expect(text).not.toContain('A — listed by');
    expect(text).not.toContain('D — listed by');
  });

  it('notices an offset past the end of the merged list', async () => {
    seedLists({ products: ['SILVERADO 1500'], vpic: ['Silverado'] });

    const result = await runToolContract(lookupVehicles, { ...CHEVROLET_2014, offset: 2 });

    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      returned: 0,
      datasetModels: [],
      notice: expect.stringMatching(/offset 2.*try a smaller offset/),
    });
  });

  it('clamps an over-cap limit and pages the rest from the named offset', async () => {
    const names = Array.from({ length: 205 }, (_, i) => `MODEL ${String(i).padStart(3, '0')}`);
    seedLists({ products: names });

    const first = await runToolContract(lookupVehicles, { ...CHEVROLET_2014, limit: 201 });
    const firstOut = first.structuredContent as DatasetModelsOut & { notice: string };
    expect(firstOut).toMatchObject({
      totalCount: 205,
      returned: 200,
      limit: 200,
      notice: 'limit 201 exceeds the maximum of 200; returned 200 — continue at offset=200.',
    });
    expect(firstOut.datasetModels.map((m) => m.modelName)).toEqual(names.slice(0, 200));

    const rest = await runToolContract(lookupVehicles, {
      ...CHEVROLET_2014,
      offset: 200,
      limit: 200,
    });
    const restOut = rest.structuredContent as DatasetModelsOut;
    expect(restOut.datasetModels.map((m) => m.modelName)).toEqual([
      'MODEL 200',
      'MODEL 201',
      'MODEL 202',
      'MODEL 203',
      'MODEL 204',
    ]);
    expect(rest.structuredContent).not.toHaveProperty('notice');
  });

  it('notices an empty merge and points at the make spelling', async () => {
    seedLists({});

    const result = await runToolContract(lookupVehicles, { ...CHEVROLET_2014, make: 'Chevy' });

    const notice =
      'No model names found for make "Chevy" in model year 2014. Verify the make spelling with operation="makes".';
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      returned: 0,
      datasetModels: [],
      notice,
    });
    const text = readerText(result.content);
    expect(text).toContain('No results for "dataset_models" lookup.');
    expect(text).toContain(notice);
  });

  it.each(['getProductModels', 'getSafetyRatingModels', 'getModels'] as const)(
    'fails the call when %s fails rather than dropping its tag',
    async (failing) => {
      seedLists({ products: ['SILVERADO 1500'], ncap: ['SILVERADO 1500'], vpic: ['Silverado'] });
      mockService[failing].mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NHTSA API unavailable'),
      );

      const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
      expect(result.structuredContent).not.toHaveProperty('datasetModels');
      expect(readerText(result.content)).toContain('NHTSA API unavailable');
      // The failure cancels the other two lists' requests.
      const signals = [
        mockService.getProductModels.mock.calls[0]![2],
        mockService.getSafetyRatingModels.mock.calls[0]![2],
        mockService.getModels.mock.calls[0]![2],
      ] as AbortSignal[];
      expect(signals.map((s) => s.aborted)).toEqual([true, true, true]);
    },
  );

  it.each([
    [{ operation: 'dataset_models', modelYear: 2014 }, '"make" is required'],
    [{ operation: 'dataset_models', make: ' ', modelYear: 2014 }, '"make" is required'],
    [{ operation: 'dataset_models', make: 'Chevrolet' }, '"modelYear" is required'],
    [{ operation: 'dataset_models' }, '"make" and "modelYear" are required'],
  ] as const)('rejects %j with missing_operation_arg before fetching', async (args, message) => {
    const result = await runToolContract(lookupVehicles, args);

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { message: string; data: object } }).error;
    expect(error.message).toBe(`${message} for the "dataset_models" operation.`);
    expect(error.data).toMatchObject({
      reason: 'missing_operation_arg',
      recovery: { hint: expect.stringContaining('make and modelYear for dataset_models') },
    });
    const text = readerText(result.content);
    expect(text).toContain(message);
    expect(text).toContain('make and modelYear for dataset_models');
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects manufacturer with inactive_argument before fetching', async () => {
    const result = await runToolContract(lookupVehicles, {
      ...CHEVROLET_2014,
      manufacturer: 'General Motors',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        message: 'The dataset_models operation does not accept manufacturer.',
        data: {
          reason: 'inactive_argument',
          recovery: { hint: expect.stringContaining('dataset_models accept make/modelYear') },
        },
      },
    });
    expect(readerText(result.content)).toContain('dataset_models accept make/modelYear');
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  it('still rejects modelYear on operations other than models and dataset_models', async () => {
    const result = await runToolContract(lookupVehicles, {
      operation: 'vehicle_types',
      make: 'Chevrolet',
      modelYear: 2014,
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'inactive_argument' } },
    });
  });
});
