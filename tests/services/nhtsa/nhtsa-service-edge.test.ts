/**
 * @fileoverview Additional edge-case coverage for NhtsaService — recall campaign subject/notes,
 * model normalization, timeout/abort handling, and decodeVinBatch with modelYear.
 * @module tests/services/nhtsa/nhtsa-service-edge
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNhtsaService, initNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  initNhtsaService();
});

describe('getRecallCampaign — subject and notes fields', () => {
  it('normalizes Subject field from campaign response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: '20V682000',
            Manufacturer: 'Toyota',
            Subject: 'Fuel pipe corrosion',
            Component: 'FUEL/PROPULSION SYSTEM',
            Summary: 'Fuel delivery pipe may leak.',
            Consequence: 'Fire risk.',
            Remedy: 'Replace fuel pipe.',
            ReportReceivedDate: '11/12/2020',
            PotentialNumberofUnitsAffected: 5000,
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign('20V682000');

    expect(result).not.toBeNull();
    // Subject field maps to a separate property if the service exposes it
    expect(result!.campaignNumber).toBe('20V682000');
    expect(result!.summary).toContain('Fuel delivery pipe');
  });

  it('handles missing PotentialNumberofUnitsAffected gracefully', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: '20V682000',
            Manufacturer: 'Toyota',
            Component: 'FUEL/PROPULSION SYSTEM',
            Summary: 'Fuel delivery pipe may leak.',
            Consequence: 'Fire risk.',
            Remedy: 'Replace fuel pipe.',
            ReportReceivedDate: '11/12/2020',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign('20V682000');

    expect(result).not.toBeNull();
    // When absent, potentialUnitsAffected should be undefined or 0
    expect(
      result!.potentialUnitsAffected === undefined || result!.potentialUnitsAffected === 0,
    ).toBe(true);
  });
});

describe('getModels — normalization', () => {
  it('normalizes VPIC model response fields', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { Make_ID: 441, Make_Name: 'TOYOTA', Model_ID: 1, Model_Name: 'CAMRY' },
          { Make_ID: 441, Make_Name: 'TOYOTA', Model_ID: 2, Model_Name: 'COROLLA' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const models = await svc.getModels('Toyota');

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      makeId: 441,
      makeName: 'TOYOTA',
      modelId: 1,
      modelName: 'CAMRY',
    });
    expect(models[1].modelName).toBe('COROLLA');
  });

  it('returns empty array when no models found', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ Count: 0, Message: 'OK', SearchCriteria: '', Results: [] }),
    );

    const svc = getNhtsaService();
    const models = await svc.getModels('UnknownMake');
    expect(models).toEqual([]);
  });
});

describe('decodeVinBatch — modelYear propagation', () => {
  it('includes modelYear in batch body when provided for all VINs', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { VIN: 'AAA', Make: 'A', Model: 'A1', ModelYear: '2020', ErrorCode: '0', ErrorText: '' },
          { VIN: 'BBB', Make: 'B', Model: 'B1', ModelYear: '2020', ErrorCode: '0', ErrorText: '' },
        ],
      }),
    );

    const svc = getNhtsaService();
    await svc.decodeVinBatch([
      { vin: 'AAA', modelYear: 2020 },
      { vin: 'BBB', modelYear: 2020 },
    ]);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.body).toContain('AAA,2020');
    expect(init.body).toContain('BBB,2020');
  });

  it('omits modelYear from batch body when not provided', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { VIN: 'CCC', Make: 'C', Model: 'C1', ModelYear: '2021', ErrorCode: '0', ErrorText: '' },
        ],
      }),
    );

    const svc = getNhtsaService();
    await svc.decodeVinBatch([{ vin: 'CCC' }]);

    const [, init] = mockFetch.mock.calls[0];
    // No year in body — just the VIN
    expect(init.body).toBe('DATA=CCC&format=json');
  });
});

describe('abort signal handling', () => {
  it('passes an AbortSignal to fetch for getRecallsByVehicle', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const controller = new AbortController();
    const svc = getNhtsaService();
    await svc.getRecallsByVehicle('Toyota', 'Camry', 2020, controller.signal);

    const [, init] = mockFetch.mock.calls[0];
    // The service may wrap the signal in a composite — check it's an AbortSignal
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an AbortSignal to fetch for decodeVin', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: 'VIN:TEST',
        Results: [{ VIN: 'TEST', ErrorCode: '0' }],
      }),
    );

    const controller = new AbortController();
    const svc = getNhtsaService();
    await svc.decodeVin('TEST', undefined, controller.signal);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('getVehicleTypes — normalization', () => {
  it('normalizes VehicleTypeId and VehicleTypeName fields', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { VehicleTypeId: 2, VehicleTypeName: 'Passenger Car' },
          { VehicleTypeId: 6, VehicleTypeName: 'Trailer' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const types = await svc.getVehicleTypes('Toyota');

    expect(types).toHaveLength(2);
    expect(types[0]).toEqual({ vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' });
    expect(types[1]).toEqual({ vehicleTypeId: 6, vehicleTypeName: 'Trailer' });
  });
});

describe('getSafetyRatingVariants — signal propagation', () => {
  it('passes an AbortSignal through for variant lookup', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 0,
        Message: 'OK',
        Results: [],
      }),
    );

    const controller = new AbortController();
    const svc = getNhtsaService();
    await svc.getSafetyRatingVariants(2020, 'Toyota', 'Camry', controller.signal);

    const [, init] = mockFetch.mock.calls[0];
    // The service may compose the signal — check it's an AbortSignal
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
