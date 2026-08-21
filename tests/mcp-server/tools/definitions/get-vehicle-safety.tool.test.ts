/**
 * @fileoverview Tests for nhtsa_get_vehicle_safety tool.
 * @module tests/mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { getVehicleSafety } from '@/mcp-server/tools/definitions/get-vehicle-safety.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

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
    expect(enrichment.notice).toMatch(/nhtsa_lookup_vehicles/i);
  });

  it('omits the lookup notice when a section returned data', async () => {
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

    expect(getEnrichment(ctx).notice).toBeUndefined();
    /**
     * No notice fires here, so the empty NCAP array is the only thing telling a
     * structured-only consumer the vehicle has no crash test coverage.
     */
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
