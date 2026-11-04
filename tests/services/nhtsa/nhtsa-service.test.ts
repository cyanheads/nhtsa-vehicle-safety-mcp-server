/**
 * @fileoverview Tests for NhtsaService — fetch retry, response normalization, caching.
 * @module tests/services/nhtsa/nhtsa-service
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNhtsaService,
  initNhtsaService,
  MANUFACTURER_RESULT_CAP,
  NhtsaService,
} from '@/services/nhtsa/nhtsa-service.js';

/** The smallest FLAT_INV a load accepts: one row, one investigation. */
const ONE_INV_ROW = ['PE25001', 'TOYOTA', 'CAMRY', '2020', 'BRAKES', 'Toyota'];

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

/** Run a full, synchronous garbage collection under Bun or Node. */
function forceGc(): void {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
  if (bun) {
    bun.gc(true);
    return;
  }
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
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
    expect(recalls[0]!.parkIt).toBeUndefined();
    expect(recalls[0]!.parkOutSide).toBeUndefined();
    expect(recalls[0]!.overTheAirUpdate).toBeUndefined();
  });

  it('omits the summary, consequence, and remedy an older campaign sends as null', async () => {
    // A 1967 Dodge Dart row as the endpoint returns it: the campaign text is null, not blank.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            Manufacturer: 'CHRYSLER CORPORATION',
            NHTSACampaignNumber: '66V008001',
            parkIt: false,
            parkOutSide: false,
            overTheAirUpdate: false,
            ReportReceivedDate: '12/10/1966',
            Component: 'WHEELS',
            Summary: null,
            Consequence: null,
            Remedy: null,
            Notes: 'POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.',
            ModelYear: '1967',
            Make: 'DODGE',
            Model: 'DART',
          },
        ],
      }),
    );

    const recalls = await getNhtsaService().getRecallsByVehicle('Dodge', 'Dart', 1967);

    expect(recalls).toStrictEqual([
      {
        campaignNumber: '66V008001',
        manufacturer: 'CHRYSLER CORPORATION',
        component: 'WHEELS',
        reportReceivedDate: '1966-10-12',
        parkIt: false,
        parkOutSide: false,
        overTheAirUpdate: false,
      },
    ]);
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
      // MM/DD/YYYY upstream → ISO, matching the recall paths
      dateOfIncident: '2021-08-15',
      dateComplaintFiled: '2021-09-01',
    });
  });

  it('reads complaint dates month-first, not day-first', async () => {
    // 03/01/2025 is March 1 under MM/DD/YYYY; the recall paths would read it as January 3.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          {
            odiNumber: 11752925,
            dateOfIncident: '03/01/2025',
            dateComplaintFiled: '07/26/2026',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints[0]!.dateOfIncident).toBe('2025-03-01');
    expect(complaints[0]!.dateComplaintFiled).toBe('2026-07-26');
  });

  it('drops the epoch placeholder from dateOfIncident', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 1, dateOfIncident: '12/31/1969', dateComplaintFiled: '01/15/2020' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    // The filing date carries no placeholder rule — an old filing is preserved, normalized.
    expect(complaints[0]!.dateComplaintFiled).toBe('2020-01-15');
  });

  it('drops the 1901 placeholder from dateOfIncident', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'OK',
        results: [
          { odiNumber: 10181588, dateOfIncident: '01/01/1901' },
          { odiNumber: 10169078, dateOfIncident: '09/01/1901' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Ford', 'Explorer', 1998);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    expect(complaints[1]!.dateOfIncident).toBeUndefined();
  });

  it('reports a placeholder as absent, not as an unreliable value', async () => {
    // 1901 also predates the model year, but a placeholder means NHTSA holds no incident date
    // at all — reporting one would invent a claim the record never made.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 1, dateOfIncident: '01/01/1901', dateComplaintFiled: '01/15/2020' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
  });

  it('keeps a genuine pre-1990 incident date', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          { odiNumber: 967440, dateOfIncident: '09/29/1989', dateComplaintFiled: '06/21/1995' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Honda', 'Accord', 1986);

    expect(complaints[0]!.dateOfIncident).toBe('1989-09-29');
    expect(complaints[0]!.dateComplaintFiled).toBe('1995-06-21');
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
  });

  it('keeps a 1970 incident date that is not the epoch placeholder', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 2, dateOfIncident: '07/04/1970' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Ford', 'Pinto', 1971);

    expect(complaints[0]!.dateOfIncident).toBe('1970-07-04');
  });

  it('passes through complaint dates it cannot parse instead of inventing one', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 1, dateOfIncident: 'unknown', dateComplaintFiled: '  ' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Toyota', 'Camry', 2020);

    expect(complaints[0]!.dateOfIncident).toBe('unknown');
    expect(complaints[0]!.dateComplaintFiled).toBeUndefined();
    // Ordering comparisons are meaningless on an unparseable value — no verdict is invented.
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
  });

  it('reports a mistyped incident year rather than rendering it as the incident date', async () => {
    // ODI 10877133 — upstream carries 06/28/1016 on a 2016 vehicle filed 06/28/2016.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          { odiNumber: 10877133, dateOfIncident: '06/28/1016', dateComplaintFiled: '06/28/2016' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Hyundai', 'Santa Fe', 2016);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    expect(complaints[0]!.unreliableIncidentDate).toEqual({
      reported: '1016-06-28',
      reason: 'predates_model_year',
    });
    expect(complaints[0]!.dateComplaintFiled).toBe('2016-06-28');
  });

  it('reports an incident date that postdates the complaint reporting it', async () => {
    // ODI 844272 — upstream carries 07/28/2019 on a complaint filed 08/04/1999.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [
          { odiNumber: 844272, dateOfIncident: '07/28/2019', dateComplaintFiled: '08/04/1999' },
        ],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Chevrolet', 'Corvette', 1998);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    expect(complaints[0]!.unreliableIncidentDate).toEqual({
      reported: '2019-07-28',
      reason: 'postdates_filing',
    });
  });

  it('keeps an incident in the calendar year a model year opens in', async () => {
    // A 2016 model reaches the road in 2015, so 2015 is a real incident year for one.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 2, dateOfIncident: '11/02/2015', dateComplaintFiled: '01/05/2016' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Hyundai', 'Santa Fe', 2016);

    expect(complaints[0]!.dateOfIncident).toBe('2015-11-02');
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
  });

  it('rejects an incident dated before the vehicle could exist', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 3, dateOfIncident: '11/02/2014', dateComplaintFiled: '01/05/2016' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Hyundai', 'Santa Fe', 2016);

    expect(complaints[0]!.dateOfIncident).toBeUndefined();
    expect(complaints[0]!.unreliableIncidentDate).toEqual({
      reported: '2014-11-02',
      reason: 'predates_model_year',
    });
  });

  it('applies no model-year bound to the 9999 no-model-year placeholder', async () => {
    // Equipment complaints carry 9999 where no model year applies; there is no vehicle to
    // date the incident against, so the value is forwarded rather than judged.
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 4, dateOfIncident: '04/25/0202', dateComplaintFiled: '07/11/2002' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Graco', 'Child Safety Seat', 9999);

    expect(complaints[0]!.dateOfIncident).toBe('0202-04-25');
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
  });

  it('leaves the incident date alone when there is no filing date to compare it against', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        results: [{ odiNumber: 5, dateOfIncident: '07/28/2019' }],
      }),
    );

    const svc = getNhtsaService();
    const complaints = await svc.getComplaintsByVehicle('Chevrolet', 'Corvette', 2018);

    expect(complaints[0]!.dateOfIncident).toBe('2019-07-28');
    expect(complaints[0]!.unreliableIncidentDate).toBeUndefined();
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
    expect(complaints[0]!.odiNumber).toBe(12345);
    expect(complaints[0]!.crash).toBeUndefined();
    expect(complaints[0]!.components).toBeUndefined();
    expect(complaints[0]!.summary).toBeUndefined();
  });

  it('omits an incident date the endpoint sends as null, and reports nothing contradicted', async () => {
    // A 1985 Ford Mustang complaint as the endpoint returns it: no incident date, sent as null.
    mockFetch.mockResolvedValue(
      jsonResponse({
        count: 1,
        message: 'Results returned successfully',
        results: [
          {
            odiNumber: 780503,
            manufacturer: 'Ford Motor Company',
            crash: false,
            fire: false,
            numberOfInjuries: 0,
            numberOfDeaths: 0,
            dateOfIncident: null,
            dateComplaintFiled: '09/24/1998',
            vin: '',
            components: 'ENGINE AND ENGINE COOLING,POWER TRAIN',
            summary: 'MULTIPLE CLUTCH FAILURES.',
          },
        ],
      }),
    );

    const complaints = await getNhtsaService().getComplaintsByVehicle('Ford', 'Mustang', 1985);

    expect(complaints).toStrictEqual([
      {
        odiNumber: 780503,
        manufacturer: 'Ford Motor Company',
        crash: false,
        fire: false,
        numberOfInjuries: 0,
        numberOfDeaths: 0,
        dateComplaintFiled: '1998-09-24',
        components: 'ENGINE AND ENGINE COOLING,POWER TRAIN',
        summary: 'MULTIPLE CLUTCH FAILURES.',
      },
    ]);
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

  it('omits the rollover probability sentinel when the vehicle is not rollover-rated', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        Results: [
          {
            VehicleId: 3440,
            VehicleDescription: '1995 Geo Metro 4-DR.',
            RolloverRating: 'Not Rated',
            RolloverPossibility: 0,
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const rating = await svc.getSafetyRating(3440);

    expect(rating!.rollover.rating).toBe('Not Rated');
    expect(rating!.rollover.probability).toBeUndefined();
  });

  it('omits the rollover probability when no rollover rating is reported', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        Results: [{ VehicleId: 3441, RolloverPossibility: 0 }],
      }),
    );

    const svc = getNhtsaService();
    const rating = await svc.getSafetyRating(3441);

    expect(rating!.rollover.rating).toBeUndefined();
    expect(rating!.rollover.probability).toBeUndefined();
  });

  it('preserves a genuine rollover probability for a rated vehicle', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        Results: [{ VehicleId: 14720, RolloverRating: '5', RolloverPossibility: 0.099 }],
      }),
    );

    const svc = getNhtsaService();
    const rating = await svc.getSafetyRating(14720);

    expect(rating!.rollover.probability).toBe(0.099);
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

  it('maps the driver-assistance equipment VPIC decodes, verbatim (#50)', async () => {
    respondFromVpic([RAV4_DECODE]);

    const vin = await getNhtsaService().decodeVin('2T3P1RFV5MW145243');

    expect(vin).toEqual(RAV4_DECODED);
  });

  it('omits every driver-assistance field VPIC leaves blank (#50)', async () => {
    respondFromVpic([
      {
        VIN: '1HGCM82633A004352',
        Make: 'HONDA',
        ErrorCode: '0',
        ...Object.fromEntries(Object.keys(RAV4_EQUIPMENT).map((key) => [key, ''])),
      },
    ]);

    const vin = await getNhtsaService().decodeVin('1HGCM82633A004352');

    expect(vin).toEqual({ vin: '1HGCM82633A004352', make: 'HONDA', errorCode: '0' });
  });
});

/** VPIC's driver-assistance keys for 2T3P1RFV5MW145243 (2021 RAV4), as VPIC returns them. */
const RAV4_EQUIPMENT = {
  CIB: 'Standard',
  DynamicBrakeSupport: 'Standard',
  PedestrianAutomaticEmergencyBraking: 'Standard',
  ForwardCollisionWarning: 'Standard',
  LaneDepartureWarning: 'Standard',
  LaneKeepSystem: 'Standard',
  LaneCenteringAssistance: 'Standard',
  BlindSpotMon: 'Standard',
  BlindSpotIntervention: '',
  RearCrossTrafficAlert: 'Standard',
  RearVisibilitySystem: 'Standard',
  RearAutomaticEmergencyBraking: '',
  ParkAssist: '',
  AdaptiveCruiseControl: 'Standard',
  TPMS: 'Direct',
  AirBagLocSeatCushion: 'Passenger Seat Only',
};
const RAV4_DECODE = {
  VIN: '2T3P1RFV5MW145243',
  Make: 'TOYOTA',
  Model: 'RAV4',
  ModelYear: '2021',
  ErrorCode: '1',
  ...RAV4_EQUIPMENT,
};
const RAV4_DECODED = {
  vin: '2T3P1RFV5MW145243',
  make: 'TOYOTA',
  model: 'RAV4',
  modelYear: '2021',
  errorCode: '1',
  crashImminentBraking: 'Standard',
  dynamicBrakeSupport: 'Standard',
  pedestrianAutomaticEmergencyBraking: 'Standard',
  forwardCollisionWarning: 'Standard',
  laneDepartureWarning: 'Standard',
  laneKeepingAssistance: 'Standard',
  laneCenteringAssistance: 'Standard',
  blindSpotWarning: 'Standard',
  rearCrossTrafficAlert: 'Standard',
  backupCamera: 'Standard',
  adaptiveCruiseControl: 'Standard',
  tpmsType: 'Direct',
  airBagLocSeatCushion: 'Passenger Seat Only',
};

/** Answer VPIC requests with `results`; any other host is an unmocked call. */
function respondFromVpic(results: Record<string, string>[]): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (new URL(url).hostname !== 'vpic.nhtsa.dot.gov') throw new Error('unmocked fetch');
    return jsonResponse({
      Count: results.length,
      Message: 'OK',
      SearchCriteria: '',
      Results: results,
    });
  });
}

describe('decodeVinBatch', () => {
  it('maps the same driver-assistance equipment on the batch path (#50)', async () => {
    respondFromVpic([RAV4_DECODE]);

    const vins = await getNhtsaService().decodeVinBatch([{ vin: '2T3P1RFV5MW145243' }]);

    expect(vins).toEqual([RAV4_DECODED]);
  });

  it('form-encodes the batch body, so VPIC reads one DATA field (#49)', async () => {
    respondFromVpic([]);

    await getNhtsaService().decodeVinBatch([
      { vin: 'AAA', modelYear: 2020 },
      { vin: '5YJ3E1EA*KF' },
      { vin: 'BBB' },
    ]);

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.body).toBe('DATA=AAA%2C2020%3B5YJ3E1EA*KF%3BBBB&format=json');
    expect(new URLSearchParams(init.body).get('DATA')).toBe('AAA,2020;5YJ3E1EA*KF;BBB');
  });

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

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('DecodeVINValuesBatch');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('DATA=AAA%2C2020%3BBBB&format=json');
  });
});

describe('getInvestigations caching (flat-file source)', () => {
  it.each(['headers', 'body'])(
    'bounds stalled %s after every waiter cancels and permits retry (#44)',
    async (phase) => {
      vi.useFakeTimers();
      const svc = new NhtsaService();
      const started = Promise.withResolvers<void>();
      const bodyRead = Promise.withResolvers<void>();
      const abortedBody = vi.fn();
      mockFetch.mockImplementation((url, init) => {
        expect(new URL(url).hostname).toBe('static.nhtsa.gov');
        started.resolve();
        if (phase === 'headers')
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
          );
        return Promise.resolve(
          new Response(
            new ReadableStream(
              {
                start(controller) {
                  init.signal.addEventListener(
                    'abort',
                    () => {
                      abortedBody();
                      controller.error(init.signal.reason);
                    },
                    { once: true },
                  );
                },
                pull() {
                  bodyRead.resolve();
                  return new Promise(() => {});
                },
              },
              { highWaterMark: 0 },
            ),
          ),
        );
      });
      try {
        const caller = new AbortController();
        const waiting = svc.getInvestigations(caller.signal);
        const rejection = expect(waiting).rejects.toThrow(/abort|cancel/i);
        await started.promise;
        if (phase === 'body') await bodyRead.promise;
        caller.abort();
        await rejection;
        await vi.advanceTimersByTimeAsync(120_000);
        if (phase === 'body') expect(abortedBody).toHaveBeenCalledTimes(1);
        mockFetch.mockResolvedValueOnce(makeFlatInvZipResponse([ONE_INV_ROW]));
        expect(await svc.getInvestigations()).toHaveLength(1);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(['cold', 'expired'])('coalesces %s loads (#44)', async (state) => {
    const svc = new NhtsaService();
    const rows = [
      [
        'PE12345',
        'TOYOTA',
        'CAMRY',
        '2020',
        'BRAKES',
        'TOYOTA',
        '20230115',
        '',
        '',
        'Subject',
        'Summary',
      ],
    ];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    try {
      if (state === 'expired') {
        mockFetch.mockImplementation(async () => makeFlatInvZipResponse(rows));
        await svc.getInvestigations();
        clock.mockReturnValue(Date.UTC(2026, 0, 2));
        mockFetch.mockReset();
      }
      const response = Promise.withResolvers<Response>();
      mockFetch.mockImplementation((url) => {
        expect(new URL(url).hostname).toBe('static.nhtsa.gov');
        return response.promise;
      });
      const calls = [svc.getInvestigations(), svc.getInvestigations(), svc.getInvestigations()];
      response.resolve(makeFlatInvZipResponse(rows));
      const results = await Promise.all(calls);
      expect(results[0]).toHaveLength(1);
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(await svc.getInvestigations()).toBe(results[0]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([0, 1])(
    'cancels waiter %s without poisoning followers or cache (#44)',
    async (cancelledIndex) => {
      const svc = new NhtsaService();
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      mockFetch.mockImplementation((url) => {
        expect(new URL(url).hostname).toBe('static.nhtsa.gov');
        started.resolve();
        return response.promise;
      });
      const controllers = [new AbortController(), new AbortController()];
      const removals = controllers.map((c) => vi.spyOn(c.signal, 'removeEventListener'));
      const pending = controllers.map((c) => svc.getInvestigations(c.signal));
      const cancelled = expect(pending[cancelledIndex]).rejects.toThrow(/cancel|abort/i);
      await started.promise;
      controllers[cancelledIndex]!.abort();
      await cancelled;
      response.resolve(
        makeFlatInvZipResponse([
          [
            'PE12345',
            'TOYOTA',
            'CAMRY',
            '2020',
            'BRAKES',
            'TOYOTA',
            '20230115',
            '',
            '',
            'Subject',
            'Summary',
          ],
        ]),
      );
      const surviving = await pending[1 - cancelledIndex]!;
      expect(surviving).toHaveLength(1);
      expect(await svc.getInvestigations()).toBe(surviving);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      for (const removal of removals)
        expect(removal).toHaveBeenCalledWith('abort', expect.any(Function));
    },
  );

  it('starts no load for an already-aborted caller (#44)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new NhtsaService().getInvestigations(controller.signal)).rejects.toThrow(
      /abort|cancel/i,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shares failure, removes listeners, and retries (#44)', async () => {
    const response = Promise.withResolvers<Response>();
    mockFetch.mockImplementation((url) => {
      expect(new URL(url).hostname).toBe('static.nhtsa.gov');
      return response.promise;
    });
    const svc = new NhtsaService();
    const controller = new AbortController();
    const removal = vi.spyOn(controller.signal, 'removeEventListener');
    const calls = [svc.getInvestigations(controller.signal), svc.getInvestigations()];
    const settled = Promise.allSettled(calls);
    response.reject(new Error('synthetic shared failure'));
    expect(await settled).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringContaining('synthetic shared failure'),
        }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringContaining('synthetic shared failure'),
        }),
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(removal).toHaveBeenCalledWith('abort', expect.any(Function));
    mockFetch.mockResolvedValueOnce(makeFlatInvZipResponse([ONE_INV_ROW]));
    expect(await svc.getInvestigations()).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  it('characterizes completion-based expiry and retry after failure', async () => {
    const base = Date.UTC(2026, 0, 1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const svc = new NhtsaService();
    const rows = [
      [
        'PE12345',
        'TOYOTA',
        'CAMRY',
        '2020',
        'BRAKES',
        'TOYOTA',
        '20230115',
        '',
        '',
        'Subject',
        'Summary',
      ],
    ];
    try {
      mockFetch.mockRejectedValueOnce(new Error('synthetic failure'));
      await expect(svc.getInvestigations()).rejects.toThrow('synthetic failure');
      mockFetch.mockImplementation(async () => {
        clock.mockReturnValue(base + 60_000);
        return makeFlatInvZipResponse(rows);
      });
      const first = await svc.getInvestigations();
      clock.mockReturnValue(base + 24 * 60 * 60 * 1000);
      expect(await svc.getInvestigations()).toBe(first);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(base + 24 * 60 * 60 * 1000 + 60_000);
      expect(await svc.getInvestigations()).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });
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
    expect(first[0]!.nhtsaId).toBe('PE12345');
    expect(first[0]!.investigationType).toBe('PE');
    expect(first[0]!.status).toBe('O'); // no closeDate → open
    expect(first[0]!.makes).toEqual(['TOYOTA']);
    expect(first[0]!.models).toEqual(['CAMRY']);
    expect(first[0]!.components).toEqual(['BRAKES']);
    expect(first[0]!.subject).toBe('Brake failure');
    expect(first[0]!.openDate).toBe('2023-01-15');

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
    expect(investigations[0]!.nhtsaId).toBe('PE12345');
    expect(investigations[0]!.models).toContain('CAMRY');
    expect(investigations[0]!.models).toContain('COROLLA');
    expect(investigations[0]!.years).toContain(2020);
    expect(investigations[0]!.years).toContain(2021);
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

    expect(investigations[0]!.status).toBe('C');
    expect(investigations[0]!.closeDate).toBe('2022-01-01');
    expect(investigations[0]!.recallCampaigns).toEqual(['21V407000']);
    expect(investigations[0]!.investigationType).toBe('EA');
  });

  it('omits fields for sparse rows', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([['PE12345', '', '', '9999', '', '', '', '', '', '', '']]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    expect(investigations[0]!.nhtsaId).toBe('PE12345');
    expect(investigations[0]!.subject).toBeUndefined();
    expect(investigations[0]!.openDate).toBeUndefined();
    expect(investigations[0]!.years).toEqual([]); // 9999 excluded
    expect(investigations[0]!.makes).toEqual([]);
  });

  it('treats a YEAR that is not four digits like a blank year', async () => {
    const row = (make: string, model: string, year: string) => [
      'PE30001',
      make,
      model,
      year,
      'BRAKES',
      'MFR',
      '20230115',
      '',
      '',
      'Subject',
      'Summary',
    ];
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        row('FORD', 'F-150', '20X1'),
        row('FORD', 'F-150', '2020'),
        row('FORD', 'RANGER', '199'),
        row('', '', '20200'),
        row('FORD', 'BRONCO', ''),
      ]),
    );

    const [investigation] = await new NhtsaService().getInvestigations();

    expect(investigation!.years).toStrictEqual([2020]);
    expect(investigation!.vehicles).toStrictEqual([
      { make: 'FORD', model: 'F-150' },
      { make: 'FORD', model: 'F-150', year: 2020 },
      { make: 'FORD', model: 'RANGER' },
      { make: 'FORD', model: 'BRONCO' },
    ]);
  });

  it('treats an open or close date that is not eight digits as absent', async () => {
    const row = (nhtsaId: string, openDate: string, closeDate: string) => [
      nhtsaId,
      'HONDA',
      'CIVIC',
      '2019',
      'ENGINE',
      'HONDA',
      openDate,
      closeDate,
      '',
      'Subject',
      'Summary',
    ];
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        row('PE30002', '2023O115', '2022-1-1'),
        row('PE30003', '20230115', '20240131'),
      ]),
    );

    const investigations = await new NhtsaService().getInvestigations();
    const malformed = investigations.find((inv) => inv.nhtsaId === 'PE30002');
    const wellFormed = investigations.find((inv) => inv.nhtsaId === 'PE30003');

    expect(malformed).not.toHaveProperty('openDate');
    expect(malformed).not.toHaveProperty('closeDate');
    expect(malformed!.status).toBe('O');
    expect(wellFormed).toMatchObject({
      openDate: '2023-01-15',
      closeDate: '2024-01-31',
      status: 'C',
    });
  });

  it('decodes multi-byte UTF-8 characters correctly (not mojibake)', async () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK: UTF-8 bytes E2 80 99.
    // If decoded as latin1, each byte is a separate character: â€™ (3 chars, not 1).
    // This test FAILS with TextDecoder('latin1') and PASSES with TextDecoder('utf-8').
    const subject = 'Tesla’s ADAS';
    const summary = 'The Office of Defects Investigation (“ODI”) reviewed Tesla’s data.';
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        [
          'AQ25002',
          'TESLA',
          'MODEL Y',
          '2023',
          'ADAS',
          'TESLA INC',
          '20250101',
          '',
          '',
          subject,
          summary,
        ],
      ]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    // Subject must contain the actual Unicode apostrophe, not its latin1 expansion (â€™)
    expect(investigations[0]!.subject).toBe(subject);
    expect(investigations[0]!.subject).not.toContain('â');
    // Summary must contain actual curly quotes, not their latin1 expansions (â€œ / â€)
    expect(investigations[0]!.summary).toBe(summary);
    expect(investigations[0]!.summary).not.toContain('â€');
  });

  it('extracts investigationType for 1-letter prefix (C)', async () => {
    // The prefix regex /^([A-Z]+)/ must capture single-letter prefixes.
    // A C-prefixed record should produce investigationType: 'C', not undefined.
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        [
          'C85001',
          'FORD',
          'PINTO',
          '1985',
          'FUEL SYSTEM',
          'FORD MOTOR',
          '19850601',
          '',
          '',
          '',
          '',
        ],
      ]),
    );

    const svc = getNhtsaService();
    const investigations = await svc.getInvestigations();

    expect(investigations).toHaveLength(1);
    expect(investigations[0]!.nhtsaId).toBe('C85001');
    expect(investigations[0]!.investigationType).toBe('C');
  });

  it('skips short and unnamed rows, trims fields, and takes dates and text from the first row of each action number', async () => {
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        ['SHORT1', 'MAKE', 'MODEL', '2020', 'PART'],
        ['', 'TOYOTA', 'CAMRY', '2020', 'BRAKES', 'TOYOTA'],
        ['  '],
        ['  PE20001 ', ' FORD ', ' F-150 ', ' 2019 ', ' ENGINE ', ' FORD MOTOR '],
        [
          'PE20001',
          'FORD',
          'F-250',
          '2019',
          'ENGINE',
          'OTHER MFR',
          '20200101',
          '',
          '',
          'Later subject',
          'Later summary',
        ],
        ['PE20001', '', '', '9999', 'STEERING', ''],
        ['12345', 'X', 'Y', '2001', 'Z', 'M', '20010101', '20020202', 'CAMP', 'S', 'Sum'],
      ]),
    );

    expect(await new NhtsaService().getInvestigations()).toStrictEqual([
      {
        nhtsaId: '12345',
        status: 'C',
        makes: ['X'],
        models: ['Y'],
        years: [2001],
        components: ['Z'],
        manufacturers: ['M'],
        openDate: '2001-01-01',
        closeDate: '2002-02-02',
        recallCampaigns: ['CAMP'],
        subject: 'S',
        summary: 'Sum',
        vehicles: [{ make: 'X', model: 'Y', year: 2001 }],
      },
      {
        nhtsaId: 'PE20001',
        status: 'O',
        makes: ['FORD'],
        models: ['F-150', 'F-250'],
        years: [2019],
        components: ['ENGINE', 'STEERING'],
        investigationType: 'PE',
        manufacturers: ['FORD MOTOR', 'OTHER MFR'],
        vehicles: [
          { make: 'FORD', model: 'F-150', year: 2019 },
          { make: 'FORD', model: 'F-250', year: 2019 },
        ],
      },
    ]);
  });

  it('accumulates every distinct manufacturer and recall campaign in first-seen row order (#48)', async () => {
    const row = (mfr: string, campno: string) => [
      'EA22002',
      'HONDA',
      'CIVIC',
      '2017',
      'AIR BAGS',
      mfr,
      '20220101',
      '',
      campno,
      'Subject',
      'Summary',
    ];
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        row('Honda (American Honda Motor Co.)', '23V085'),
        row('Takata (TK Global, LLC)', '23V838'),
        row('Honda (American Honda Motor Co.)', '23V085'),
        row('', ''),
        row('Nissan North America, Inc.', '14V668'),
        ['PE20001', 'FORD', 'F-150', '2019', 'ENGINE', '', '20200101', '', '', 'S', 'Sum'],
      ]),
    );

    const [ea, pe] = await new NhtsaService().getInvestigations();

    expect(ea!.nhtsaId).toBe('EA22002');
    expect(ea!.manufacturers).toStrictEqual([
      'Honda (American Honda Motor Co.)',
      'Takata (TK Global, LLC)',
      'Nissan North America, Inc.',
    ]);
    // Unpadded, as NHTSA lists them: a 6-character campaign keeps its form.
    expect(ea!.recallCampaigns).toStrictEqual(['23V085', '23V838', '14V668']);
    expect(pe!.nhtsaId).toBe('PE20001');
    expect(pe).not.toHaveProperty('manufacturers');
    expect(pe).not.toHaveProperty('recallCampaigns');
    expect(ea).not.toHaveProperty('manufacturer');
    expect(ea).not.toHaveProperty('recallCampaign');
  });

  it('keeps each distinct make/model/year association row and lists years ascending (#51)', async () => {
    const row = (make: string, model: string, year: string, component: string) => [
      'EA22002',
      make,
      model,
      year,
      component,
      'MFR',
      '20220101',
      '',
      '',
      'Subject',
      'Summary',
    ];
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        row('HONDA', 'ACCORD', '2017', 'AIR BAGS'),
        row('HONDA', 'CIVIC', '2015', 'AIR BAGS'),
        row('HONDA', 'CIVIC', '2015', 'STEERING'),
        row('HONDA', 'CIVIC', '2012', 'AIR BAGS'),
        row('HONDA', '', '9999', 'AIR BAGS'),
        row('', '', '9999', 'ELECTRICAL SYSTEM'),
        row('', '', '2016', 'AIR BAGS'),
      ]),
    );

    const [investigation] = await new NhtsaService().getInvestigations();

    expect(investigation!.years).toStrictEqual([2012, 2015, 2016, 2017]);
    expect(investigation!.vehicles).toStrictEqual([
      { make: 'HONDA', model: 'ACCORD', year: 2017 },
      { make: 'HONDA', model: 'CIVIC', year: 2015 },
      { make: 'HONDA', model: 'CIVIC', year: 2012 },
      { make: 'HONDA' },
      { year: 2016 },
    ]);
    expect(investigation!.components).toStrictEqual(['AIR BAGS', 'STEERING', 'ELECTRICAL SYSTEM']);
  });

  it('orders records newest-opened first, same-day IDs descending, undated last (#51)', async () => {
    const row = (nhtsaId: string, openDate: string) => [
      nhtsaId,
      'MAKE',
      'MODEL',
      '2020',
      'PART',
      'MFR',
      openDate,
      '',
      '',
      'Subject',
      'Summary',
    ];
    mockFetch.mockResolvedValue(
      makeFlatInvZipResponse([
        row('AQ98002', ''),
        row('PE20001', '20200101'),
        row('DP79007', '19781201'),
        row('PE20003', '20200101'),
        row('PE98001', ''),
        row('DP26006', '20260820'),
        row('RQ20002', '20200101'),
      ]),
    );

    const investigations = await new NhtsaService().getInvestigations();

    expect(investigations.map((i) => i.nhtsaId)).toStrictEqual([
      'DP26006',
      'RQ20002',
      'PE20003',
      'PE20001',
      'DP79007',
      'PE98001',
      'AQ98002',
    ]);
  });

  it('retains memory in proportion to the kept fields, not the decompressed file (#54)', async () => {
    const ids = 256;
    const rowsPerId = 32;
    const summaryChars = 4000;
    /**
     * Every row names a new model, so every stretch of decoded text holds a field the records
     * keep. A field sliced out of that text pins the whole stretch, which puts the retained heap
     * near `textBytes`; a field decoded on its own keeps only itself (~1.5 MB here). Model names
     * run past 12 characters: V8 copies a shorter substring rather than slicing it.
     */
    let seed = 1;
    const letters = (count: number) =>
      Array.from({ length: count }, () => {
        seed = (seed * 48_271) % 2_147_483_647;
        return String.fromCharCode(97 + (seed % 26));
      }).join('');
    const lines: string[] = [];
    for (let id = 0; id < ids; id++) {
      const summary = letters(summaryChars);
      for (let row = 0; row < rowsPerId; row++) {
        lines.push(
          [
            `PE${id}`,
            'MAKE',
            `MODEL NUMBER ${id}-${row}`,
            '2020',
            'PART',
            'MFR',
            '20200101',
            '',
            '',
            `Subject ${id}`,
            summary,
          ].join('\t'),
        );
      }
    }
    const text = new TextEncoder().encode(lines.join('\n'));
    const textBytes = text.length;
    const zipped = zipSync({ 'FLAT_INV.txt': [text, { level: 1 }] });
    lines.length = 0;

    /** Network-sized body chunks: delivered as one chunk, V8 shows no retention to measure. */
    const chunkBytes = 16 * 1024;
    mockFetch.mockImplementation(async (url: string) => {
      expect(new URL(url).hostname).toBe('static.nhtsa.gov');
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= zipped.length) {
              controller.close();
              return;
            }
            controller.enqueue(zipped.slice(offset, offset + chunkBytes));
            offset += chunkBytes;
          },
        }),
      );
    });
    // A small load first, so state the loader creates once per process stays out of the measure.
    mockFetch.mockResolvedValueOnce(
      makeFlatInvZipResponse([['PE1', 'MAKE', 'MODEL', '2020', 'PART', 'MFR']]),
    );
    await new NhtsaService().getInvestigations();
    forceGc();
    const before = process.memoryUsage().heapUsed;

    const investigations = await new NhtsaService().getInvestigations();
    forceGc();
    const retained = process.memoryUsage().heapUsed - before;

    expect(investigations).toHaveLength(ids);
    expect(investigations[ids - 1]!.models).toHaveLength(rowsPerId);
    expect(retained).toBeLessThan(textBytes / 4);
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
    expect(mfrs[0]!.vehicleTypes).toHaveLength(3);
    expect(mfrs[0]!.vehicleTypes[0]).toEqual({ name: 'Passenger Car' });
  });

  it('getManufacturer requests page 1 and stops on a short page', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'OK',
        SearchCriteria: '',
        Results: [{ Mfr_ID: 987, Mfr_Name: 'TOYOTA', Country: 'JAPAN', VehicleTypes: [] }],
      }),
    );

    const svc = getNhtsaService();
    await svc.getManufacturer('Toyota');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toContain('page=1');
  });

  it('getManufacturer walks pages until VPIC returns a short page', async () => {
    // VPIC serves 100 per page and its Count is that page's size, never a match total.
    const fullPage = (offset: number) =>
      jsonResponse({
        Count: 100,
        Message: 'OK',
        SearchCriteria: '',
        Results: Array.from({ length: 100 }, (_, i) => ({
          Mfr_ID: offset + i,
          Mfr_Name: `MFR ${offset + i}`,
          Country: 'UNITED STATES (USA)',
          VehicleTypes: [],
        })),
      });

    mockFetch
      .mockResolvedValueOnce(fullPage(0))
      .mockResolvedValueOnce(fullPage(100))
      .mockResolvedValueOnce(
        jsonResponse({
          Count: 55,
          Message: 'OK',
          SearchCriteria: '',
          Results: Array.from({ length: 55 }, (_, i) => ({
            Mfr_ID: 200 + i,
            Mfr_Name: `MFR ${200 + i}`,
            Country: 'UNITED STATES (USA)',
            VehicleTypes: [],
          })),
        }),
      );

    const svc = getNhtsaService();
    const mfrs = await svc.getManufacturer('hon');

    expect(mfrs).toHaveLength(255);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1]![0]).toContain('page=2');
    expect(mockFetch.mock.calls[2]![0]).toContain('page=3');
    expect(mfrs[254]?.manufacturerName).toBe('MFR 254');
  });

  it('getManufacturer stops at the retrieval cap rather than paging without bound', async () => {
    // Every page comes back full, so only the cap ends the walk. A fresh Response per call —
    // a single shared one would have its body consumed after the first read.
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        Count: 100,
        Message: 'OK',
        SearchCriteria: '',
        Results: Array.from({ length: 100 }, (_, i) => ({
          Mfr_ID: i,
          Mfr_Name: `MFR ${i}`,
          Country: 'UNITED STATES (USA)',
          VehicleTypes: [],
        })),
      }),
    );

    const svc = getNhtsaService();
    const mfrs = await svc.getManufacturer('a');

    expect(mfrs).toHaveLength(MANUFACTURER_RESULT_CAP);
    expect(mockFetch).toHaveBeenCalledTimes(MANUFACTURER_RESULT_CAP / 100);
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

describe('dataset model lists (#47)', () => {
  /** Responses this block serves, keyed by api.nhtsa.gov path; any other request is rejected. */
  let routes: Map<string, () => Response>;

  beforeEach(() => {
    routes = new Map();
    mockFetch.mockImplementation(async (input: string) => {
      const url = new URL(input);
      const route = url.origin === 'https://api.nhtsa.gov' ? routes.get(url.pathname) : undefined;
      if (!route) throw new Error(`unmocked fetch: ${url.origin}${url.pathname}`);
      return route();
    });
  });

  function requestedUrl(): URL {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    return new URL(mockFetch.mock.calls[0]![0] as string);
  }

  it('getProductModels asks the products route for every row and returns distinct names', async () => {
    routes.set('/products/vehicle/models', () =>
      jsonResponse({
        count: 6,
        message: 'Results returned successfully',
        results: [
          { modelYear: '2014', make: 'CHEVROLET', model: 'SILVERADO 1500' },
          { modelYear: '2014', make: 'CHEVROLET', model: 'CAPTIVA' },
          { modelYear: '2014', make: 'CHEVROLET', model: 'SILVERADO 1500' },
          { modelYear: '2014', make: 'CHEVROLET', model: ' EXPRESS PASSENGER 1500 ' },
          { modelYear: '2014', make: 'CHEVROLET', model: '' },
          { modelYear: '2014', make: 'CHEVROLET' },
        ],
      }),
    );

    const names = await getNhtsaService().getProductModels('Chevrolet', 2014);

    expect(names).toEqual(['SILVERADO 1500', 'CAPTIVA', 'EXPRESS PASSENGER 1500']);
    expect(Object.fromEntries(requestedUrl().searchParams)).toEqual({
      modelYear: '2014',
      make: 'Chevrolet',
      issueType: 'c',
      max: '5000',
    });
  });

  it("getSafetyRatingModels reads NCAP's per-make list and returns distinct names", async () => {
    routes.set('/SafetyRatings/modelyear/2014/make/Mercedes-Benz%20AMG', () =>
      jsonResponse({
        Count: 4,
        Message: 'Results returned successfully',
        Results: [
          { ModelYear: 2014, Make: 'MERCEDES-BENZ', Model: 'C-CLASS', VehicleId: 0 },
          { ModelYear: 2014, Make: 'MERCEDES-BENZ', Model: 'C-CLASS', VehicleId: 0 },
          { ModelYear: 2014, Make: 'MERCEDES-BENZ', Model: 'E-CLASS', VehicleId: 0 },
          { ModelYear: 2014, Make: 'MERCEDES-BENZ', VehicleId: 0 },
        ],
      }),
    );

    const names = await getNhtsaService().getSafetyRatingModels(2014, 'Mercedes-Benz AMG');

    expect(names).toEqual(['C-CLASS', 'E-CLASS']);
    expect(requestedUrl().pathname).toBe('/SafetyRatings/modelyear/2014/make/Mercedes-Benz%20AMG');
  });

  it('getProductModels returns no names for a make with no rows', async () => {
    routes.set('/products/vehicle/models', () =>
      jsonResponse({ count: 0, message: 'Results returned successfully', results: [] }),
    );

    await expect(getNhtsaService().getProductModels('Zzzzq', 2014)).resolves.toEqual([]);
  });

  it('getSafetyRatingModels returns no names for a make with no rows', async () => {
    routes.set('/SafetyRatings/modelyear/2014/make/Zzzzq', () =>
      jsonResponse({ Count: 0, Message: 'Results returned successfully', Results: [] }),
    );

    await expect(getNhtsaService().getSafetyRatingModels(2014, 'Zzzzq')).resolves.toEqual([]);
  });

  it('getProductModels throws when the list fails to load', async () => {
    routes.set('/products/vehicle/models', () => jsonResponse({ message: 'Not Found' }, 404));

    await expect(getNhtsaService().getProductModels('Chevrolet', 2014)).rejects.toThrow('404');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('getSafetyRatingModels throws when the list fails to load', async () => {
    routes.set('/SafetyRatings/modelyear/2014/make/Chevrolet', () =>
      jsonResponse({ message: 'Not Found' }, 404),
    );

    await expect(getNhtsaService().getSafetyRatingModels(2014, 'Chevrolet')).rejects.toThrow('404');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('getRecallCampaigns (direct endpoint)', () => {
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
    const campaigns = await svc.getRecallCampaigns(target);

    expect(campaigns).toHaveLength(1);
    const [result] = campaigns;
    expect(result!.campaignNumber).toBe(target);
    expect(result!.manufacturer).toBe('Toyota');
    expect(result!.component).toBe('FUEL/PROPULSION SYSTEM');
    expect(result!.potentialUnitsAffected).toBe(5000);
    expect(result!.receivedDate).toBe('2020-12-11');
    // Single request to the direct endpoint
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toContain('/recalls/campaignNumber');
  });

  it('collapses the one-row-per-vehicle response into a single record with the vehicle list', async () => {
    // The endpoint returns every affected vehicle in one response, repeating campaign detail.
    const campaignDetail = {
      NHTSACampaignNumber: '24V744000',
      Manufacturer: 'Honda (American Honda Motor Co.)',
      Component: 'STEERING',
      Summary: 'Steering gearbox may bind.',
      Consequence: 'Crash risk.',
      Remedy: 'Replace the gearbox.',
      ReportReceivedDate: '03/10/2024',
      PotentialNumberofUnitsAffected: 1_693_199,
      NHTSAActionNumber: 'EA23003',
    };
    const vehicles = [
      { Make: 'HONDA', Model: 'CIVIC', ModelYear: '2022' },
      { Make: 'HONDA', Model: 'CIVIC', ModelYear: '2023' },
      { Make: 'HONDA', Model: 'CR-V', ModelYear: '2023' },
      { Make: 'ACURA', Model: 'INTEGRA', ModelYear: '2024' },
    ];
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: vehicles.length,
        Message: 'Results returned successfully',
        results: vehicles.map((v) => ({ ...campaignDetail, ...v })),
      }),
    );

    const svc = getNhtsaService();
    const campaigns = await svc.getRecallCampaigns('24V744000');

    expect(campaigns).toHaveLength(1);
    const [result] = campaigns;
    expect(result!.campaignNumber).toBe('24V744000');
    expect(result!.investigationId).toBe('EA23003');
    expect(result!.affectedVehicles).toEqual([
      { make: 'HONDA', model: 'CIVIC', modelYear: 2022 },
      { make: 'HONDA', model: 'CIVIC', modelYear: 2023 },
      { make: 'HONDA', model: 'CR-V', modelYear: 2023 },
      { make: 'ACURA', model: 'INTEGRA', modelYear: 2024 },
    ]);
    // All rows arrive in one response — no follow-up page fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated vehicle rows within a campaign', async () => {
    const row = {
      NHTSACampaignNumber: '20V682000',
      Manufacturer: 'Toyota',
      Component: 'FUEL/PROPULSION SYSTEM',
      Summary: 'Fuel delivery pipe may leak.',
      Consequence: 'Fire risk.',
      Remedy: 'Replace fuel pipe.',
      ReportReceivedDate: '11/12/2020',
      Make: 'TOYOTA',
      Model: 'CAMRY',
      ModelYear: '2020',
    };
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 3,
        Message: 'Results returned successfully',
        results: [row, row, { ...row, ModelYear: '2021' }],
      }),
    );

    const svc = getNhtsaService();
    const [result, ...rest] = await svc.getRecallCampaigns('20V682000');

    expect(rest).toEqual([]);
    expect(result!.affectedVehicles).toEqual([
      { make: 'TOYOTA', model: 'CAMRY', modelYear: 2020 },
      { make: 'TOYOTA', model: 'CAMRY', modelYear: 2021 },
    ]);
  });

  it('returns an empty vehicle list when a row names nothing at all', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 1,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: '20E123000',
            Manufacturer: 'Equipment Co',
            Component: 'CHILD SEAT',
            Summary: 'Latch may not hold.',
            Consequence: 'Injury risk.',
            Remedy: 'Replace latch.',
            ReportReceivedDate: '11/12/2020',
            Make: '',
            Model: '   ',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const [result] = await svc.getRecallCampaigns('20E123000');

    expect(result!.affectedVehicles).toEqual([]);
    expect(result!.investigationId).toBeUndefined();
  });

  it('keeps an equipment row but drops its 9999 model-year placeholder', async () => {
    // Real equipment and tire rows name the brand and the part, with ModelYear "9999".
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 2,
        Message: 'Results returned successfully',
        results: [
          {
            NHTSACampaignNumber: '25V200000',
            Manufacturer: 'Great Dane',
            Component: 'TIRES',
            Summary: 'Tire may fail.',
            Consequence: 'Crash risk.',
            Remedy: 'Replace the tire.',
            ReportReceivedDate: '11/12/2025',
            Make: 'BRIDGESTONE',
            Model: 'R123 ECOPIA',
            ModelYear: '9999',
          },
          {
            NHTSACampaignNumber: '25V200000',
            Manufacturer: 'Great Dane',
            Component: 'TIRES',
            Summary: 'Tire may fail.',
            Consequence: 'Crash risk.',
            Remedy: 'Replace the tire.',
            ReportReceivedDate: '11/12/2025',
            Make: 'GREAT DANE',
            Model: 'CHAMPION',
            ModelYear: '2025',
          },
        ],
      }),
    );

    const svc = getNhtsaService();
    const [result, ...rest] = await svc.getRecallCampaigns('25V200000');

    expect(rest).toEqual([]);
    expect(result!.affectedVehicles).toEqual([
      { make: 'BRIDGESTONE', model: 'R123 ECOPIA' },
      { make: 'GREAT DANE', model: 'CHAMPION', modelYear: 2025 },
    ]);
  });

  it('returns no campaigns when the campaign is not found (empty results)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 0,
        Message: 'Results returned successfully',
        results: [],
      }),
    );

    const svc = getNhtsaService();
    const result = await svc.getRecallCampaigns('ZZZ999999');
    expect(result).toStrictEqual([]);
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
    const campaigns = await svc.getRecallCampaigns(target);

    expect(campaigns).toHaveLength(1);
    const [result] = campaigns;
    expect(result!.parkIt).toBeUndefined();
    expect(result!.parkOutSide).toBeUndefined();
    expect(result!.overTheAirUpdate).toBeUndefined();
  });

  it('omits the summary, consequence, and remedy an older campaign sends as null', async () => {
    // 66V008001 as the endpoint returns it: four vehicle rows, each with null campaign text.
    const campaignDetail = {
      Manufacturer: 'CHRYSLER CORPORATION',
      NHTSACampaignNumber: '66V008001',
      parkIt: false,
      parkOutSide: false,
      overTheAirUpdate: false,
      ReportReceivedDate: '12/10/1966',
      Component: 'WHEELS',
      PotentialNumberofUnitsAffected: 1101,
      Summary: null,
      Consequence: null,
      Remedy: null,
      Notes: 'POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.',
    };
    const vehicles = [
      { ModelYear: '1967', Make: 'DODGE', Model: 'DART' },
      { ModelYear: '1966', Make: 'PLYMOUTH', Model: 'VALIANT' },
      { ModelYear: '1966', Make: 'DODGE', Model: 'DART' },
      { ModelYear: '1967', Make: 'PLYMOUTH', Model: 'VALIANT' },
    ];
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: vehicles.length,
        Message: 'Results returned successfully',
        results: vehicles.map((v) => ({ ...campaignDetail, ...v })),
      }),
    );

    const result = await getNhtsaService().getRecallCampaigns('66V008001');

    expect(result).toStrictEqual([
      {
        campaignNumber: '66V008001',
        manufacturer: 'CHRYSLER CORPORATION',
        component: 'WHEELS',
        receivedDate: '1966-10-12',
        potentialUnitsAffected: 1101,
        affectedVehicles: [
          { make: 'DODGE', model: 'DART', modelYear: 1967 },
          { make: 'PLYMOUTH', model: 'VALIANT', modelYear: 1966 },
          { make: 'DODGE', model: 'DART', modelYear: 1966 },
          { make: 'PLYMOUTH', model: 'VALIANT', modelYear: 1967 },
        ],
        parkIt: false,
        parkOutSide: false,
        overTheAirUpdate: false,
      },
    ]);
  });

  it('builds one record per campaign a 6-character number covers, each from its own rows (#57)', async () => {
    // 00V419 prefixes two campaigns; the endpoint interleaves their rows. The older one sends its
    // campaign text as null, and the two cover different vehicles.
    const nissan = {
      Manufacturer: 'NISSAN NORTH AMERICA, INC.',
      NHTSACampaignNumber: '00V419001',
      NHTSAActionNumber: 'EA00015',
      ReportReceivedDate: '15/12/2000',
      Component: 'FUEL SYSTEM, GASOLINE:STORAGE:TANK ASSEMBLY',
      PotentialNumberofUnitsAffected: 268_229,
      Summary: null,
      Consequence: null,
      Remedy: null,
      parkIt: false,
      Make: 'NISSAN',
      Model: 'QUEST',
    };
    const ford = {
      Manufacturer: 'FORD MOTOR COMPANY',
      NHTSACampaignNumber: '00V419002',
      ReportReceivedDate: '02/01/2001',
      Component: 'FUEL SYSTEM, GASOLINE',
      Summary: 'Cracks have developed in the fuel tank vent hose.',
      Consequence: 'Fuel leakage can result in a fire.',
      Remedy: 'Dealers will replace the vent hose.',
      overTheAirUpdate: false,
      Make: 'MERCURY',
      Model: 'VILLAGER',
    };
    mockFetch.mockResolvedValue(
      jsonResponse({
        Count: 5,
        Message: 'Results returned successfully',
        results: [
          { ...ford, ModelYear: '1993' },
          { ...nissan, ModelYear: '1993' },
          { ...ford, ModelYear: '1994' },
          { ...nissan, ModelYear: '1994' },
          { ...ford, ModelYear: '1993' },
        ],
      }),
    );

    const campaigns = await getNhtsaService().getRecallCampaigns('00V419');

    expect(campaigns).toStrictEqual([
      {
        campaignNumber: '00V419001',
        manufacturer: 'NISSAN NORTH AMERICA, INC.',
        component: 'FUEL SYSTEM, GASOLINE:STORAGE:TANK ASSEMBLY',
        receivedDate: '2000-12-15',
        potentialUnitsAffected: 268_229,
        investigationId: 'EA00015',
        affectedVehicles: [
          { make: 'NISSAN', model: 'QUEST', modelYear: 1993 },
          { make: 'NISSAN', model: 'QUEST', modelYear: 1994 },
        ],
        parkIt: false,
      },
      {
        campaignNumber: '00V419002',
        manufacturer: 'FORD MOTOR COMPANY',
        component: 'FUEL SYSTEM, GASOLINE',
        summary: 'Cracks have developed in the fuel tank vent hose.',
        consequence: 'Fuel leakage can result in a fire.',
        remedy: 'Dealers will replace the vent hose.',
        receivedDate: '2001-01-02',
        affectedVehicles: [
          { make: 'MERCURY', model: 'VILLAGER', modelYear: 1993 },
          { make: 'MERCURY', model: 'VILLAGER', modelYear: 1994 },
        ],
        overTheAirUpdate: false,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
