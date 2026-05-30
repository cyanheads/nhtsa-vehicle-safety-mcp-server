/**
 * @fileoverview Additional coverage for nhtsa_get_vehicle_safety — partial section status,
 * complaints-unavailable format, and edge cases.
 * @module tests/mcp-server/tools/definitions/get-vehicle-safety-edge.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

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
    const text = getVehicleSafety.format!(parsed)[0].text;

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
      },
      warnings: ['Some NCAP safety ratings could not be retrieved (1 variant).'],
    };

    const text = getVehicleSafety.format!(output)[0].text;
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
      },
      warnings: [],
    };

    const text = getVehicleSafety.format!(output)[0].text;
    expect(text).toContain('No NCAP crash test ratings found');
    expect(text).toContain('No recalls found');
    expect(text).toContain('No complaints filed');
  });

  it('format shows top complaints when multiple components present', () => {
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
      },
      warnings: ['NCAP crash test data is not available for this vehicle.'],
    };

    const text = getVehicleSafety.format!(output)[0].text;
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
});
