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
