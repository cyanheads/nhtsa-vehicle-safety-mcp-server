/**
 * @fileoverview Tests for nhtsa_lookup_vehicles tool.
 * @module tests/mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('lookupVehicles', () => {
  it('"makes" operation returns makes', async () => {
    mockService.getAllMakes.mockResolvedValue([
      { makeId: 441, makeName: 'TOYOTA' },
      { makeId: 474, makeName: 'HONDA' },
    ]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
    expect(result.models?.[0].modelName).toBe('CAMRY');
    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', undefined, expect.anything());
  });

  it('"models" with modelYear passes year to service', async () => {
    mockService.getModels.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({
      operation: 'models',
      make: 'Toyota',
      modelYear: 2020,
    });
    await lookupVehicles.handler(input, ctx);

    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', 2020, expect.anything());
  });

  it('"models" throws when make missing', async () => {
    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'models' });
    await expect(lookupVehicles.handler(input, ctx)).rejects.toThrow(/make.*required/i);
  });

  it('"vehicle_types" throws when make missing', async () => {
    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'vehicle_types' });
    await expect(lookupVehicles.handler(input, ctx)).rejects.toThrow(/make.*required/i);
  });

  it('"manufacturer" throws when manufacturer param missing', async () => {
    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'manufacturer', manufacturer: 'Toyota' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.manufacturers?.[0].country).toBe('JAPAN');
  });

  it('out-of-bounds offset surfaces a recovery message', async () => {
    mockService.getAllMakes.mockResolvedValue([{ makeId: 1, makeName: 'A' }]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'makes', offset: 50 });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.returned).toBe(0);
    expect(result.message).toMatch(/try a smaller offset/i);
  });

  it('empty models result carries a recovery message', async () => {
    mockService.getModels.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'models', make: 'Nope' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(result.message).toMatch(/verify the make spelling/i);
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
    const text = blocks[0].text;
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
    const text = blocks[0].text;
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
    const text = lookupVehicles.format!(output)[0].text;
    expect(text).toContain('Showing 100 of 500');
    expect(text).toContain('offset 0');
    expect(text).toContain('limit 100');
  });
});
