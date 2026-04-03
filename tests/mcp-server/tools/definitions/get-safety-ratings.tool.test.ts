/**
 * @fileoverview Tests for nhtsa_get_safety_ratings tool.
 * @module tests/mcp-server/tools/definitions/get-safety-ratings.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { getSafetyRatings } from '@/mcp-server/tools/definitions/get-safety-ratings.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const mockService = {
  getSafetyRatingVariants: vi.fn(),
  getSafetyRating: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

const sampleRating = {
  vehicleId: 14720,
  vehicleDescription: '2020 Toyota CAMRY FWD',
  overallRating: '5',
  frontalCrash: { overall: '5', driverSide: '4', passengerSide: '5' },
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
  complaintsCount: 255,
  recallsCount: 3,
  investigationCount: 0,
};

describe('getSafetyRatings', () => {
  it('fetches ratings via variant lookup', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720, vehicleDescription: '2020 Toyota CAMRY FWD' },
    ]);
    mockService.getSafetyRating.mockResolvedValue(sampleRating);

    const ctx = createMockContext();
    const input = getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toHaveLength(1);
    expect(result.ratings[0].overallRating).toBe('5');
    expect(result.ratings[0].frontalCrash.driverSide).toBe('4');
    expect(mockService.getSafetyRatingVariants).toHaveBeenCalledWith(2020, 'Toyota', 'Camry');
  });

  it('fetches rating by vehicleId directly', async () => {
    mockService.getSafetyRating.mockResolvedValue(sampleRating);

    const ctx = createMockContext();
    const input = getSafetyRatings.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      vehicleId: 14720,
    });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toHaveLength(1);
    expect(mockService.getSafetyRatingVariants).not.toHaveBeenCalled();
    expect(mockService.getSafetyRating).toHaveBeenCalledWith(14720);
  });

  it('returns empty when no variants found', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = getSafetyRatings.input.parse({ make: 'Fake', model: 'Car', modelYear: 1990 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toEqual([]);
  });

  it('format renders star ratings', () => {
    const output = { ratings: [sampleRating] };
    const blocks = getSafetyRatings.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('2020 Toyota CAMRY FWD');
    expect(text).toContain('★');
    expect(text).toContain('No Tip');
    expect(text).toContain('Standard');
  });

  it('format handles no ratings', () => {
    const blocks = getSafetyRatings.format!({ ratings: [] });
    expect(blocks[0].text).toContain('No NCAP safety ratings');
  });
});
