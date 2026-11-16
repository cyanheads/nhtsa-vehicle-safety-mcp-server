/**
 * @fileoverview Additional coverage for nhtsa_get_vehicle_safety — partial section status,
 * complaints-unavailable format, and edge cases.
 * @module tests/mcp-server/tools/definitions/get-vehicle-safety-edge.tool
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
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

const sampleRating = {
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
};

describe('getVehicleSafety — partial section status', () => {
  it('marks safetyRatings as partial when some variants fail but others succeed', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720 },
      { vehicleId: 14721 },
    ]);
    // First succeeds, second fails
    mockService.getSafetyRating
      .mockResolvedValueOnce(sampleRating)
      .mockRejectedValueOnce(new Error('timeout'));
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);

    expect(parsed.sectionStatus.safetyRatings).toBe('partial');
    expect(parsed.safetyRatings).toHaveLength(1);
    expect(parsed.warnings.some((w) => w.includes('variant'))).toBe(true);
  });

  it('marks safetyRatings as unavailable when all variants fail', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720 },
      { vehicleId: 14721 },
    ]);
    mockService.getSafetyRating.mockRejectedValue(new Error('all variants failed'));
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);

    expect(parsed.sectionStatus.safetyRatings).toBe('unavailable');
    expect(parsed.safetyRatings).toBeUndefined();
  });
});

describe('getVehicleSafety — complaints unavailable', () => {
  it('marks complaints as unavailable and format renders the section correctly', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockRejectedValue(new Error('complaints unavailable'));

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);
    const text = firstText(getVehicleSafety.format!(parsed));

    expect(parsed.sectionStatus.complaints).toBe('unavailable');
    expect(text).toContain('Complaint data was unavailable');
  });
});

describe('getVehicleSafety — format edge cases', () => {
  it('format renders partial safety ratings note', () => {
    const output = {
      safetyRatings: [
        {
          vehicleId: 1,
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
      recalls: [],
      complaintSummary: {
        totalCount: 0,
        componentBreakdown: [],
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      },
      sectionStatus: {
        safetyRatings: 'partial' as const,
        recalls: 'available' as const,
        complaints: 'available' as const,
        investigations: 'available' as const,
      },
      warnings: ['Some NCAP safety ratings could not be retrieved (1 variant).'],
    };

    const text = firstText(getVehicleSafety.format!(output));
    expect(text).toContain('Some matching NCAP variant ratings could not be loaded');
    expect(text).toContain('Warning:');
  });

  it('format renders NCAP section with "Not available" when no data and status is available', () => {
    const output = {
      safetyRatings: [],
      recalls: [],
      complaintSummary: {
        totalCount: 0,
        componentBreakdown: [],
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      },
      sectionStatus: {
        safetyRatings: 'available' as const,
        recalls: 'available' as const,
        complaints: 'available' as const,
        investigations: 'available' as const,
      },
      warnings: [],
    };

    const text = firstText(getVehicleSafety.format!(output));
    expect(text).toContain('No NCAP crash test ratings found');
    expect(text).toContain('No recalls found');
    expect(text).toContain('No complaints filed');
  });

  it('format shows every component when multiple components present', () => {
    const output = {
      safetyRatings: [],
      recalls: [],
      complaintSummary: {
        totalCount: 10,
        componentBreakdown: [
          {
            component: 'ENGINE',
            count: 5,
            crashCount: 1,
            fireCount: 0,
            injuryCount: 1,
            deathCount: 0,
          },
          {
            component: 'BRAKES',
            count: 3,
            crashCount: 0,
            fireCount: 0,
            injuryCount: 0,
            deathCount: 0,
          },
          {
            component: 'STEERING',
            count: 2,
            crashCount: 1,
            fireCount: 0,
            injuryCount: 0,
            deathCount: 1,
          },
        ],
        crashCount: 2,
        fireCount: 0,
        injuryCount: 1,
        deathCount: 1,
      },
      sectionStatus: {
        safetyRatings: 'unavailable' as const,
        recalls: 'available' as const,
        complaints: 'available' as const,
        investigations: 'available' as const,
      },
      warnings: ['NCAP crash test data is not available for this vehicle.'],
    };

    const text = firstText(getVehicleSafety.format!(output));
    expect(text).toContain('ENGINE');
    expect(text).toContain('BRAKES');
    expect(text).toContain('STEERING');
    expect(text).toContain('Crashes: 2');
  });
});

describe('getVehicleSafety — decode from output schema', () => {
  it('output schema validates with all sections available', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 14720 }]);
    mockService.getSafetyRating.mockResolvedValue(sampleRating);
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
    mockService.getComplaintsByVehicle.mockResolvedValue([
      {
        odiNumber: 1,
        crash: false,
        fire: false,
        numberOfInjuries: 0,
        numberOfDeaths: 0,
        components: 'ENGINE',
      },
    ]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getVehicleSafety.handler(input, ctx);
    const parsed = getVehicleSafety.output.parse(result);

    expect(parsed.sectionStatus.safetyRatings).toBe('available');
    expect(parsed.sectionStatus.recalls).toBe('available');
    expect(parsed.sectionStatus.complaints).toBe('available');
    expect(parsed.safetyRatings).toHaveLength(1);
    expect(parsed.recalls).toHaveLength(1);
    expect(parsed.complaintSummary?.totalCount).toBe(1);
  });

  it('omits rollover probability for an untested variant instead of reporting zero risk', () => {
    const output = {
      safetyRatings: [
        {
          vehicleId: 3440,
          vehicleDescription: '1995 Geo Metro 4-DR.',
          frontalCrash: {},
          sideCrash: {},
          rollover: { rating: 'Not Rated' },
          adasFeatures: {},
        },
      ],
      recalls: [],
      complaintSummary: {
        totalCount: 0,
        componentBreakdown: [],
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      },
      sectionStatus: {
        safetyRatings: 'available' as const,
        recalls: 'available' as const,
        complaints: 'available' as const,
        investigations: 'available' as const,
      },
      warnings: [],
    };

    const text = firstText(getVehicleSafety.format!(output));
    expect(text).toContain('**Rollover:** Not Rated | Probability: Not available');
    expect(text).not.toContain('0.0%');
  });
});

describe('getVehicleSafety — investigations unavailable (#64)', () => {
  const ODYSSEY = { make: 'Honda', model: 'Odyssey', modelYear: 2018 };
  const STILL_LOADING =
    'Investigation data is still loading from NHTSA; a later call will include it once the load finishes.';
  const RECALL = {
    campaignNumber: '18V268000',
    manufacturer: 'Honda (American Honda Motor Co.)',
    component: 'SEATS',
    summary: 'Second-row outboard seat may not latch.',
    consequence: 'Increased risk of injury.',
    remedy: 'Dealers will repair.',
    reportReceivedDate: '2018-04-25',
  };
  const PE25008: Investigation = {
    nhtsaId: 'PE25008',
    investigationType: 'PE',
    status: 'O',
    subject: 'Engine failure',
    summary: 'A long summary.',
    openDate: '2025-05-01',
    vehicles: [{ make: 'HONDA', model: 'ODYSSEY', year: 2018 }],
  };

  function seedOtherSections() {
    mockService.getSafetyRatingVariants.mockResolvedValue([{ vehicleId: 14720 }]);
    mockService.getSafetyRating.mockResolvedValue(sampleRating);
    mockService.getRecallsByVehicle.mockResolvedValue([RECALL]);
    mockService.getComplaintsByVehicle.mockResolvedValue([{ odiNumber: 1, components: 'ENGINE' }]);
  }

  it.each([
    [
      'failed',
      { kind: 'failed', error: new Error('502') },
      'Investigation data could not be retrieved.',
    ],
    ['still loading', { kind: 'pending' }, STILL_LOADING],
  ] as const)(
    'a load that %s leaves the other sections intact and the call successful',
    async (_label, outcome, warning) => {
      seedOtherSections();
      mockService.getInvestigationsWithin.mockResolvedValue(outcome);

      const result = await runToolContract(getVehicleSafety, ODYSSEY);

      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.sectionStatus).toStrictEqual({
        safetyRatings: 'available',
        recalls: 'available',
        complaints: 'available',
        investigations: 'unavailable',
      });
      expect(structured.warnings).toStrictEqual([warning]);
      expect(structured).not.toHaveProperty('investigations');
      expect(structured.recalls).toStrictEqual([RECALL]);
      expect(structured.safetyRatings).toHaveLength(1);
      expect(structured.complaintSummary).toMatchObject({ totalCount: 1 });
      const lines = readerText(result.content).split('\n');
      expect(lines).toContain(`Warning: ${warning}`);
      expect(linesFrom(lines, 'Investigations', 2)).toStrictEqual([
        'Investigations',
        'Investigation data was unavailable for this request. nhtsa_search_investigations with the same make, model, and modelYear lists them once the data loads.',
      ]);
    },
  );

  it('reads the loaded data on the next call after a wait that lapsed', async () => {
    seedOtherSections();
    mockService.getInvestigationsWithin
      .mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValueOnce({ kind: 'ready', value: [PE25008] });

    const first = await runToolContract(getVehicleSafety, ODYSSEY);
    const second = await runToolContract(getVehicleSafety, ODYSSEY);

    expect(first.structuredContent).toMatchObject({
      sectionStatus: { investigations: 'unavailable' },
    });
    expect(second.structuredContent).toMatchObject({
      sectionStatus: { investigations: 'available' },
      warnings: [],
      investigations: [{ nhtsaId: 'PE25008', status: 'O', matchedModels: ['ODYSSEY'] }],
    });
    /** Each call waits through the bounded seam with its own signal; neither waits unbounded. */
    expect(mockService.getInvestigationsWithin).toHaveBeenCalledTimes(2);
    expect(mockService.getInvestigationsWithin.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(mockService.getInvestigations).not.toHaveBeenCalled();
  });

  it('reports an empty section as available with no rows', async () => {
    seedOtherSections();

    const result = await runToolContract(getVehicleSafety, ODYSSEY);

    expect(result.structuredContent).toMatchObject({
      sectionStatus: { investigations: 'available' },
      investigations: [],
      warnings: [],
    });
    const lines = readerText(result.content).split('\n');
    expect(linesFrom(lines, 'Investigations (0)', 2)).toStrictEqual([
      'Investigations (0)',
      'No investigations found.',
    ]);
  });
});

/** `count` reader lines starting at `first`; fails when `first` is absent. */
function linesFrom(lines: string[], first: string, count: number): string[] {
  const start = lines.indexOf(first);
  expect(start).toBeGreaterThanOrEqual(0);
  return lines.slice(start, start + count);
}

describe('getVehicleSafety — investigation rows in the output schema (#64)', () => {
  it('declares the row fields and no summary', () => {
    const row = getVehicleSafety.output.shape.investigations.unwrap().element;
    expect(Object.keys(row.shape).sort()).toStrictEqual(
      [
        'closeDate',
        'investigationType',
        'investigationTypeName',
        'matchedModels',
        'nhtsaId',
        'openDate',
        'recallCampaigns',
        'status',
        'statusName',
        'subject',
      ].sort(),
    );
  });

  it('declares the section status as available or unavailable', () => {
    const status = getVehicleSafety.output.shape.sectionStatus.shape.investigations;
    expect(status.options).toStrictEqual(['available', 'unavailable']);
  });
});
