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
  getRecallModelNames: vi.fn(),
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

/** Seed the four lists `dataset_models` merges; the recall list loads within its wait. */
function seedLists(lists: {
  products?: string[];
  ncap?: string[];
  vpic?: string[];
  recalls?: string[];
}) {
  mockService.getProductModels.mockResolvedValue(lists.products ?? []);
  mockService.getSafetyRatingModels.mockResolvedValue(lists.ncap ?? []);
  mockService.getModels.mockResolvedValue(vpicModels(...(lists.vpic ?? [])));
  mockService.getRecallModelNames.mockResolvedValue({ kind: 'ready', value: lists.recalls ?? [] });
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
  it('merges the lists case-insensitively, uppercased, each name tagged with its lists', async () => {
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
    expect(mockService.getRecallModelNames).toHaveBeenCalledWith('Chevrolet', 2014, signal);

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
      'No model names found for make "Chevy" in model year 2014. Verify the make spelling with operation="makes", passing part of the name as make.';
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
    'fails the call when %s fails rather than dropping its tag, ending the recall wait',
    async (failing) => {
      seedLists({ products: ['SILVERADO 1500'], ncap: ['SILVERADO 1500'], vpic: ['Silverado'] });
      mockService[failing].mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NHTSA API unavailable'),
      );
      /** The recall-file wait still running: it ends only when its signal aborts, as a caller abort does. */
      mockService.getRecallModelNames.mockImplementation(
        (_make: string, _modelYear: number, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );

      const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

      expect(result.isError).toBe(true);
      // The list's own failure decides the call, not the abort it sent the recall wait.
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable, message: 'NHTSA API unavailable' },
      });
      expect(result.structuredContent).not.toHaveProperty('datasetModels');
      expect(readerText(result.content)).toContain('NHTSA API unavailable');
      // The failure cancels the other two lists' requests and the recall-file wait.
      const signals = [
        mockService.getProductModels.mock.calls[0]![2],
        mockService.getSafetyRatingModels.mock.calls[0]![2],
        mockService.getModels.mock.calls[0]![2],
        mockService.getRecallModelNames.mock.calls[0]![2],
      ] as AbortSignal[];
      expect(signals.map((s) => s.aborted)).toEqual([true, true, true, true]);
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

/** The sentence every empty make-scoped lookup ends with. */
const VERIFY_MAKE =
  'Verify the make spelling with operation="makes", passing part of the name as make.';

/** A slice of VPIC's `GetAllMakes`, in its alphabetical order, around the names #62 cites. */
const VPIC_MAKES = [
  { makeId: 10_001, makeName: 'AFFORDABLE ALUMINUM' },
  { makeId: 460, makeName: 'FORD' },
  { makeId: 449, makeName: 'MERCEDES-BENZ' },
  { makeId: 10_002, makeName: 'THOMPSON MANUFACTURING COMPANY WEXFORD LTD.' },
  { makeId: 448, makeName: 'TOYOTA' },
  { makeId: 10_003, makeName: 'WATERFORD TANK AND FABRICATION' },
];

describe('lookupVehicles — makes name filter (#62)', () => {
  beforeEach(() => {
    mockService.getAllMakes.mockResolvedValue(VPIC_MAKES);
  });

  it('keeps the makes whose name contains make, ignoring case', async () => {
    const result = await runToolContract(lookupVehicles, { operation: 'makes', make: 'mercedes' });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      operation: 'makes',
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 100,
      makes: [{ makeId: 449, makeName: 'MERCEDES-BENZ' }],
      effectiveQuery: 'makes make=mercedes offset=0 limit=100',
    });
    expect(readerText(result.content)).toBe(
      [
        '1 makes result(s)',
        'Showing 1 of 1 (offset 0, limit 100)',
        'MERCEDES-BENZ (ID: 449)',
        'effectiveQuery: makes make=mercedes offset=0 limit=100',
      ].join('\n'),
    );
  });

  it('trims make and pages the matches in VPIC order', async () => {
    const result = await runToolContract(lookupVehicles, {
      operation: 'makes',
      make: '  ford ',
      limit: 2,
      offset: 1,
    });

    expect(result.structuredContent).toEqual({
      operation: 'makes',
      totalCount: 4,
      returned: 2,
      offset: 1,
      limit: 2,
      makes: [
        { makeId: 460, makeName: 'FORD' },
        { makeId: 10_002, makeName: 'THOMPSON MANUFACTURING COMPANY WEXFORD LTD.' },
      ],
      effectiveQuery: 'makes make=ford offset=1 limit=2',
    });
  });

  it('answers a make matching nothing with an empty success and the partial-match notice', async () => {
    const result = await runToolContract(lookupVehicles, { operation: 'makes', make: 'zzqq' });

    const notice =
      'No makes matching "zzqq" found. Partial matches are supported — try a shorter or different query.';
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      operation: 'makes',
      totalCount: 0,
      returned: 0,
      offset: 0,
      limit: 100,
      makes: [],
      effectiveQuery: 'makes make=zzqq offset=0 limit=100',
      notice,
    });
    expect(readerText(result.content)).toBe(
      [
        'No results for "makes" lookup. Check the spelling of the make or manufacturer name.',
        'effectiveQuery: makes make=zzqq offset=0 limit=100',
        notice,
      ].join('\n'),
    );
  });

  it('keeps the out-of-range notice for a page past the last match', async () => {
    const result = await runToolContract(lookupVehicles, {
      operation: 'makes',
      make: 'ford',
      offset: 4,
    });

    expect(result.structuredContent).toMatchObject({
      totalCount: 4,
      returned: 0,
      notice: 'No results for this page (offset 4, limit 100). 4 total — try a smaller offset.',
    });
  });

  it('treats a blank make as unset and returns every make', async () => {
    const result = await runToolContract(lookupVehicles, { operation: 'makes', make: '   ' });

    expect(result.structuredContent).toEqual({
      operation: 'makes',
      totalCount: VPIC_MAKES.length,
      returned: VPIC_MAKES.length,
      offset: 0,
      limit: 100,
      makes: VPIC_MAKES,
      effectiveQuery: 'makes offset=0 limit=100',
    });
  });

  it('renders the filtered make names as written', async () => {
    mockService.getAllMakes.mockResolvedValue([
      { makeId: 1, makeName: 'TOYOTA' },
      { makeId: 2, makeName: '*FORD* <GT> [x](y)' },
      { makeId: 3, makeName: '- FORD_TRUCKS ###' },
    ]);

    const result = await runToolContract(lookupVehicles, { operation: 'makes', make: 'ford' });

    expect(readerText(result.content)).toBe(
      [
        '2 makes result(s)',
        'Showing 2 of 2 (offset 0, limit 100)',
        '*FORD* <GT> [x](y) (ID: 2)',
        '- FORD_TRUCKS ### (ID: 3)',
        'effectiveQuery: makes make=ford offset=0 limit=100',
      ].join('\n'),
    );
  });

  it.each([
    [
      { operation: 'models', make: 'Chevy' },
      'getModels',
      `No models for make "Chevy" found. ${VERIFY_MAKE}`,
    ],
    [
      { operation: 'models', make: 'Chevy', modelYear: 2014 },
      'getModels',
      `No models for make "Chevy" for model year 2014 found. ${VERIFY_MAKE}`,
    ],
    [
      { operation: 'vehicle_types', make: 'Chevy' },
      'getVehicleTypes',
      `No vehicle types for make "Chevy" found. ${VERIFY_MAKE}`,
    ],
  ] as const)('points an empty %j at the makes name filter', async (args, list, notice) => {
    mockService[list].mockResolvedValue([]);

    const result = await runToolContract(lookupVehicles, args);

    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(readerText(result.content).split('\n').at(-1)).toBe(notice);
  });

  it('names makes among the operations that take make in the inactive_argument recovery', async () => {
    const result = await runToolContract(lookupVehicles, { operation: 'makes', modelYear: 2014 });

    expect(result.structuredContent).toMatchObject({
      error: {
        message: 'The makes operation does not accept modelYear.',
        data: {
          reason: 'inactive_argument',
          recovery: {
            hint: 'makes and vehicle_types accept make; models and dataset_models accept make/modelYear; manufacturer accepts manufacturer. Remove other filters.',
          },
        },
      },
    });
    expect(mockService.getAllMakes).not.toHaveBeenCalled();
  });
});

/**
 * One upstream value per Markdown construct a client would otherwise render (#59): emphasis, a
 * code span, underscores, raw HTML, a link, an entity, line-leading list and heading markers, a
 * trailing closing sequence, and a line break.
 */
const HOSTILE = [
  '*star* and **bold**',
  'tick `code`',
  'snake _under_ score',
  '<tag>inside</tag>',
  '[x](y)',
  'AT&amp;T',
  'ends &amp',
  '- dash lead',
  '# hash lead',
  '1. ordered lead',
  'TRAILING ###',
  'line one\nline two',
] as const;

/** The value `offset` places past `i`, so each field sees every hostile value across the rows. */
const hostileAt = (i: number, offset: number): string => HOSTILE[(i + offset) % HOSTILE.length]!;

/** The two summary lines a non-empty page opens with, as a reader sees them. */
const summaryLines = (count: number, operation: string): string[] => [
  `${count} ${operation} result(s)`,
  `Showing ${count} of ${count} (offset 0, limit 100)`,
];

describe('lookupVehicles — upstream strings render as written (#59)', () => {
  it('renders make names as written', async () => {
    mockService.getAllMakes.mockResolvedValue(
      HOSTILE.map((makeName, makeId) => ({ makeId, makeName })),
    );

    const result = await runToolContract(lookupVehicles, { operation: 'makes' });

    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(HOSTILE.length, 'makes'),
        ...HOSTILE.map((name, id) => `${name} (ID: ${id})`),
        'effectiveQuery: makes offset=0 limit=100',
      ].join('\n'),
    );
  });

  it('renders model and make names as written', async () => {
    mockService.getModels.mockResolvedValue(
      HOSTILE.map((modelName, modelId) => ({
        modelId,
        modelName,
        makeId: 900,
        makeName: hostileAt(modelId, 5),
      })),
    );

    const result = await runToolContract(lookupVehicles, { operation: 'models', make: 'acme' });

    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(HOSTILE.length, 'models'),
        ...HOSTILE.map(
          (name, id) => `${name} — ${hostileAt(id, 5)} (Model ID: ${id}, Make ID: 900)`,
        ),
        'effectiveQuery: models make=acme',
      ].join('\n'),
    );
  });

  it('renders vehicle type names as written', async () => {
    mockService.getVehicleTypes.mockResolvedValue(
      HOSTILE.map((vehicleTypeName, vehicleTypeId) => ({ vehicleTypeId, vehicleTypeName })),
    );

    const result = await runToolContract(lookupVehicles, {
      operation: 'vehicle_types',
      make: 'acme',
    });

    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(HOSTILE.length, 'vehicle_types'),
        ...HOSTILE.map((name, id) => `${name} (ID: ${id})`),
        'effectiveQuery: vehicle_types make=acme',
      ].join('\n'),
    );
  });

  it('heads each manufacturer with its ID and renders its name, country, and types as written', async () => {
    mockService.getManufacturer.mockResolvedValue(
      HOSTILE.map((manufacturerName, manufacturerId) => ({
        manufacturerId,
        manufacturerName,
        // The last row carries no country, so it reads "Not available".
        ...(manufacturerId < HOSTILE.length - 1 ? { country: hostileAt(manufacturerId, 1) } : {}),
        vehicleTypes: [
          { id: manufacturerId, name: hostileAt(manufacturerId, 2) },
          { name: hostileAt(manufacturerId, 3) },
        ],
      })),
    );

    const result = await runToolContract(lookupVehicles, {
      operation: 'manufacturer',
      manufacturer: 'acme',
    });

    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(HOSTILE.length, 'manufacturer'),
        ...HOSTILE.flatMap((name, id) => [
          `Manufacturer ${id}`,
          [
            `Name: ${name}`,
            `Country: ${id < HOSTILE.length - 1 ? hostileAt(id, 1) : 'Not available'}`,
            `Vehicle Types: ${hostileAt(id, 2)} (ID: ${id}), ${hostileAt(id, 3)} (ID: N/A)`,
          ].join('\n'),
        ]),
        'effectiveQuery: manufacturer=acme',
      ].join('\n'),
    );
  });

  it('renders dataset model names from every list as written, uppercased as merged', async () => {
    seedLists({
      products: [HOSTILE[0], HOSTILE[1]],
      ncap: [HOSTILE[2]],
      vpic: [HOSTILE[3]],
      recalls: HOSTILE.slice(4),
    });

    const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

    const listedBy = (name: string): string =>
      name === HOSTILE[0] || name === HOSTILE[1]
        ? 'products'
        : name === HOSTILE[2]
          ? 'ncap'
          : name === HOSTILE[3]
            ? 'vpic'
            : 'recalls';
    const rows = HOSTILE.map((name) => ({ upper: name.toUpperCase(), list: listedBy(name) })).sort(
      (a, b) => (a.upper < b.upper ? -1 : 1),
    );
    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(HOSTILE.length, 'dataset_models'),
        ...rows.map((row) => `${row.upper} — listed by ${row.list}`),
        'effectiveQuery: dataset_models make=Chevrolet year=2014',
      ].join('\n'),
    );
  });
});

const RECALLS_PENDING =
  'The "recalls" list is missing: NHTSA\'s recall files are still loading, so no name here carries that tag. Call again in a minute to include it.';
const RECALLS_FAILED =
  'The "recalls" list is missing: NHTSA\'s recall files failed to load, so no name here carries that tag. Call again later to include it.';

describe('lookupVehicles — dataset_models recall list (#61)', () => {
  it('merges the recall files’ model names as a fourth list tagged recalls', async () => {
    seedLists({
      products: ['SILVERADO 1500', 'EXPRESS 3500'],
      ncap: ['SILVERADO 1500'],
      vpic: ['Silverado', 'Express'],
      recalls: [
        'CAPRICE POLICE PURSUIT',
        'EXPRESS 3500',
        'EXPRESS CUTAWAY VAN',
        'SILVERADO',
        'SILVERADO 1500',
      ],
    });

    const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      operation: 'dataset_models',
      totalCount: 6,
      returned: 6,
      offset: 0,
      limit: 100,
      datasetModels: [
        { modelName: 'CAPRICE POLICE PURSUIT', listedBy: ['recalls'] },
        { modelName: 'EXPRESS', listedBy: ['vpic'] },
        { modelName: 'EXPRESS 3500', listedBy: ['products', 'recalls'] },
        { modelName: 'EXPRESS CUTAWAY VAN', listedBy: ['recalls'] },
        { modelName: 'SILVERADO', listedBy: ['vpic', 'recalls'] },
        { modelName: 'SILVERADO 1500', listedBy: ['products', 'ncap', 'recalls'] },
      ],
      effectiveQuery: 'dataset_models make=Chevrolet year=2014',
    });
    expect(mockService.getRecallModelNames).toHaveBeenCalledWith(
      'Chevrolet',
      2014,
      expect.any(AbortSignal),
    );
    expect(readerText(result.content)).toBe(
      [
        ...summaryLines(6, 'dataset_models'),
        'CAPRICE POLICE PURSUIT — listed by recalls',
        'EXPRESS — listed by vpic',
        'EXPRESS 3500 — listed by products, recalls',
        'EXPRESS CUTAWAY VAN — listed by recalls',
        'SILVERADO — listed by vpic, recalls',
        'SILVERADO 1500 — listed by products, ncap, recalls',
        'effectiveQuery: dataset_models make=Chevrolet year=2014',
      ].join('\n'),
    );
  });

  it('answers from the recall list alone when the three API lists carry nothing', async () => {
    seedLists({ recalls: ['CHEVEROLET SS'] });

    const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

    expect(result.structuredContent).toEqual({
      operation: 'dataset_models',
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 100,
      datasetModels: [{ modelName: 'CHEVEROLET SS', listedBy: ['recalls'] }],
      effectiveQuery: 'dataset_models make=Chevrolet year=2014',
    });
  });

  it.each([
    ['still loading', { kind: 'pending' }, RECALLS_PENDING],
    [
      'failed',
      {
        kind: 'failed',
        error: new Error('Fetch failed for https://static.nhtsa.gov/…. Status: 502'),
      },
      RECALLS_FAILED,
    ],
  ] as const)(
    'returns the other three lists and discloses recall files %s',
    async (_state, load, notice) => {
      seedLists({ products: ['SILVERADO 1500'], ncap: ['SILVERADO 1500'], vpic: ['Silverado'] });
      mockService.getRecallModelNames.mockResolvedValue(load);

      const result = await runToolContract(lookupVehicles, CHEVROLET_2014);

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        operation: 'dataset_models',
        totalCount: 2,
        returned: 2,
        offset: 0,
        limit: 100,
        datasetModels: [
          { modelName: 'SILVERADO', listedBy: ['vpic'] },
          { modelName: 'SILVERADO 1500', listedBy: ['products', 'ncap'] },
        ],
        unavailableLists: ['recalls'],
        effectiveQuery: 'dataset_models make=Chevrolet year=2014',
        notice,
      });
      expect(readerText(result.content)).toBe(
        [
          ...summaryLines(2, 'dataset_models'),
          'Unavailable lists: recalls',
          'SILVERADO — listed by vpic',
          'SILVERADO 1500 — listed by products, ncap',
          'effectiveQuery: dataset_models make=Chevrolet year=2014',
          notice,
        ].join('\n'),
      );
    },
  );

  it('discloses a missing recall list beside an empty merge, after the spelling recovery', async () => {
    seedLists({});
    mockService.getRecallModelNames.mockResolvedValue({ kind: 'pending' });

    const result = await runToolContract(lookupVehicles, { ...CHEVROLET_2014, make: 'Chevy' });

    const notice = `No model names found for make "Chevy" in model year 2014. ${VERIFY_MAKE} ${RECALLS_PENDING}`;
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      datasetModels: [],
      unavailableLists: ['recalls'],
      notice,
    });
    expect(readerText(result.content)).toBe(
      [
        'No results for "dataset_models" lookup. Check the spelling of the make or manufacturer name.',
        'Unavailable lists: recalls',
        'effectiveQuery: dataset_models make=Chevy year=2014',
        notice,
      ].join('\n'),
    );
  });

  it('propagates a caller cancellation during the recall wait instead of degrading', async () => {
    seedLists({ products: ['SILVERADO 1500'], ncap: ['SILVERADO 1500'], vpic: ['Silverado'] });
    const caller = new AbortController();
    mockService.getRecallModelNames.mockImplementation(
      (_make: string, _modelYear: number, signal: AbortSignal) => {
        const wait = new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        caller.abort(new DOMException('The caller cancelled the request.', 'AbortError'));
        return wait;
      },
    );

    const result = await runToolContract(lookupVehicles, CHEVROLET_2014, {
      context: { signal: caller.signal },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.structuredContent).not.toHaveProperty('datasetModels');
    expect(readerText(result.content)).toContain('The caller cancelled the request.');
  });
});
