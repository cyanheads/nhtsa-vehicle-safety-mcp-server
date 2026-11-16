/**
 * @fileoverview Tests for nhtsa_get_safety_ratings tool.
 * @module tests/mcp-server/tools/definitions/get-safety-ratings.tool
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { getSafetyRatings } from '@/mcp-server/tools/definitions/get-safety-ratings.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText, readerText } from '../../../helpers/content.js';
import { hostile } from '../../../helpers/hostile.js';

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
  it('normalizes blank optional vehicle criteria out of ID mode', async () => {
    mockService.getSafetyRating.mockResolvedValue(sampleRating);
    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ vehicleId: 14720, make: ' ', model: '\t' });
    const result = await getSafetyRatings.handler(input, ctx);
    expect(result.ratings).toEqual([sampleRating]);
    expect(mockService.getSafetyRatingVariants).not.toHaveBeenCalled();
  });

  it('trims vehicle criteria before variant lookup', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);
    await getSafetyRatings.handler(
      getSafetyRatings.input.parse({ make: ' Toyota ', model: ' Camry ', modelYear: 2020 }),
      createMockContext({ errors: getSafetyRatings.errors }),
    );
    expect(mockService.getSafetyRatingVariants).toHaveBeenCalledWith(
      2020,
      'Toyota',
      'Camry',
      expect.anything(),
    );
  });
  it('fetches ratings via variant lookup', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720, vehicleDescription: '2020 Toyota CAMRY FWD' },
    ]);
    mockService.getSafetyRating.mockResolvedValue(sampleRating);

    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toHaveLength(1);
    expect(result.ratings[0]!.overallRating).toBe('5');
    expect(result.ratings[0]!.frontalCrash.driverSide).toBe('4');
    expect(mockService.getSafetyRatingVariants).toHaveBeenCalledWith(
      2020,
      'Toyota',
      'Camry',
      expect.anything(),
    );
  });

  it('fetches rating by vehicleId directly', async () => {
    mockService.getSafetyRating.mockResolvedValue(sampleRating);

    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ vehicleId: 14720 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toHaveLength(1);
    expect(mockService.getSafetyRatingVariants).not.toHaveBeenCalled();
    expect(mockService.getSafetyRating).toHaveBeenCalledWith(14720, expect.anything());
  });

  it('rejects incomplete vehicle lookup input when vehicleId is omitted', async () => {
    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry' });

    await expect(getSafetyRatings.handler(input, ctx)).rejects.toThrow(
      /vehicleId.*make \+ model \+ modelYear/i,
    );
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

    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await getSafetyRatings.handler(input, ctx);
    const parsed = getSafetyRatings.output.parse(result);
    const text = firstText(getSafetyRatings.format!(parsed));

    expect(parsed.ratings).toHaveLength(1);
    expect(parsed.ratings[0]!.overallRating).toBeUndefined();
    expect(parsed.ratings[0]!.rollover.probability).toBeUndefined();
    expect(text).toContain('Vehicle 14720');
    expect(text).toContain('Not available');
  });

  it('returns empty and populates enrichment notice when no variants found', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);

    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ make: 'Fake', model: 'Car', modelYear: 1990 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toEqual([]);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no ncap crash test data/i);
    expect(notice).toContain('Fake Car 1990');
  });

  it('routes a zero-variant result to the model names NHTSA files the vehicle under (#47)', async () => {
    mockService.getSafetyRatingVariants.mockResolvedValue([]);

    const result = await runToolContract(getSafetyRatings, {
      make: 'Chevrolet',
      model: 'Silverado',
      modelYear: 2014,
    });

    const notice =
      'No NCAP crash test data for Chevrolet Silverado 2014. NCAP coverage starts from 1990, with best coverage for 2011+. Adjacent model years or a different trim or drivetrain may have ratings, or NHTSA may list them under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search ratings under each.';
    expect(result.structuredContent).toMatchObject({ ratings: [], notice });
    expect(readerText(result.content)).toContain(notice);
  });

  it('describes the ADAS values NCAP sends, "No" included', () => {
    const adas = getSafetyRatings.output.shape.ratings.element.shape.adasFeatures.shape;

    expect(Object.keys(adas)).toHaveLength(3);
    for (const field of Object.values(adas)) {
      expect(field.description).toContain('"Standard", "Optional", or "No"');
      expect(field.description).not.toContain('Not Available');
    }
  });

  it('populates enrichment notice when vehicleId not found', async () => {
    mockService.getSafetyRating.mockResolvedValue(null);

    const ctx = createMockContext({ errors: getSafetyRatings.errors });
    const input = getSafetyRatings.input.parse({ vehicleId: 99999 });
    const result = await getSafetyRatings.handler(input, ctx);

    expect(result.ratings).toEqual([]);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no ncap vehicle found for vehicleId 99999/i);
  });

  it('format renders star ratings', () => {
    const output = { ratings: [sampleRating] };
    const blocks = getSafetyRatings.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('2020 Toyota CAMRY FWD');
    expect(text).toContain('★');
    expect(text).toContain('No Tip');
    expect(text).toContain('Standard');
  });

  it('format handles no ratings', () => {
    const blocks = getSafetyRatings.format!({ ratings: [] });
    expect(firstText(blocks)).toContain('No NCAP safety ratings');
  });

  it('rejects a fractional modelYear rather than building a fractional path segment', () => {
    expect(() =>
      getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020.5 }),
    ).toThrow();
    expect(
      getSafetyRatings.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 }).modelYear,
    ).toBe(2020);
  });
});

/** The rendered markdown's variant (level-2) heading lines, as written. */
const variantHeadings = (blocks: readonly { type: string; text?: string }[]) =>
  firstText(blocks)
    .split('\n')
    .filter((line) => line.startsWith('## '));

/** Ratings take the `- ` and `# ` leads only: a digit-led value would take formatStars' numeric path. */
describe('getSafetyRatings — upstream text renders as itself (#59)', () => {
  it('reads back every upstream string in content[] as structuredContent carries it', async () => {
    const rating = {
      vehicleId: 14720,
      vehicleDescription: hostile('# ', 'description'),
      overallRating: hostile('- ', 'overall'),
      frontalCrash: {
        overall: hostile('# ', 'frontal'),
        driverSide: hostile('- ', 'frontalDriver'),
        passengerSide: hostile('# ', 'frontalPassenger'),
      },
      sideCrash: {
        overall: hostile('- ', 'side'),
        driverSide: hostile('# ', 'sideDriver'),
        passengerSide: hostile('- ', 'sidePassenger'),
        combinedBarrierPoleFront: hostile('# ', 'combinedFront'),
        combinedBarrierPoleRear: hostile('- ', 'combinedRear'),
        barrierOverall: hostile('# ', 'barrier'),
        pole: hostile('- ', 'pole'),
      },
      rollover: {
        rating: hostile('# ', 'rollover'),
        probability: 0.099,
        dynamicTipResult: hostile('- ', 'tip'),
      },
      adasFeatures: {
        electronicStabilityControl: hostile('# ', 'esc'),
        forwardCollisionWarning: hostile('- ', 'fcw'),
        laneDepartureWarning: hostile('# ', 'ldw'),
      },
      complaintsCount: 255,
      recallsCount: 3,
      investigationCount: 0,
    };
    mockService.getSafetyRating.mockResolvedValue(rating);

    const result = await runToolContract(getSafetyRatings, { vehicleId: 14720 });

    expect(result.structuredContent).toEqual({ ratings: [rating] });
    const { frontalCrash: front, sideCrash: side, rollover, adasFeatures: adas } = rating;
    expect(readerText([result.content[0]!])).toBe(
      [
        'Vehicle 14720',
        `Description: ${rating.vehicleDescription}`,
        `Overall: ${rating.overallRating}`,
        'Frontal Crash',
        `Overall: ${front.overall}`,
        `Driver: ${front.driverSide} | Passenger: ${front.passengerSide}`,
        'Side Crash',
        `Overall: ${side.overall}`,
        `Driver: ${side.driverSide} | Passenger: ${side.passengerSide}`,
        `Barrier: ${side.barrierOverall} | Pole: ${side.pole}`,
        `Combined Barrier/Pole — Front: ${side.combinedBarrierPoleFront} | Rear: ${side.combinedBarrierPoleRear}`,
        'Rollover',
        `Rating: ${rollover.rating}`,
        `Probability: 9.9% | Tip test: ${rollover.dynamicTipResult}`,
        'ADAS Features',
        `ESC: ${adas.electronicStabilityControl}`,
        `Forward Collision Warning: ${adas.forwardCollisionWarning}`,
        `Lane Departure Warning: ${adas.laneDepartureWarning}`,
        'Linked to this NCAP record only — Complaints: 255 | Recalls: 3 | Investigations: 0. Use nhtsa_search_complaints / nhtsa_search_recalls / nhtsa_search_investigations for vehicle-level totals.',
      ].join('\n'),
    );
  });

  it('builds each variant heading from vehicleId and puts the description on a labeled line', async () => {
    const description = '2020 Toyota CAMRY 4 DR FWD\n- *HYBRID* ###';
    mockService.getSafetyRatingVariants.mockResolvedValue([
      { vehicleId: 14720, vehicleDescription: description },
      { vehicleId: 14721 },
    ]);
    mockService.getSafetyRating.mockImplementation(async (vehicleId: number) =>
      vehicleId === 14720
        ? { ...sampleRating, vehicleDescription: description }
        : { ...sampleRating, vehicleId, vehicleDescription: undefined },
    );

    const result = await runToolContract(getSafetyRatings, {
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
    });

    expect(variantHeadings(result.content)).toEqual(['## Vehicle 14720', '## Vehicle 14721']);
    const lines = readerText([result.content[0]!]).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Vehicle 14720',
      'Description: 2020 Toyota CAMRY 4 DR FWD',
      '- *HYBRID* ###',
      'Overall: ★★★★★ (5/5)',
    ]);
    const second = lines.indexOf('Vehicle 14721');
    expect(lines.slice(second, second + 3)).toEqual([
      'Vehicle 14721',
      'Description: Not available',
      'Overall: ★★★★★ (5/5)',
    ]);
  });
});
