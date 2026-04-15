/**
 * @fileoverview Tests for nhtsa_get_vehicle_safety tool.
 * @module tests/mcp-server/tools/definitions/get-vehicle-safety.tool
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
    expect(result.safetyRatings[0].overallRating).toBe('5');
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0].parkIt).toBe(true);
    expect(result.complaintSummary.totalCount).toBe(1);
    expect(result.complaintSummary.crashCount).toBe(1);
    expect(result.complaintSummary.componentBreakdown).toHaveLength(2);
    expect(result.sectionStatus).toEqual({
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
    });
  });

  it('returns empty ratings when no variants found', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    mockService.getRecallsByVehicle.mockResolvedValue([]);
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getVehicleSafety.input.parse({ make: 'Fake', model: 'Car', modelYear: 1990 });
    const result = await getVehicleSafety.handler(input, ctx);

    expect(result.safetyRatings).toEqual([]);
    expect(result.recalls).toEqual([]);
    expect(result.complaintSummary.totalCount).toBe(0);
    expect(result.sectionStatus).toEqual({
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
    });
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

    expect(parsed.recalls).toHaveLength(1);
    expect(parsed.recalls[0].parkIt).toBeUndefined();
    expect(parsed.sectionStatus.recalls).toBe('available');
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
    const text = getVehicleSafety.format!(parsed)[0].text;

    expect(parsed.safetyRatings).toHaveLength(1);
    expect(parsed.safetyRatings[0].overallRating).toBeUndefined();
    expect(parsed.safetyRatings[0].rollover.probability).toBeUndefined();
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
    const text = getVehicleSafety.format!(parsed)[0].text;

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
          component: 'FUEL',
          summary: 'Leak.',
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
    const blocks = getVehicleSafety.format!(output);
    expect(blocks).toHaveLength(1);
    const text = blocks[0].text;
    expect(text).toContain('NCAP Safety Ratings');
    expect(text).toContain('DO NOT DRIVE');
    expect(text).toContain('Complaints (5)');
    expect(text).toContain('ENGINE');
  });
});
