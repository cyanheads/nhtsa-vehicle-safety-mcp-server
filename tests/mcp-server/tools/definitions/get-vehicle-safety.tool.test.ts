/**
 * @fileoverview Tests for nhtsa_get_vehicle_safety tool.
 * @module tests/mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { zipSync } from 'fflate';
import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Investigation } from '@/services/nhtsa/types.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = {
  getSafetyRatingVariants: vi.fn(),
  getSafetyRating: vi.fn(),
  getRecallsByVehicle: vi.fn(),
  getComplaintsByVehicle: vi.fn(),
  getInvestigationsWithin: vi.fn(),
  getInvestigations: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
  mockService.getInvestigationsWithin.mockResolvedValue({ kind: 'ready', value: [] });
});

const MODEL_NAME_ROUTE =
  'NHTSA\'s datasets can file one vehicle under different model names. List them with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search the empty sections under the names it tags for each: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings.';

/** `MODEL_NAME_ROUTE` when investigations are among the empty sections: no tag lists their names. */
const ROUTE_WITH_INVESTIGATIONS_CLAUSE =
  'NHTSA\'s datasets can file one vehicle under different model names. List them with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search the empty sections under the names it tags for each: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings. For investigations, any of the listed names works: nhtsa_search_investigations matches part of a model name.';

const ALL_EMPTY_NOTICE =
  'No NCAP ratings, recalls, complaints, or investigations matched this vehicle. It may have a clean record, or NHTSA may list its records under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search each dataset under the names it tags for it: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings. For investigations, any of the listed names works: nhtsa_search_investigations matches part of a model name.';

const ALL_AVAILABLE = {
  safetyRatings: 'available',
  recalls: 'available',
  complaints: 'available',
  investigations: 'available',
};

/** An investigation as the service hands it over; every field the tool reads, plus a summary. */
function investigation(
  nhtsaId: string,
  vehicles: Investigation['vehicles'],
  extra: Partial<Investigation> = {},
): Investigation {
  return {
    nhtsaId,
    investigationType: nhtsaId.slice(0, 2),
    status: 'C',
    subject: `${nhtsaId} subject`,
    summary: `${nhtsaId} summary`,
    makes: [...new Set(vehicles.map((v) => v.make ?? ''))],
    models: [...new Set(vehicles.map((v) => v.model ?? ''))],
    vehicles,
    ...extra,
  };
}

const ODYSSEY_2018 = { make: 'HONDA', model: 'ODYSSEY', year: 2018 };

/**
 * The 2018 Honda Odyssey's investigations as of FLAT_INV.zip of 2026-11-15 (PE25018, PE25008,
 * EA25004, RQ24013), newest-opened first as the service orders them, interleaved with records
 * that must not match: another model, another make, and #51's cross-row case (ODYSSEY on a 2017
 * row, 2018 only on a PILOT row).
 */
const ODYSSEY_INVESTIGATIONS = [
  investigation('PE25018', [ODYSSEY_2018], {
    subject: 'Sliding door may open while driving',
    openDate: '2025-10-01',
    closeDate: '2025-11-01',
    recallCampaigns: ['25V700'],
  }),
  investigation('PE25009', [{ make: 'HONDA', model: 'PILOT', year: 2018 }], {
    status: 'O',
    openDate: '2025-06-01',
  }),
  investigation('PE25008', [ODYSSEY_2018, { make: 'HONDA', model: 'PILOT', year: 2019 }], {
    status: 'O',
    subject: 'Engine failure',
    openDate: '2025-05-01',
  }),
  investigation('EA25004', [ODYSSEY_2018], {
    status: 'O',
    subject: 'No restart after auto start/stop',
    openDate: '2025-04-01',
  }),
  investigation('DP24010', [
    { make: 'HONDA', model: 'ODYSSEY', year: 2017 },
    { make: 'HONDA', model: 'PILOT', year: 2018 },
  ]),
  investigation('RQ24013', [ODYSSEY_2018], {
    subject: 'Rear seat recall remedy',
    openDate: '2024-09-01',
    closeDate: '2025-01-15',
    recallCampaigns: ['23V412', '24V001'],
  }),
  investigation('PE23001', [{ make: 'TOYOTA', model: 'ODYSSEY', year: 2018 }]),
];

const ODYSSEY_ROWS = [
  {
    nhtsaId: 'PE25018',
    investigationType: 'PE',
    investigationTypeName: 'Preliminary Evaluation',
    status: 'C',
    statusName: 'Closed',
    subject: 'Sliding door may open while driving',
    openDate: '2025-10-01',
    closeDate: '2025-11-01',
    recallCampaigns: ['25V700'],
    matchedModels: ['ODYSSEY'],
  },
  {
    nhtsaId: 'PE25008',
    investigationType: 'PE',
    investigationTypeName: 'Preliminary Evaluation',
    status: 'O',
    statusName: 'Open',
    subject: 'Engine failure',
    openDate: '2025-05-01',
    matchedModels: ['ODYSSEY'],
  },
  {
    nhtsaId: 'EA25004',
    investigationType: 'EA',
    investigationTypeName: 'Engineering Analysis',
    status: 'O',
    statusName: 'Open',
    subject: 'No restart after auto start/stop',
    openDate: '2025-04-01',
    matchedModels: ['ODYSSEY'],
  },
  {
    nhtsaId: 'RQ24013',
    investigationType: 'RQ',
    investigationTypeName: 'Recall Query',
    status: 'C',
    statusName: 'Closed',
    subject: 'Rear seat recall remedy',
    openDate: '2024-09-01',
    closeDate: '2025-01-15',
    recallCampaigns: ['23V412', '24V001'],
    matchedModels: ['ODYSSEY'],
  },
];

describe('getVehicleSafety', () => {
  it('assembles composite safety profile', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720, vehicleDescription: '2020 Toyota CAMRY FWD' },
    ]);
    mockService.getSafetyRating.mockResolvedValue({
      vehicleId: 14720,
      vehicleDescription: '2020 Toyota CAMRY FWD',
      overallRating: '5',
      frontalCrash: { overall: '5', driverSide: '5', passengerSide: '5' },
      sideCrash: {
        overall: '5',
        driverSide: '5',
        passengerSide: '5',
        combinedBarrierPoleFront: '5',
        combinedBarrierPoleRear: '4',
        barrierOverall: '5',
        pole: '5',
      },
      rollover: { rating: '4', probability: 0.099, dynamicTipResult: 'No Tip' },
      adasFeatures: {
        electronicStabilityControl: 'Standard',
        forwardCollisionWarning: 'Standard',
        laneDepartureWarning: 'Standard',
      },
      complaintsCount: 100,
      recallsCount: 3,
      investigationCount: 0,
    });
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: '20V682000',
        manufacturer: 'Toyota',
        component: 'FUEL SYSTEM',
        summary: 'Fuel leak.',
        consequence: 'Fire risk.',
        remedy: 'Replace pipe.',
        reportReceivedDate: '2020-12-11',
        parkIt: true,
        parkOutSide: false,
        overTheAirUpdate: false,
      },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([
      {
        odiNumber: 1,
        manufacturer: 'Toyota',
        crash: true,
        fire: false,
        numberOfInjuries: 1,
        numberOfDeaths: 0,
        dateOfIncident: '2021-01-01',
        dateComplaintFiled: '2021-02-01',
        vin: 'ABC',
        components: 'ENGINE,BRAKES',
        summary: 'Stalled.',
      },
    ]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);

    expect(result.safetyRatings).toHaveLength(1);
    expect(result.safetyRatings![0]!.overallRating).toBe('5');
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls![0]).toMatchObject({
      campaignNumber: '20V682000',
      manufacturer: 'Toyota',
      consequence: 'Fire risk.',
      parkIt: true,
      parkOutSide: false,
      overTheAirUpdate: false,
    });
    expect(result.complaintSummary!.totalCount).toBe(1);
    expect(result.complaintSummary!.crashCount).toBe(1);
    expect(result.complaintSummary!.componentBreakdown).toHaveLength(2);
    expect(result.sectionStatus).toEqual(ALL_AVAILABLE);
  });

  it('reports NCAP as available with no rows when the query matched no variants', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Fake', model: 'Car', modelYear: 1990 });
    const result = await getVehicleSafety.handler(input, ctx);
    const text = firstText(getVehicleSafety.format!(getVehicleSafety.output.parse(result)));

    /** Every section states its emptiness, so no consumer has to read absence into a missing key. */
    expect(result.safetyRatings).toEqual([]);
    expect(result.recalls).toEqual([]);
    expect(result.complaintSummary?.totalCount).toBe(0);
    expect(result.investigations).toEqual([]);
    expect(result.sectionStatus).toEqual(ALL_AVAILABLE);
    expect(result.warnings).toEqual([]);
    expect(text).toContain('No NCAP crash test ratings found');
    expect(text).not.toContain('NCAP safety ratings were unavailable');
  });

  it('emits a lookup notice when every section loaded and matched nothing', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({
      make: 'Zorblax',
      model: 'Nonesuch',
      modelYear: 2020,
    });
    await getVehicleSafety.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('Zorblax Nonesuch 2020');
    expect(enrichment.notice).toBe(ALL_EMPTY_NOTICE);
  });

  it('names the empty sections when recalls returned data and the rest did not (#47)', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: '20V682000',
        manufacturer: 'Toyota',
        component: 'FUEL SYSTEM',
        summary: 'Fuel leak.',
        consequence: 'Fire risk.',
        remedy: 'Replace pipe.',
        reportReceivedDate: '2020-12-11',
      },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      `No NCAP ratings, complaints, or investigations matched, though recalls did. ${ROUTE_WITH_INVESTIGATIONS_CLAUSE}`,
    );
    /** The empty NCAP array states the absence of crash test coverage to structured-only consumers. */
    expect(result.safetyRatings).toEqual([]);
    expect(result.sectionStatus.safetyRatings).toBe('available');
    expect(result.warnings).toEqual([]);
  });

  it('omits the lookup notice when a section failed to load', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockRejectedValue(new Error('recalls unavailable'));
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    await getVehicleSafety.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('accepts recalls without parkIt', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: '20V682000',
        manufacturer: 'Toyota',
        component: 'FUEL SYSTEM',
        summary: 'Fuel leak.',
        consequence: 'Fire risk.',
        remedy: 'Replace pipe.',
        reportReceivedDate: '2020-12-11',
      },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.recalls).toHaveLength(1);
    expect(parsed.recalls![0]!.parkIt).toBeUndefined();
    expect(parsed.recalls![0]!.parkOutSide).toBeUndefined();
    expect(parsed.recalls![0]!.overTheAirUpdate).toBeUndefined();
    expect(parsed.sectionStatus.recalls).toBe('available');
    expect(text).toContain('*Advisories:* None reported by NHTSA');
  });

  it('renders park-outside and OTA advisories alongside the do-not-drive alert', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: '24V407000',
        manufacturer: 'Kia America, Inc.',
        component: 'SEATS:FRONT ASSEMBLY:POWER ADJUST',
        summary: 'Front power seat motor may overheat.',
        consequence: 'An overheating motor increases the risk of a fire.',
        remedy: 'Dealers will replace the seat motor.',
        reportReceivedDate: '2024-06-05',
        parkIt: false,
        parkOutSide: true,
        overTheAirUpdate: false,
      },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({
      make: 'Kia',
      model: 'Telluride',
      modelYear: 2023,
    });
    const parsed = getVehicleSafety.output.parse(await getVehicleSafety.handler(input, ctx));
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.recalls![0]).toMatchObject({
      manufacturer: 'Kia America, Inc.',
      consequence: 'An overheating motor increases the risk of a fire.',
      parkIt: false,
      parkOutSide: true,
      overTheAirUpdate: false,
    });
    expect(text).toContain('**PARK OUTSIDE**');
    expect(text).toContain('*Manufacturer:* Kia America, Inc.');
    expect(text).toContain('*Consequence:* An overheating motor increases the risk of a fire.');
    /** A false advisory is stated explicitly rather than rendering as absent. */
    expect(text).toContain('Do not drive: no');
    expect(text).toContain('Park outside: yes');
    expect(text).toContain('Over-the-air update: no');
  });

  it('accepts sparse safety rating fields without inventing values', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 14720 }]);
    mockService.getSafetyRating.mockResolvedValue({
      vehicleId: 14720,
      vehicleDescription: undefined,
      overallRating: undefined,
      frontalCrash: { overall: undefined, driverSide: undefined, passengerSide: undefined },
      sideCrash: {
        overall: undefined,
        driverSide: undefined,
        passengerSide: undefined,
        combinedBarrierPoleFront: undefined,
        combinedBarrierPoleRear: undefined,
        barrierOverall: undefined,
        pole: undefined,
      },
      rollover: { rating: undefined, probability: undefined, dynamicTipResult: undefined },
      adasFeatures: {
        electronicStabilityControl: undefined,
        forwardCollisionWarning: undefined,
        laneDepartureWarning: undefined,
      },
      complaintsCount: undefined,
      recallsCount: undefined,
      investigationCount: undefined,
    });
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.safetyRatings).toHaveLength(1);
    expect(parsed.safetyRatings![0]!.overallRating).toBeUndefined();
    expect(parsed.safetyRatings![0]!.rollover.probability).toBeUndefined();
    expect(text).toContain('Vehicle 14720');
    expect(text).toContain('Not available');
    expect(parsed.sectionStatus.safetyRatings).toBe('available');
  });

  it('marks unavailable sections instead of implying no data was found', async () => {
    mockService.getSafetyRatingVariants.mockRejectedValue(new Error('ratings unavailable'));
    mockService.getRecallsByVehicle.mockRejectedValue(new Error('recalls unavailable'));
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.safetyRatings).toBeUndefined();
    expect(parsed.recalls).toBeUndefined();
    expect(parsed.complaintSummary?.totalCount).toBe(0);
    expect(parsed.sectionStatus).toEqual({
      safetyRatings: 'unavailable',
      recalls: 'unavailable',
      complaints: 'available',
      investigations: 'available',
    });
    expect(text).toContain('NCAP safety ratings were unavailable');
    expect(text).toContain('Recall data was unavailable');
    expect(text).not.toContain('No recalls found.');
  });

  it('format renders all sections', () => {
    const output = {
      safetyRatings: [
        {
          vehicleId: 1,
          vehicleDescription: '2020 Camry',
          overallRating: '5',
          frontalCrash: { overall: '5', driverSide: '5', passengerSide: '5' },
          sideCrash: {
            overall: '5',
            driverSide: '5',
            passengerSide: '5',
            barrierOverall: '5',
            pole: '5',
          },
          rollover: { rating: '4', probability: 0.1, dynamicTipResult: 'No Tip' },
          adasFeatures: {
            electronicStabilityControl: 'Standard',
            forwardCollisionWarning: 'Standard',
            laneDepartureWarning: 'Standard',
          },
        },
      ],
      recalls: [
        {
          campaignNumber: '20V682000',
          manufacturer: 'Toyota',
          component: 'FUEL',
          summary: 'Leak.',
          consequence: 'Fire risk.',
          remedy: 'Fix.',
          reportReceivedDate: '2020-11-12',
          parkIt: true,
        },
      ],
      complaintSummary: {
        totalCount: 5,
        crashCount: 1,
        fireCount: 0,
        injuryCount: 1,
        deathCount: 0,
        componentBreakdown: [
          {
            component: 'ENGINE',
            count: 3,
            crashCount: 1,
            fireCount: 0,
            injuryCount: 1,
            deathCount: 0,
          },
        ],
      },
      investigations: [ODYSSEY_ROWS[1]],
      sectionStatus: ALL_AVAILABLE,
      warnings: [],
    };
    const blocks = getVehicleSafety.format!(getVehicleSafety.output.parse(output));
    expect(blocks).toHaveLength(1);
    const text = firstText(blocks);
    expect(text).toContain('NCAP Safety Ratings');
    expect(text).toContain('DO NOT DRIVE');
    expect(text).toContain('*Consequence:* Fire risk.');
    expect(text).toContain('Complaints (5)');
    expect(text).toContain('ENGINE');
    /** Investigations render last, after the complaint breakdown. */
    const headings = text.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toStrictEqual([
      '## NCAP Safety Ratings',
      '## Recalls (1)',
      '## Complaints (5)',
      '## Investigations (1)',
    ]);
  });

  it('renders every component breakdown row rather than truncating the list', async () => {
    const components = Array.from({ length: 27 }, (_, i) => `COMPONENT_${i}`);
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue(
      components.map((component, i) => ({
        odiNumber: i,
        components: component,
        crash: false,
        fire: false,
        numberOfInjuries: 0,
        numberOfDeaths: 0,
      })),
    );

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2007 });
    const parsed = getVehicleSafety.output.parse(await getVehicleSafety.handler(input, ctx));
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.complaintSummary!.componentBreakdown).toHaveLength(27);
    const renderedRows = text.split('\n').filter((line) => line.startsWith('- COMPONENT_'));
    expect(renderedRows).toHaveLength(27);
    for (const component of components) {
      expect(renderedRows.some((row) => row.startsWith(`- ${component}:`))).toBe(true);
    }
  });

  it('rejects a fractional modelYear rather than sending it upstream', () => {
    expect(() =>
      getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020.5 }),
    ).toThrow();
    expect(
      getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 }).modelYear,
    ).toBe(2020);
  });
});

describe('getVehicleSafety — defect investigations covering the vehicle (#64)', () => {
  function seedOdyssey() {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);
    mockService.getInvestigationsWithin.mockResolvedValue({
      kind: 'ready',
      value: ODYSSEY_INVESTIGATIONS,
    });
    mockService.getInvestigations.mockResolvedValue(ODYSSEY_INVESTIGATIONS);
  }
  const ODYSSEY = { make: 'Honda', model: 'Odyssey', modelYear: 2018 };

  it('lists every matching investigation newest-opened first, without summaries', async () => {
    seedOdyssey();

    const result = await runToolContract(getVehicleSafety, ODYSSEY);

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.investigations).toStrictEqual(ODYSSEY_ROWS);
    expect(structured.sectionStatus).toStrictEqual(ALL_AVAILABLE);
    expect(structured.warnings).toStrictEqual([]);
    expect(mockService.getInvestigations).not.toHaveBeenCalled();
  });

  it('lists the same IDs as nhtsa_search_investigations for the same vehicle', async () => {
    seedOdyssey();

    const composite = await runToolContract(getVehicleSafety, ODYSSEY);
    const search = await runToolContract(searchInvestigations, ODYSSEY);

    const ids = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { investigations: { nhtsaId: string }[] }).investigations.map(
        (i) => i.nhtsaId,
      );
    expect(ids(composite)).toStrictEqual(['PE25018', 'PE25008', 'EA25004', 'RQ24013']);
    expect(ids(composite)).toStrictEqual(ids(search));
  });

  it('renders each row on content[], naming nhtsaId lookup for the summary', async () => {
    seedOdyssey();

    const result = await runToolContract(getVehicleSafety, ODYSSEY);
    const lines = readerText(result.content).split('\n');
    const section = lines.slice(lines.indexOf('Investigations (4)'));

    expect(section.slice(0, 2)).toStrictEqual([
      'Investigations (4)',
      'Rows leave out summaries: read one with nhtsa_search_investigations, passing its nhtsaId.',
    ]);
    expect(section).toContain('PE25018 [C: Closed]');
    expect(section).toContain('Type: PE — Preliminary Evaluation');
    expect(section).toContain('Subject: Sliding door may open while driving');
    expect(section).toContain('Matched models: ODYSSEY');
    expect(section).toContain('Opened: 2025-10-01 | Closed: 2025-11-01');
    expect(section).toContain('Recall Campaigns: 23V412, 24V001');
    expect(section).toContain('PE25008 [O: Open]');
    expect(section).toContain('Opened: 2025-05-01');
    expect(section.join('\n')).not.toContain('summary');
  });

  it('propagates the caller cancellation instead of reporting the section unavailable', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Client cancelled', 'AbortError');
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);
    mockService.getInvestigationsWithin.mockImplementation(async (signal: AbortSignal) => {
      controller.abort(reason);
      signal.throwIfAborted();
    });

    const ctx = createMockContext({ signal: controller.signal });
    const input = getVehicleSafety.input.parse(ODYSSEY);

    await expect(getVehicleSafety.handler(input, ctx)).rejects.toBe(reason);
    expect(mockService.getInvestigationsWithin).toHaveBeenCalledWith(controller.signal);
  });

  it('propagates a cancellation that lands while NCAP variants load', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Client cancelled', 'AbortError');
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 1 }]);
    mockService.getSafetyRating.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext({ signal: controller.signal });
    const input = getVehicleSafety.input.parse(ODYSSEY);

    await expect(getVehicleSafety.handler(input, ctx)).rejects.toBe(reason);
  });
});

/** A recall whose summary, consequence, and remedy NHTSA left blank. */
const RECALL_WITHOUT_TEXT = {
  campaignNumber: '66V008001',
  manufacturer: 'CHRYSLER CORPORATION',
  component: 'WHEELS',
  reportReceivedDate: '1966-10-12',
};

describe('getVehicleSafety — recall notes (#56)', () => {
  const NOTES =
    'POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.\nOWNERS MAY CONTACT THE HOTLINE.';

  it('carries notes on both surfaces when NHTSA sends them, and no line when it does not', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([
      { ...RECALL_WITHOUT_TEXT, campaignNumber: '66V008001', notes: NOTES },
      { ...RECALL_WITHOUT_TEXT, campaignNumber: '67V001000' },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const result = await runToolContract(getVehicleSafety, {
      make: 'Dodge',
      model: 'Dart',
      modelYear: 1967,
    });

    const recalls = (result.structuredContent as { recalls: Record<string, unknown>[] }).recalls;
    expect(recalls[0]).toStrictEqual({
      ...RECALL_WITHOUT_TEXT,
      campaignNumber: '66V008001',
      notes: NOTES,
    });
    expect(recalls[1]).not.toHaveProperty('notes');
    const text = readerText(result.content);
    expect(text).toContain(
      `66V008001 — WHEELS\nManufacturer: CHRYSLER CORPORATION\nSummary: Not available\nNotes: ${NOTES}\nConsequence: Not available`,
    );
    expect(text).toContain(
      `67V001000 — WHEELS\nManufacturer: CHRYSLER CORPORATION\nSummary: Not available\nConsequence: Not available`,
    );
  });

  it('describes what the notes hold', () => {
    const shape = getVehicleSafety.output.shape.recalls.unwrap().element.shape;
    expect(shape.notes.description).toBe(
      "NHTSA's recall notes as published: the defect description for many campaigns received before 2000, and NHTSA's hotline sentence on most received since 2010. Omitted when NHTSA sends none.",
    );
  });
});

describe('getVehicleSafety — upstream text renders as written (#59)', () => {
  /** Syntax a CommonMark reader would otherwise parse, one variant per field. */
  const h = (lead: string) => `${lead}*a* \`b\` _c_ <tag> [x](y) &amp; ###`;
  const MULTILINE = 'first *line*\n- second\n# third\n1. fourth ###';

  it('reads back every upstream string exactly', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 14720 }]);
    mockService.getSafetyRating.mockResolvedValue({
      vehicleId: 14720,
      vehicleDescription: h('# 2020 Camry '),
      overallRating: h('Not Rated '),
      frontalCrash: {},
      sideCrash: {},
      rollover: { dynamicTipResult: h('- No Tip ') },
      adasFeatures: { electronicStabilityControl: h('1. Standard ') },
    });
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: h('20V682000 '),
        manufacturer: h('1. Toyota '),
        component: h('- FUEL SYSTEM '),
        summary: MULTILINE,
        notes: `notes ${MULTILINE}`,
        consequence: h('# Fire '),
        remedy: h('Replace '),
        reportReceivedDate: h('12/10/1966 '),
      },
    ]);
    mockService.getComplaintsByVehicle.mockResolvedValue([
      { odiNumber: 1, components: h('# ENGINE ') },
    ]);
    mockService.getInvestigationsWithin.mockResolvedValue({
      kind: 'ready',
      value: [
        /**
         * `CAMRY TRAIL &amp` ends a matched-models element, so a list escaped element by element
         * would gain an entity from the "; " after it.
         */
        investigation(
          'PE25008',
          [
            { make: 'TOYOTA', model: 'CAMRY TRAIL &amp', year: 2020 },
            { make: 'TOYOTA', model: h('CAMRY '), year: 2020 },
          ],
          {
            nhtsaId: h('PE25008 '),
            investigationType: h('XY '),
            status: h('O '),
            subject: h('1. Engine failure '),
            openDate: h('- 2025-05-01 '),
            closeDate: h('# 2025-06-01 '),
            recallCampaigns: [h('25V001 '), h('# 25V002 ')],
          },
        ),
      ],
    });

    const result = await runToolContract(getVehicleSafety, {
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
    });

    expect(result.isError).not.toBe(true);
    const text = readerText(result.content);
    const lines = text.split('\n');
    expect(lines).toContain('Vehicle 14720');
    expect(lines).toContain(`Description: ${h('# 2020 Camry ')}`);
    expect(lines).toContain(`Overall: ${h('Not Rated ')}`);
    expect(lines).toContain(
      `Rollover: Not available | Probability: Not available | Tip test: ${h('- No Tip ')}`,
    );
    expect(lines).toContain(
      `ADAS: ESC: ${h('1. Standard ')} | Forward Collision Warning: Not available | Lane Departure Warning: Not available`,
    );
    expect(lines).toContain(`${h('20V682000 ')} — ${h('- FUEL SYSTEM ')}`);
    expect(lines).toContain(`Manufacturer: ${h('1. Toyota ')}`);
    expect(text).toContain(`\n${MULTILINE}\nNotes: notes ${MULTILINE}\n`);
    expect(lines).toContain(`Consequence: ${h('# Fire ')}`);
    expect(lines).toContain(`Remedy: ${h('Replace ')}`);
    expect(lines).toContain(`Date: ${h('12/10/1966 ')}`);
    expect(lines).toContain(
      `${h('# ENGINE ')}: 1 complaint (0 crashes, 0 fires, 0 injuries, 0 deaths)`,
    );
    expect(lines).toContain(`${h('PE25008 ')} [${h('O ')}: ${h('O ')}]`);
    expect(lines).toContain(`Type: ${h('XY ')} — ${h('XY ')}`);
    expect(lines).toContain(`Subject: ${h('1. Engine failure ')}`);
    expect(lines).toContain(`Matched models: CAMRY TRAIL &amp; ${h('CAMRY ')}`);
    expect(lines).toContain(`Opened: ${h('- 2025-05-01 ')} | Closed: ${h('# 2025-06-01 ')}`);
    expect(lines).toContain(`Recall Campaigns: ${h('25V001 ')}, ${h('# 25V002 ')}`);
  });
});

/**
 * How one section came back: records, loaded with none, or a failed request. Investigations add
 * `pending`, a bulk-file load still running when the wait ended.
 */
type SectionFixture = 'records' | 'empty' | 'failed';
type InvestigationFixture = SectionFixture | 'pending';

const RATING = {
  vehicleId: 9001,
  frontalCrash: {},
  sideCrash: {},
  rollover: {},
  adasFeatures: {},
};
const RECALL = {
  campaignNumber: '14V001000',
  manufacturer: 'General Motors LLC',
  component: 'AIR BAGS',
  summary: 'Air bag may not deploy.',
  consequence: 'Increased risk of injury.',
  remedy: 'Dealers will repair.',
  reportReceivedDate: '2014-01-02',
};
const COMPLAINT = { odiNumber: 1, components: 'ENGINE' };
const SILVERADO_INVESTIGATION = investigation('PE14020', [
  { make: 'CHEVROLET', model: 'SILVERADO 1500', year: 2014 },
]);

function seedSections(
  ncap: SectionFixture,
  recalls: SectionFixture,
  complaints: SectionFixture,
  investigations: InvestigationFixture,
) {
  const failure = new Error('upstream unavailable');
  mockService.getInvestigationsWithin.mockResolvedValue(
    investigations === 'failed'
      ? { kind: 'failed', error: failure }
      : investigations === 'pending'
        ? { kind: 'pending' }
        : { kind: 'ready', value: investigations === 'records' ? [SILVERADO_INVESTIGATION] : [] },
  );
  if (ncap === 'failed') mockService.getSafetyRatingVariants.mockRejectedValue(failure);
  else {
    mockService.getSafetyRatingVariants.mockResolvedValue(
      ncap === 'records' ? [{ vehicleId: RATING.vehicleId }] : [],
    );
    mockService.getSafetyRating.mockResolvedValue(RATING);
  }
  if (recalls === 'failed') mockService.getRecallsByVehicle.mockRejectedValue(failure);
  else mockService.getRecallsByVehicle.mockResolvedValue(recalls === 'records' ? [RECALL] : []);
  if (complaints === 'failed') mockService.getComplaintsByVehicle.mockRejectedValue(failure);
  else {
    mockService.getComplaintsByVehicle.mockResolvedValue(
      complaints === 'records' ? [COMPLAINT] : [],
    );
  }
}

describe('getVehicleSafety — sections filed under another model name (#47, #61, #64)', () => {
  it.each([
    // The 2014 Chevrolet "Silverado" and 2016 Tesla "Model S" shape.
    [
      'empty',
      'records',
      'empty',
      'records',
      'No NCAP ratings or complaints matched, though recalls and investigations did.',
    ],
    [
      'records',
      'empty',
      'records',
      'records',
      'No recalls matched, though NCAP ratings, complaints, and investigations did.',
    ],
    [
      'records',
      'records',
      'empty',
      'empty',
      'No complaints or investigations matched, though NCAP ratings and recalls did.',
    ],
    [
      'records',
      'empty',
      'empty',
      'records',
      'No recalls or complaints matched, though NCAP ratings and investigations did.',
    ],
    [
      'empty',
      'records',
      'empty',
      'empty',
      'No NCAP ratings, complaints, or investigations matched, though recalls did.',
    ],
    // Investigations with records against three empty sections.
    [
      'empty',
      'empty',
      'empty',
      'records',
      'No NCAP ratings, recalls, or complaints matched, though investigations did.',
    ],
    // A failed section, or investigations still loading, is neither empty nor populated.
    [
      'empty',
      'empty',
      'records',
      'failed',
      'No NCAP ratings or recalls matched, though complaints did.',
    ],
    ['records', 'failed', 'empty', 'pending', 'No complaints matched, though NCAP ratings did.'],
    [
      'failed',
      'records',
      'empty',
      'empty',
      'No complaints or investigations matched, though recalls did.',
    ],
  ] as const)(
    'NCAP %s, recalls %s, complaints %s, investigations %s → "%s"',
    async (ncap, recalls, complaints, investigations, lead) => {
      seedSections(ncap, recalls, complaints, investigations);

      const result = await runToolContract(getVehicleSafety, {
        make: 'Chevrolet',
        model: 'Silverado',
        modelYear: 2014,
      });

      /** Empty investigations, named among the empty sections, get the clause the tag list lacks. */
      const route =
        investigations === 'empty' ? ROUTE_WITH_INVESTIGATIONS_CLAUSE : MODEL_NAME_ROUTE;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ notice: `${lead} ${route}` });
      expect(readerText(result.content)).toContain(`${lead} ${route}`);
    },
  );

  it.each([
    // The 2014 Chevrolet "SILVERADO 1500" shape: every section has records.
    ['records', 'records', 'records', 'records'],
    // Empty investigations alone never fire it, as empty NCAP alone never does.
    ['records', 'records', 'records', 'empty'],
    ['empty', 'records', 'records', 'records'],
    ['empty', 'records', 'records', 'empty'],
    // Nothing populated: no section to contrast the empty ones with.
    ['empty', 'failed', 'empty', 'empty'],
    ['failed', 'empty', 'failed', 'empty'],
    ['failed', 'failed', 'failed', 'failed'],
  ] as const)(
    'stays silent for NCAP %s, recalls %s, complaints %s, investigations %s',
    async (ncap, recalls, complaints, investigations) => {
      seedSections(ncap, recalls, complaints, investigations);

      const result = await runToolContract(getVehicleSafety, {
        make: 'Chevrolet',
        model: 'Silverado 1500',
        modelYear: 2014,
      });

      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(readerText(result.content)).not.toContain('dataset_models');
    },
  );

  it('counts NCAP ratings as populated when only some variants loaded', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 1 }, { vehicleId: 2 }]);
    mockService.getSafetyRating
      .mockResolvedValueOnce({ ...RATING, vehicleId: 1 })
      .mockRejectedValueOnce(new Error('timeout'));
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const result = await runToolContract(getVehicleSafety, {
      make: 'Chevrolet',
      model: 'Silverado',
      modelYear: 2014,
    });

    expect(result.structuredContent).toMatchObject({
      sectionStatus: { safetyRatings: 'partial' },
      notice: `No recalls, complaints, or investigations matched, though NCAP ratings did. ${ROUTE_WITH_INVESTIGATIONS_CLAUSE}`,
    });
  });

  it('keeps the all-empty notice when every section loaded with nothing', async () => {
    seedSections('empty', 'empty', 'empty', 'empty');

    const result = await runToolContract(getVehicleSafety, {
      make: 'Chevrolet',
      model: 'Silverado',
      modelYear: 2014,
    });

    expect(result.structuredContent).toMatchObject({ notice: ALL_EMPTY_NOTICE });
    expect(readerText(result.content)).toContain(ALL_EMPTY_NOTICE);
  });

  it.each(['failed', 'pending'] as const)(
    'keeps the all-empty notice for the other three sections when investigations are %s',
    async (investigations) => {
      seedSections('empty', 'empty', 'empty', investigations);

      const result = await runToolContract(getVehicleSafety, {
        make: 'Chevrolet',
        model: 'Silverado',
        modelYear: 2014,
      });

      const notice =
        'No NCAP ratings, recalls, or complaints matched this vehicle. It may have a clean record, or NHTSA may list its records under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search each dataset under the names it tags for it: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings.';
      expect(result.structuredContent).toMatchObject({
        sectionStatus: { investigations: 'unavailable' },
        notice,
      });
      expect(readerText(result.content)).toContain(notice);
    },
  );

  it('reports a failed complaint request as a failed request, not a name mismatch', async () => {
    seedSections('records', 'records', 'failed', 'records');

    const result = await runToolContract(getVehicleSafety, {
      make: 'Chevrolet',
      model: 'Silverado 1500',
      modelYear: 2014,
    });

    expect(result.structuredContent).toMatchObject({
      sectionStatus: { complaints: 'unavailable' },
      warnings: ['Complaint data could not be retrieved.'],
    });
    expect(readerText(result.content)).toContain('Warning: Complaint data could not be retrieved.');
  });
});

/**
 * One FLAT_INV.zip line: ID, make, model, year, component, manufacturer, open date, close date,
 * campaign number, subject, summary.
 */
function flatInvLine(
  nhtsaId: string,
  make: string,
  model: string,
  year: string,
  openDate: string,
  closeDate = '',
): string {
  return [
    nhtsaId,
    make,
    model,
    year,
    'ENGINE',
    'Example Motor Co.',
    openDate,
    closeDate,
    '',
    `${nhtsaId} subject`,
    `${nhtsaId} summary`,
  ].join('\t');
}

function flatInvZip(lines: string[]): Response {
  return new Response(zipSync({ 'FLAT_INV.txt': new TextEncoder().encode(lines.join('\n')) }));
}

describe('getVehicleSafety — recall text NHTSA sends as null (#55, #56)', () => {
  const fetchMock = vi.fn();
  /** A 1967 Dodge Dart recall row as api.nhtsa.gov returns it: the campaign text is null. */
  const nullTextRow = {
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
  };

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'static.nhtsa.gov' && pathname.endsWith('/FLAT_INV.zip')) {
        return flatInvZip([flatInvLine('PE20001', 'DODGE', 'DART', '2016', '20200301')]);
      }
      if (hostname !== 'api.nhtsa.gov') throw new Error('unmocked fetch');
      if (pathname === '/recalls/recallsByVehicle') {
        return Response.json({
          Count: 1,
          Message: 'Results returned successfully',
          results: [nullTextRow],
        });
      }
      if (pathname === '/complaints/complaintsByVehicle') {
        return Response.json({ count: 0, message: 'Results returned successfully', results: [] });
      }
      if (pathname.startsWith('/SafetyRatings/modelyear/1967/')) {
        return Response.json({
          Count: 0,
          Message: 'No results found for this request',
          Results: [],
        });
      }
      throw new Error('unmocked fetch');
    });
    const actual = await vi.importActual<typeof import('@/services/nhtsa/nhtsa-service.js')>(
      '@/services/nhtsa/nhtsa-service.js',
    );
    vi.mocked(getNhtsaService).mockReturnValue(new actual.NhtsaService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the recall with its notes, rendering the null fields as not available', async () => {
    const result = await runToolContract(getVehicleSafety, {
      make: 'Dodge',
      model: 'Dart',
      modelYear: 1967,
    });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      recalls: Record<string, unknown>[];
      investigations: unknown[];
      sectionStatus: Record<string, string>;
    };
    expect(structured.sectionStatus.recalls).toBe('available');
    expect(structured.recalls).toStrictEqual([
      {
        campaignNumber: '66V008001',
        manufacturer: 'CHRYSLER CORPORATION',
        component: 'WHEELS',
        notes: 'POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.',
        reportReceivedDate: '1966-10-12',
        parkIt: false,
        parkOutSide: false,
        overTheAirUpdate: false,
      },
    ]);
    /** The only investigation in the file covers a 2016 Dart, not this one. */
    expect(structured.sectionStatus.investigations).toBe('available');
    expect(structured.investigations).toStrictEqual([]);
    const lines = readerText(result.content).split('\n');
    expect(lines).toContain('66V008001 — WHEELS');
    expect(lines).toContain('Summary: Not available');
    expect(lines).toContain(
      'Notes: POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.',
    );
    expect(lines).toContain('Consequence: Not available');
    expect(lines).toContain('Remedy: Not available');
    expect(lines.join('\n')).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});

describe('getVehicleSafety — investigations through the flat-file loader (#64)', () => {
  const fetchMock = vi.fn();
  /**
   * The sibling-model case (GRAND CHEROKEE for query Cherokee), a record matching on two
   * associations (RQ15003), #51's cross-row case (CHEROKEE on a 2015 row, 2014 only on a
   * WRANGLER row), and an undated record, in file order unlike newest-opened order.
   */
  const lines = [
    flatInvLine('EA14002', 'JEEP', 'CHEROKEE', '2015', '20140601'),
    flatInvLine('EA14002', 'JEEP', 'WRANGLER', '2014', '20140601'),
    flatInvLine('PE14001', 'JEEP', 'GRAND CHEROKEE', '2014', '20140301', '20150101'),
    flatInvLine('RQ15003', 'JEEP', 'CHEROKEE', '2014', '20150901'),
    flatInvLine('RQ15003', 'JEEP', 'COMPASS', '2014', '20150901'),
    flatInvLine('RQ15003', 'JEEP', 'GRAND CHEROKEE', '2014', '20150901'),
    flatInvLine('DP99001', 'JEEP', 'CHEROKEE', '2014', ''),
    flatInvLine('PE16004', 'DODGE', 'DURANGO', '2014', '20160101'),
  ];

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'static.nhtsa.gov' && pathname.endsWith('/FLAT_INV.zip')) {
        return flatInvZip(lines);
      }
      if (hostname !== 'api.nhtsa.gov') throw new Error('unmocked fetch');
      if (pathname === '/recalls/recallsByVehicle') {
        return Response.json({ Count: 0, Message: 'Results returned successfully', results: [] });
      }
      if (pathname === '/complaints/complaintsByVehicle') {
        return Response.json({ count: 0, message: 'Results returned successfully', results: [] });
      }
      if (pathname.startsWith('/SafetyRatings/modelyear/2014/')) {
        return Response.json({ Count: 0, Message: 'No results', Results: [] });
      }
      throw new Error('unmocked fetch');
    });
    const actual = await vi.importActual<typeof import('@/services/nhtsa/nhtsa-service.js')>(
      '@/services/nhtsa/nhtsa-service.js',
    );
    vi.mocked(getNhtsaService).mockReturnValue(new actual.NhtsaService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the same investigations as nhtsa_search_investigations, sibling models named', async () => {
    const vehicle = { make: 'Jeep', model: 'Cherokee', modelYear: 2014 };
    const composite = await runToolContract(getVehicleSafety, vehicle);
    const search = await runToolContract(searchInvestigations, vehicle);

    const rows = (composite.structuredContent as { investigations: Record<string, unknown>[] })
      .investigations;
    const searchIds = (
      search.structuredContent as { investigations: { nhtsaId: string }[] }
    ).investigations.map((i) => i.nhtsaId);
    expect(rows.map((row) => row.nhtsaId)).toStrictEqual(['RQ15003', 'PE14001', 'DP99001']);
    expect(rows.map((row) => row.nhtsaId)).toStrictEqual(searchIds);
    expect(rows.map((row) => row.matchedModels)).toStrictEqual([
      ['CHEROKEE', 'GRAND CHEROKEE'],
      ['GRAND CHEROKEE'],
      ['CHEROKEE'],
    ]);
    expect(rows.every((row) => !('summary' in row))).toBe(true);
    const text = readerText(composite.content);
    expect(text).toContain('RQ15003 subject');
    expect(text.split('\n')).toContain('Matched models: CHEROKEE; GRAND CHEROKEE');
    for (const id of searchIds) expect(text).not.toContain(`${id} summary`);
    /** One shared load serves both tools. */
    expect(
      fetchMock.mock.calls.filter(([url]) => new URL(url).hostname === 'static.nhtsa.gov'),
    ).toHaveLength(1);
  });
});
