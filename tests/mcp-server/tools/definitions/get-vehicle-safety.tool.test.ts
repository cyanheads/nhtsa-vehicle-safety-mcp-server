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

import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = {
  getSafetyRatingVariants: vi.fn(),
  getSafetyRating: vi.fn(),
  getRecallsByVehicle: vi.fn(),
  getComplaintsByVehicle: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

const MODEL_NAME_ROUTE =
  'NHTSA\'s datasets can file one vehicle under different model names. List them with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search the empty sections under those names.';

const ALL_EMPTY_NOTICE =
  'No NCAP ratings, recalls, or complaints matched this vehicle. It may have a clean record, or NHTSA may list its records under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search under each.';

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
    expect(result.sectionStatus).toEqual({
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
    });
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
    expect(result.sectionStatus).toEqual({
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
    });
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
      `No NCAP ratings or complaints matched, though recalls did. ${MODEL_NAME_ROUTE}`,
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
      sectionStatus: {
        safetyRatings: 'available',
        recalls: 'available',
        complaints: 'available',
      },
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

/** How one section came back: records, loaded with none, or a failed request. */
type SectionFixture = 'records' | 'empty' | 'failed';

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

function seedSections(ncap: SectionFixture, recalls: SectionFixture, complaints: SectionFixture) {
  const failure = new Error('upstream unavailable');
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

describe('getVehicleSafety — sections filed under another model name (#47)', () => {
  it.each([
    // The 2014 Chevrolet "Silverado" and 2016 Tesla "Model S" shape.
    ['empty', 'records', 'empty', 'No NCAP ratings or complaints matched, though recalls did.'],
    ['records', 'empty', 'records', 'No recalls matched, though NCAP ratings and complaints did.'],
    ['records', 'records', 'empty', 'No complaints matched, though NCAP ratings and recalls did.'],
    ['records', 'empty', 'empty', 'No recalls or complaints matched, though NCAP ratings did.'],
    ['empty', 'empty', 'records', 'No NCAP ratings or recalls matched, though complaints did.'],
    // A failed section is neither empty nor populated.
    ['records', 'failed', 'empty', 'No complaints matched, though NCAP ratings did.'],
    ['failed', 'records', 'empty', 'No complaints matched, though recalls did.'],
  ] as const)(
    'NCAP %s, recalls %s, complaints %s → "%s"',
    async (ncap, recalls, complaints, lead) => {
      seedSections(ncap, recalls, complaints);

      const result = await runToolContract(getVehicleSafety, {
        make: 'Chevrolet',
        model: 'Silverado',
        modelYear: 2014,
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ notice: `${lead} ${MODEL_NAME_ROUTE}` });
      expect(readerText(result.content)).toContain(`${lead} ${MODEL_NAME_ROUTE}`);
    },
  );

  it.each([
    // The 2014 Chevrolet "SILVERADO 1500" shape: every section has records.
    ['records', 'records', 'records'],
    // Empty NCAP alone never fires it.
    ['empty', 'records', 'records'],
    // Nothing populated: no section to contrast the empty ones with.
    ['empty', 'failed', 'empty'],
    ['failed', 'empty', 'failed'],
    ['failed', 'failed', 'failed'],
  ] as const)(
    'stays silent for NCAP %s, recalls %s, complaints %s',
    async (ncap, recalls, complaints) => {
      seedSections(ncap, recalls, complaints);

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
      notice: `No recalls or complaints matched, though NCAP ratings did. ${MODEL_NAME_ROUTE}`,
    });
  });

  it('keeps the all-empty notice when every section loaded with nothing', async () => {
    seedSections('empty', 'empty', 'empty');

    const result = await runToolContract(getVehicleSafety, {
      make: 'Chevrolet',
      model: 'Silverado',
      modelYear: 2014,
    });

    expect(result.structuredContent).toMatchObject({ notice: ALL_EMPTY_NOTICE });
    expect(readerText(result.content)).toContain(ALL_EMPTY_NOTICE);
  });

  it('reports a failed complaint request as a failed request, not a name mismatch', async () => {
    seedSections('records', 'records', 'failed');

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

describe('getVehicleSafety — recall text NHTSA sends as null (#55)', () => {
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

  it('returns the recall, omitting the null fields and rendering them as not available', async () => {
    const result = await runToolContract(getVehicleSafety, {
      make: 'Dodge',
      model: 'Dart',
      modelYear: 1967,
    });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      recalls: Record<string, unknown>[];
      sectionStatus: Record<string, string>;
    };
    expect(structured.sectionStatus.recalls).toBe('available');
    expect(structured.recalls).toStrictEqual([
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
    const text = readerText(result.content);
    expect(text).toContain('66V008001 — WHEELS');
    expect(text).toContain('Summary: Not available');
    expect(text).toContain('Consequence: Not available');
    expect(text).toContain('Remedy: Not available');
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});
