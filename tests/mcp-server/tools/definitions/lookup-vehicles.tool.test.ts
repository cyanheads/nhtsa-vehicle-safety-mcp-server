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
    expect(result.count).toBe(2);
    expect(result.makes).toHaveLength(2);
  });

  it('"models" operation returns models', async () => {
    mockService.getModels.mockResolvedValue([
      { modelId: 1, modelName: 'CAMRY', makeId: 441, makeName: 'TOYOTA' },
      { modelId: 2, modelName: 'COROLLA', makeId: 441, makeName: 'TOYOTA' },
    ]);

    const ctx = createMockContext();
    const input = lookupVehicles.input.parse({ operation: 'models', make: 'Toyota' });
    const result = await lookupVehicles.handler(input, ctx);

    expect(result.operation).toBe('models');
    expect(result.count).toBe(2);
    expect(result.models?.[0].modelName).toBe('CAMRY');
    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', undefined);
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

    expect(mockService.getModels).toHaveBeenCalledWith('Toyota', 2020);
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

    expect(result.manufacturers?.[0].country).toBe('JAPAN');
  });

  it('format renders makes list', () => {
    const output = {
      operation: 'makes',
      count: 2,
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
      count: 1,
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
});
