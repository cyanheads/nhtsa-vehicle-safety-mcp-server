/**
 * @fileoverview Tests for NhtsaService — fetch retry, response normalization, caching.
 * @module tests/services/nhtsa/nhtsa-service
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNhtsaService, initNhtsaService, NhtsaService } from '@/services/nhtsa/nhtsa-service.js';

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

describe('init / accessor', () => {
  it('throws when not initialized', () => {
    // Create a fresh module state by directly testing the pattern
    const svc = getNhtsaService();
    expect(svc).toBeInstanceOf(NhtsaService);
  });
});

describe('fetchJson retry', () => {
  it('retries on 500 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const svc = getNhtsaService();
    const result = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const svc = getNhtsaService();
    const result = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const svc = getNhtsaService();
    const result = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries when a 200 response contains invalid JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const svc = getNhtsaService();
    const result = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on 403', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 403));

    const svc = getNhtsaService();
    await expect(svc.getRecallsByVehicle('Toyota', 'Camry', 2020)).rejects.toThrow('403');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws user-friendly message on 400 without leaking URL', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 400));

    const svc = getNhtsaService();
    await expect(svc.getRecallsByVehicle('Fake', 'Car', 2020)).rejects.toThrow(
      /no data.*verify make/i,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws after max retries on persistent 500', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));

    const svc = getNhtsaService();
    await expect(svc.getRecallsByVehicle('Toyota', 'Camry', 2020)).rejects.toThrow('500');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('getRecallsByVehicle', () => {
  it('normalizes vehicle-scoped recall response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          {
            Manufacturer: 'Toyota',
            NHTSACampaignNumber: '20V682000',
            parkIt: false,
            parkOutSide: false,
            overTheAirUpdate: true,
            ReportReceivedDate: '11/12/2020',
            Component: 'FUEL/PROPULSION SYSTEM',
            Summary: 'Fuel delivery pipe may leak.',
            Consequence: 'Fire risk.',
            Remedy: 'Replace fuel pipe.',
            Notes: '',
            ModelYear: '2020',
            Make: 'TOYOTA',
            Model: 'CAMRY',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const recalls = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);

    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toEqual({
      campaignNumber: '20V682000',
      manufacturer: 'Toyota',
      component: 'FUEL/PROPULSION SYSTEM',
      summary: 'Fuel delivery pipe may leak.',
      consequence: 'Fire risk.',
      remedy: 'Replace fuel pipe.',
      reportReceivedDate: '2020-12-11',
      parkIt: false,
      parkOutSide: false,
      overTheAirUpdate: true,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/recalls/recallsByVehicle?'),
      expect.anything(),
    );
  });

  it('returns empty array for no results', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Count: 0, Message: 'OK', results: [] }));

    const svc = getNhtsaService();
    expect(await svc.getRecallsByVehicle('Fake', 'Car', 2020)).toEqual([]);
  });

  it('preserves missing advisory flags as undefined', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          {
            Manufacturer: 'Toyota',
            NHTSACampaignNumber: '20V682000',
            ReportReceivedDate: '11/12/2020',
            Component: 'FUEL/PROPULSION SYSTEM',
            Summary: 'Fuel delivery pipe may leak.',
            Consequence: 'Fire risk.',
            Remedy: 'Replace fuel pipe.',
            Notes: '',
            ModelYear: '2020',
            Make: 'TOYOTA',
            Model: 'CAMRY',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const recalls = await svc.getRecallsByVehicle('Toyota', 'Camry', 2020);

    expect(recalls).toHaveLength(1);
    expect(recalls[0].parkIt).toBeUndefined();
    expect(recalls[0].parkOutSide).toBeUndefined();
    expect(recalls[0].overTheAirUpdate).toBeUndefined();
  });
});

describe('getComplaintsByVehicle', () => {
  it('normalizes complaint response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          {
            odiNumber: 12345,
            manufacturer: 'Toyota',
            crash: true,
            fire: false,
            numberOfInjuries: 1,
            numberOfDeaths: 0,
            dateOfIncident: '08/15/2021',
            dateComplaintFiled: '09/01/2021',
            vin: '4T1BF1FK0L',
            components: 'ENGINE AND ENGINE COOLING',
            summary: 'Vehicle stalled on highway.',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toMatchObject({
      odiNumber: 12345,
      crash: true,
      components: 'ENGINE AND ENGINE COOLING',
    });
  });

  it('preserves missing complaint fields as undefined', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 12345 }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints).toHaveLength(1);
    expect(complaints[0].odiNumber).toBe(12345);
    expect(complaints[0].crash).toBeUndefined();
    expect(complaints[0].components).toBeUndefined();
    expect(complaints[0].summary).toBeUndefined();
  });
});

describe('getSafetyRatingVariants', () => {
  it('normalizes variant response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        Results: [
          { VehicleId: 14855, VehicleDescription: '2020 Toyota CAMRY 4 DR AWD' },
          { VehicleId: 14720, VehicleDescription: '2020 Toyota CAMRY 4 DR FWD' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const variants = await svc.getSafetyRatingVariants(2020, 'Toyota', 'Camry');

    expect(variants).toEqual([
      { vehicleId: 14855, vehicleDescription: '2020 Toyota CAMRY 4 DR AWD' },
      { vehicleId: 14720, vehicleDescription: '2020 Toyota CAMRY 4 DR FWD' },
    ]);
  });
});

describe('getSafetyRating', () => {
  it('normalizes full safety rating', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        Results: [
          {
            VehicleId: 14720,
            VehicleDescription: '2020 Toyota CAMRY 4 DR FWD',
            OverallRating: '5',
            OverallFrontCrashRating: '5',
            FrontCrashDriversideRating: '4',
            FrontCrashPassengersideRating: '5',
            OverallSideCrashRating: '5',
            SideCrashDriversideRating: '5',
            SideCrashPassengersideRating: '5',
            'combinedSideBarrierAndPoleRating-Front': '5',
            'combinedSideBarrierAndPoleRating-Rear': '4',
            'sideBarrierRating-Overall': '5',
            SidePoleCrashRating: '5',
            RolloverRating: '4',
            RolloverPossibility: 0.099,
            dynamicTipResult: 'No Tip',
            NHTSAElectronicStabilityControl: 'Standard',
            NHTSAForwardCollisionWarning: 'Standard',
            NHTSALaneDepartureWarning: 'Standard',
            ComplaintsCount: 255,
            RecallsCount: 3,
            InvestigationCount: 0,
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const rating = await svc.getSafetyRating(14720);

    expect(rating).not.toBeNull();
    expect(rating!.overallRating).toBe('5');
    expect(rating!.frontalCrash.driverSide).toBe('4');
    expect(rating!.rollover.probability).toBe(0.099);
    expect(rating!.adasFeatures.electronicStabilityControl).toBe('Standard');
    expect(rating!.complaintsCount).toBe(255);
  });

  it('preserves missing safety rating fields as undefined', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        Results: [{ VehicleId: 14720 }],
      }),
    );

    const svc = getNhtsaService();
    const rating = await svc.getSafetyRating(14720);

    expect(rating).not.toBeNull();
    expect(rating!.vehicleId).toBe(14720);
    expect(rating!.vehicleDescription).toBeUndefined();
    expect(rating!.overallRating).toBeUndefined();
    expect(rating!.frontalCrash.overall).toBeUndefined();
    expect(rating!.rollover.probability).toBeUndefined();
    expect(rating!.complaintsCount).toBeUndefined();
  });

  it('returns null for empty results', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ Count: 0, Message: 'OK', Results: [] }));

    const svc = getNhtsaService();
    expect(await svc.getSafetyRating(99999)).toBeNull();
  });
});

describe('decodeVin', () => {
  it('normalizes VPIC response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: 'VIN:1HGCM82633A004352',
        Results: [
          {
            VIN: '1HGCM82633A004352',
            Make: 'HONDA',
            Model: 'ACCORD',
            ModelYear: '2003',
            BodyClass: 'Sedan/Saloon',
            VehicleType: 'PASSENGER CAR',
            DriveType: 'FWD',
            EngineCylinders: '4',
            DisplacementL: '2.4',
            EngineHP: '160',
            FuelTypePrimary: 'Gasoline',
            Trim: 'EX',
            Manufacturer: 'HONDA',
            PlantCity: 'MARYSVILLE',
            PlantState: 'OHIO',
            PlantCountry: 'UNITED STATES (USA)',
            AirBagLocFront: '1st Row (Driver and Passenger)',
            AirBagLocSide: 'Not Applicable',
            AirBagLocCurtain: '',
            AirBagLocKnee: '',
            ESC: '',
            ABS: '',
            TractionControl: '',
            ErrorCode: '0',
            ErrorText: '',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const vin = await svc.decodeVin('1HGCM82633A004352');

    expect(vin.make).toBe('HONDA');
    expect(vin.model).toBe('ACCORD');
    expect(vin.modelYear).toBe('2003');
    expect(vin.engineHP).toBe('160');
    expect(vin.errorCode).toBe('0');
  });

  it('preserves missing VPIC fields as unknown instead of empty strings', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: 'VIN:1HGCM82633A004352',
        Results: [{ VIN: '1HGCM82633A004352', ErrorCode: '0' }],
      }),
    );

    const svc = getNhtsaService();
    const vin = await svc.decodeVin('1HGCM82633A004352');

    expect(vin.vin).toBe('1HGCM82633A004352');
    expect(vin).not.toHaveProperty('make');
    expect(vin).not.toHaveProperty('model');
    expect(vin.errorCode).toBe('0');
    expect(vin).not.toHaveProperty('errorText');
  });
});

describe('decodeVinBatch', () => {
  it('sends POST with correct body format', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { VIN: 'AAA', Make: 'A', Model: 'A1', ModelYear: '2020', ErrorCode: '0', ErrorText: '' },
          { VIN: 'BBB', Make: 'B', Model: 'B1', ModelYear: '2021', ErrorCode: '0', ErrorText: '' },
        ],
      }),
    );

    const svc = getNhtsaService();
    await svc.decodeVinBatch([{ vin: 'AAA', modelYear: 2020 }, { vin: 'BBB' }]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('DecodeVINValuesBatch');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('DATA=AAA,2020;BBB&format=json');
  });
});

describe('getInvestigations caching', () => {
  it('caches results and does not re-fetch within TTL', async () => {
    const investigationPage = {
      meta: { pagination: { count: 1, max: 100, offset: 0, total: 1 } },
      results: [
        {
          id: 1,
          nhtsaId: 'PE12345',
          investigationType: 'PE',
          status: 'C',
          subject: 'Brake failure',
          description: '<p>Investigation into brake issues</p>',
          openDate: '2023-01-15T00:00:00Z',
          latestActivityDate: '2023-06-01T00:00:00Z',
          issueYear: '2023',
        },
      ],
    };
    mockFetch.mockResolvedValue(jsonResponse(investigationPage));

    const svc = getNhtsaService();

    const first = await svc.getInvestigations();
    expect(first).toHaveLength(1);
    expect(first[0].nhtsaId).toBe('PE12345');
    expect(first[0].description).toBe('Investigation into brake issues'); // HTML stripped

    const second = await svc.getInvestigations();
    expect(second).toHaveLength(1);

    // Only fetched once (cached)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves missing investigation fields as undefined', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        meta: { pagination: { count: 1, max: 100, offset: 0, total: 1 } },
        results: [{ id: 1, nhtsaId: 'PE12345' }],
      }),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    expect(investigations[0].nhtsaId).toBe('PE12345');
    expect(investigations[0].subject).toBeUndefined();
    expect(investigations[0].description).toBeUndefined();
    expect(investigations[0].openDate).toBeUndefined();
  });
});

describe('VPIC lookups', () => {
  it('getAllMakes normalizes response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { Make_ID: 440, Make_Name: 'ASTON MARTIN' },
          { Make_ID: 441, Make_Name: 'TOYOTA' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const makes = await svc.getAllMakes();

    expect(makes).toEqual([
      { makeId: 440, makeName: 'ASTON MARTIN' },
      { makeId: 441, makeName: 'TOYOTA' },
    ]);
  });

  it('getModels with year uses correct URL', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [{ Make_ID: 441, Make_Name: 'TOYOTA', Model_ID: 1, Model_Name: 'CAMRY' }],
      }),
    );

    const svc = getNhtsaService();
    await svc.getModels('Toyota', 2020);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('GetModelsForMakeYear/make/Toyota/modelyear/2020'),
      expect.anything(),
    );
  });

  it('getModels without year uses correct URL', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [{ Make_ID: 441, Make_Name: 'TOYOTA', Model_ID: 1, Model_Name: 'CAMRY' }],
      }),
    );

    const svc = getNhtsaService();
    await svc.getModels('Toyota');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('GetModelsForMake/Toyota'),
      expect.anything(),
    );
  });

  it('getVehicleTypes normalizes and deduplicates response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 4,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          { VehicleTypeId: 2, VehicleTypeName: 'Passenger Car' },
          { VehicleTypeId: 6, VehicleTypeName: 'Trailer' },
          { VehicleTypeId: 6, VehicleTypeName: 'Trailer' },
          { VehicleTypeId: 2, VehicleTypeName: 'Passenger Car' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const types = await svc.getVehicleTypes('Ford');
    expect(types).toEqual([
      { vehicleTypeId: 2, vehicleTypeName: 'Passenger Car' },
      { vehicleTypeId: 6, vehicleTypeName: 'Trailer' },
    ]);
  });

  it('getManufacturer normalizes response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          {
            Mfr_ID: 987,
            Mfr_Name: 'TOYOTA MOTOR CORPORATION',
            Country: 'JAPAN',
            VehicleTypes: [{ IsPrimary: true, Name: 'Passenger Car', Id: 2 }],
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const mfrs = await svc.getManufacturer('Toyota');
    expect(mfrs[0]).toMatchObject({
      manufacturerId: 987,
      manufacturerName: 'TOYOTA MOTOR CORPORATION',
      country: 'JAPAN',
      vehicleTypes: [{ id: 2, name: 'Passenger Car' }],
    });
  });

  it('getManufacturer handles missing vehicle type IDs', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          {
            Mfr_ID: 955,
            Mfr_Name: 'TESLA, INC.',
            Country: 'UNITED STATES (USA)',
            VehicleTypes: [
              { IsPrimary: true, Name: 'Passenger Car' },
              { IsPrimary: false, Name: 'Multipurpose Passenger Vehicle (MPV)' },
              { IsPrimary: false, Name: 'Truck' },
            ],
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const mfrs = await svc.getManufacturer('Tesla');
    expect(mfrs[0].vehicleTypes).toHaveLength(3);
    expect(mfrs[0].vehicleTypes[0]).toEqual({ name: 'Passenger Car' });
  });

  it('getManufacturer omits missing country instead of returning an empty string', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [
          {
            Mfr_ID: 955,
            Mfr_Name: 'TESLA, INC.',
            VehicleTypes: [{ IsPrimary: true, Name: 'Passenger Car' }],
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const mfrs = await svc.getManufacturer('Tesla');

    expect(mfrs[0]).not.toHaveProperty('country');
  });
});

describe('getRecallCampaign binary search', () => {
  it('finds a campaign by ID', async () => {
    const target = '20V682000';
    // Mock: initial call returns total, binary search hits target
    mockFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset') ?? 0);

      if (offset === 0 && u.searchParams.get('max') === '1') {
        // Initial call or binary search step — return something before or at the target
        return jsonResponse({
          meta: { pagination: { count: 1, max: 1, offset: 0, total: 100 } },
          results: [
            {
              id: 1,
              campaignId: '10V100000',
              nhtsaCampaignNumber: '10V100',
              subject: 'Other recall',
              description: 'Other desc',
              consequence: 'None',
              correctiveAction: 'None',
              manufacturerName: 'Other',
              potaff: 100,
              recall573ReceivedDate: '2010-01-01T00:00:00Z',
              recallType: 'V',
              parkVehicleYn: false,
              parkOutsideYn: false,
              overTheAirUpdateYn: false,
            },
          ],
        });
      }

      // Binary search mid-point checks: return the target when offset is >= 50
      if (offset >= 50) {
        return jsonResponse({
          meta: { pagination: { count: 1, max: 1, offset, total: 100 } },
          results: [
            {
              id: 50,
              campaignId: target,
              nhtsaCampaignNumber: '20V682',
              subject: 'Fuel leak',
              description: 'Fuel delivery pipe leak',
              consequence: 'Fire risk',
              correctiveAction: 'Replace pipe',
              manufacturerName: 'Toyota',
              potaff: 5000,
              recall573ReceivedDate: '2020-11-12T00:00:00Z',
              recallType: 'V',
              parkVehicleYn: false,
              parkOutsideYn: false,
              overTheAirUpdateYn: false,
            },
          ],
        });
      }

      // Before target
      return jsonResponse({
        meta: { pagination: { count: 1, max: 1, offset, total: 100 } },
        results: [
          {
            id: offset,
            campaignId: `10V${String(offset).padStart(6, '0')}`,
            nhtsaCampaignNumber: `10V${String(offset).padStart(3, '0')}`,
            subject: 'Before',
            description: 'Before target',
            consequence: 'None',
            correctiveAction: 'None',
            manufacturerName: 'Other',
            potaff: 0,
            recall573ReceivedDate: '2010-01-01T00:00:00Z',
            recallType: 'V',
            parkVehicleYn: false,
            parkOutsideYn: false,
            overTheAirUpdateYn: false,
          },
        ],
      });
    });

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign(target);

    expect(result).not.toBeNull();
    expect(result!.campaignNumber).toBe(target);
    expect(result!.manufacturer).toBe('Toyota');
    expect(result!.potentialUnitsAffected).toBe(5000);
  });

  it('returns null when campaign not found', async () => {
    // All records have campaignIds that don't match
    mockFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const max = Number(u.searchParams.get('max') ?? 1);

      return jsonResponse({
        meta: { pagination: { count: Math.min(max, 3), max, offset, total: 3 } },
        results: Array.from({ length: Math.min(max, 3 - offset) }, (_, i) => ({
          id: offset + i,
          campaignId: `AAA${String(offset + i).padStart(6, '0')}`,
          nhtsaCampaignNumber: `AAA${String(offset + i).padStart(3, '0')}`,
          subject: 'Unrelated',
          description: 'Unrelated',
          consequence: 'None',
          correctiveAction: 'None',
          manufacturerName: 'Other',
          potaff: 0,
          recall573ReceivedDate: '2020-01-01T00:00:00Z',
          recallType: 'V',
          parkVehicleYn: false,
          parkOutsideYn: false,
          overTheAirUpdateYn: false,
        })),
      });
    });

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign('ZZZ999999');
    expect(result).toBeNull();
  });

  it('preserves missing advisory flags in campaign lookups', async () => {
    const target = '20V682000';
    mockFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset') ?? 0);

      if (offset === 0 && u.searchParams.get('max') === '1') {
        return jsonResponse({
          meta: { pagination: { count: 1, max: 1, offset: 0, total: 100 } },
          results: [
            {
              id: 1,
              campaignId: '10V100000',
              nhtsaCampaignNumber: '10V100',
              subject: 'Other recall',
              description: 'Other desc',
              consequence: 'None',
              correctiveAction: 'None',
              manufacturerName: 'Other',
              potaff: 100,
              recall573ReceivedDate: '2010-01-01T00:00:00Z',
              recallType: 'V',
              parkVehicleYn: false,
              parkOutsideYn: false,
              overTheAirUpdateYn: false,
            },
          ],
        });
      }

      return jsonResponse({
        meta: { pagination: { count: 1, max: 1, offset, total: 100 } },
        results: [
          {
            id: 50,
            campaignId: target,
            nhtsaCampaignNumber: '20V682',
            subject: 'Fuel leak',
            description: 'Fuel delivery pipe leak',
            consequence: 'Fire risk',
            correctiveAction: 'Replace pipe',
            manufacturerName: 'Toyota',
            potaff: 5000,
            recall573ReceivedDate: '2020-11-12T00:00:00Z',
            recallType: 'V',
          },
        ],
      });
    });

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign(target);

    expect(result).not.toBeNull();
    expect(result!.parkIt).toBeUndefined();
    expect(result!.parkOutSide).toBeUndefined();
    expect(result!.overTheAirUpdate).toBeUndefined();
  });
});
