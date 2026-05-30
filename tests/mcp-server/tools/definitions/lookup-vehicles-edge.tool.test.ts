/**
 * @fileoverview Additional coverage for nhtsa_lookup_vehicles — vehicle_types operation,
 * manufacturer empty results, and format edge cases.
 * @module tests/mcp-server/tools/definitions/lookup-vehicles-edge.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

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
  it('returns vehicle types for a make', async () => {
    mockService.getVehicleTypes.mockResolvedValue([
      { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
      { vehicleTypeId: 7, vehicleTypeName: 'Multipurpose Passenger Vehicle (MPV)' },
    ]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types', make: 'Toyota' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.operation).toBe('vehicle_types');
    expect(result.totalCount).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.vehicleTypes).toHaveLength(2);
    expect(result.vehicleTypes![0].vehicleTypeName).toBe('Passenger Car');
    expect(mockService.getVehicleTypes).toHaveBeenCalledWith('Toyota', expect.anything());
  });

  it('vehicle_types: empty result populates enrichment notice', async () => {
    mockService.getVehicleTypes.mockResolvedValue([]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types', make: 'Toyota' });
    await lookupVehicles.handler(input, ctx);

    expect(getEnrichment(ctx).effectiveQuery).toContain('vehicle_types');
    expect(getEnrichment(ctx).effectiveQuery).toContain('Toyota');
  });
});

describe('lookupVehicles — manufacturer operation edges', () => {
  it('empty manufacturer result surfaces enrichment notice', async () => {
    mockService.getManufacturer.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({
      operation: 'manufacturer',
      manufacturer: 'UnknownManufacturer',
    });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/manufacturers matching/i);
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
    const text = lookupVehicles.format!(output)[0].text;
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
    const text = lookupVehicles.format!(output)[0].text;
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
    const text = lookupVehicles.format!(output)[0].text;
    expect(text).toContain('No results');
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
    const text = lookupVehicles.format!(output)[0].text;
    expect(text).toContain('TESLA, INC.');
    expect(text).toContain('Not available');
  });
});
