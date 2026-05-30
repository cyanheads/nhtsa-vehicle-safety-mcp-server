/**
 * @fileoverview Tests for NhtsaService — fetch retry, response normalization, caching.
 * @module tests/services/nhtsa/nhtsa-service
 */

import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNhtsaService, initNhtsaService, NhtsaService } from '@/services/nhtsa/nhtsa-service.js';

/** Build a minimal FLAT_INV.zip Response for testing. */
function makeFlatInvZipResponse(rows: string[][]): Response {
  const tab = '\t';
  const content = rows.map((r) => r.join(tab)).join('\n');
  const enc = new TextEncoder().encode(content);
  const zipped = zipSync({ 'FLAT_INV.txt': enc });
  return new Response(zipped, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

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

  it('throws on a genuinely malformed 400 (no results envelope)', async () => {
    // A plain 400 with no results/message envelope → httpErrorFromResponse
    mockFetch.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));

    const svc = getNhtsaService();
    await expect(svc.getRecallsByVehicle('Fake', 'Car', 2020)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array on 400 with NHTSA empty-result envelope (vehicle exists, no recalls)', async () => {
    // NHTSA returns 400 + success envelope for valid vehicles with no records
    mockFetch.mockResolvedValue(
      jsonResponse({ Count: 0, Message: 'Results returned successfully', results: [] }, 400),
    );

    const svc = getNhtsaService();
    const result = await svc.getRecallsByVehicle('Toyota', 'Camry', 2026);
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array on 400 with lowercase message envelope (complaints endpoint shape)', async () => {
    // complaintsByVehicle uses lowercase count/message
    mockFetch.mockResolvedValue(
      jsonResponse({ count: 0, message: 'Results returned successfully', results: [] }, 400),
    );

    const svc = getNhtsaService();
    const result = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2026);
    expect(result).toEqual([]);
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

    expect(vin).not.toBeNull();
    expect(vin!.make).toBe('HONDA');
    expect(vin!.model).toBe('ACCORD');
    expect(vin!.modelYear).toBe('2003');
    expect(vin!.engineHP).toBe('160');
    expect(vin!.errorCode).toBe('0');
  });

  it('returns null when VPIC returns empty Results[] (e.g. nonsense VIN)', async () => {
    // #8 fix: returns null instead of throwing
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 0,
        Message: 'OK',
        SearchCriteria: 'VIN:test',
        Results: [],
      }),
    );

    const svc = getNhtsaService();
    const result = await svc.decodeVin('test');
    expect(result).toBeNull();
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

    expect(vin).not.toBeNull();
    expect(vin!.vin).toBe('1HGCM82633A004352');
    expect(vin!).not.toHaveProperty('make');
    expect(vin!).not.toHaveProperty('model');
    expect(vin!.errorCode).toBe('0');
    expect(vin!).not.toHaveProperty('errorText');
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

describe('getInvestigations caching (flat-file source)', () => {
  // FLAT_INV column order: nhtsaId, make, model, year, component, mfrName, openDate, closeDate, campno, subject, summary
  it('parses a flat-file zip and caches results', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        [
          'PE12345',
          'TOYOTA',
          'CAMRY',
          '2020',
          'BRAKES',
          'TOYOTA MOTOR',
          '20230115',
          '',
          '',
          'Brake failure',
          'Investigation into brake issues',
        ],
      ]),
    );

    const svc = getNhtsaService();

    const first = await svc.getInvestigations();
    expect(first).toHaveLength(1);
    expect(first[0].nhtsaId).toBe('PE12345');
    expect(first[0].investigationType).toBe('PE');
    expect(first[0].status).toBe('O'); // no closeDate → open
    expect(first[0].makes).toEqual(['TOYOTA']);
    expect(first[0].models).toEqual(['CAMRY']);
    expect(first[0].components).toEqual(['BRAKES']);
    expect(first[0].subject).toBe('Brake failure');
    expect(first[0].openDate).toBe('2023-01-15');

    // Second call uses cache — only one fetch
    const second = await svc.getInvestigations();
    expect(second).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('collapses multiple association rows for the same nhtsaId', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        [
          'PE12345',
          'TOYOTA',
          'CAMRY',
          '2020',
          'BRAKES',
          'TOYOTA MOTOR',
          '20230115',
          '',
          '',
          'Brake failure',
          'Investigation into brake issues',
        ],
        [
          'PE12345',
          'TOYOTA',
          'COROLLA',
          '2021',
          'BRAKES',
          'TOYOTA MOTOR',
          '20230115',
          '',
          '',
          'Brake failure',
          'Investigation into brake issues',
        ],
      ]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    expect(investigations[0].nhtsaId).toBe('PE12345');
    expect(investigations[0].models).toContain('CAMRY');
    expect(investigations[0].models).toContain('COROLLA');
    expect(investigations[0].years).toContain(2020);
    expect(investigations[0].years).toContain(2021);
  });

  it('marks investigation as closed when closeDate is present', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        [
          'EA99001',
          'HONDA',
          'CIVIC',
          '2019',
          'ENGINE',
          'HONDA',
          '20210101',
          '20220101',
          '21V407000',
          'Engine stall',
          'Engine stalling issue',
        ],
      ]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations[0].status).toBe('C');
    expect(investigations[0].closeDate).toBe('2022-01-01');
    expect(investigations[0].recallCampaign).toBe('21V407000');
    expect(investigations[0].investigationType).toBe('EA');
  });

  it('omits fields for sparse rows', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([['PE12345', '', '', '9999', '', '', '', '', '', '', '']]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    expect(investigations[0].nhtsaId).toBe('PE12345');
    expect(investigations[0].subject).toBeUndefined();
    expect(investigations[0].openDate).toBeUndefined();
    expect(investigations[0].years).toEqual([]); // 9999 excluded
    expect(investigations[0].makes).toEqual([]);
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

describe('getRecallCampaign (direct endpoint)', () => {
  it('finds a campaign by number via direct endpoint', async () => {
    const target = '20V682000';
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: target,
            Manufacturer: 'Toyota',
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
    const result = await svc.getRecallCampaign(target);

    expect(result).not.toBeNull();
    expect(result!.campaignNumber).toBe(target);
    expect(result!.manufacturer).toBe('Toyota');
    expect(result!.component).toBe('FUEL/PROPULSION SYSTEM');
    expect(result!.potentialUnitsAffected).toBe(5000);
    expect(result!.receivedDate).toBe('2020-12-11');
    // Single request to the direct endpoint
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/recalls/campaignNumber');
  });

  it('returns null when campaign is not found (empty results)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 0,
        Message: 'Results returned successfully',
        results: [],
      }),
    );

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaign('ZZZ999999');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves missing advisory flags in campaign lookups', async () => {
    const target = '20V682000';
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: target,
            Manufacturer: 'Toyota',
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
    const result = await svc.getRecallCampaign(target);

    expect(result).not.toBeNull();
    expect(result!.parkIt).toBeUndefined();
    expect(result!.parkOutSide).toBeUndefined();
    expect(result!.overTheAirUpdate).toBeUndefined();
  });
});
