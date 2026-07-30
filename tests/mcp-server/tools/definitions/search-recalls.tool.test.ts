/**
 * @fileoverview Tests for nhtsa_search_recalls tool.
 * @module tests/mcp-server/tools/definitions/search-recalls.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const mockService = {
  getRecallsByVehicle: vi.fn(),
  getRecallCampaign: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

const sampleRecall = {
  campaignNumber: '20V682000',
  manufacturer: 'Toyota',
  component: 'FUEL SYSTEM',
  summary: 'Fuel leak.',
  consequence: 'Fire risk.',
  remedy: 'Replace pipe.',
  reportReceivedDate: '2020-12-11',
  parkIt: false,
  parkOutSide: false,
  overTheAirUpdate: false,
};

describe('searchRecalls', () => {
  it('searches by vehicle', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0].campaignNumber).toBe('20V682000');
    expect(mockService.getRecallsByVehicle).toHaveBeenCalledWith(
      'Toyota',
      'Camry',
      2020,
      expect.anything(),
    );
    expect(getEnrichment(ctx).effectiveQuery).toBe('Toyota Camry 2020');
  });

  it('accepts missing advisory fields for vehicle recalls', async () => {
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

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls[0].parkIt).toBeUndefined();
    expect(parsed.recalls[0].parkOutSide).toBeUndefined();
    expect(parsed.recalls[0].overTheAirUpdate).toBeUndefined();
  });

  it('searches by campaign number', async () => {
    mockService.getRecallCampaign.mockResolvedValue({
      campaignNumber: '20V682000',
      manufacturer: 'Toyota',
      summary: 'Fuel leak.',
      consequence: 'Fire.',
      remedy: 'Replace.',
      receivedDate: '2020-11-12',
      potentialUnitsAffected: 5000,
      affectedVehicles: [{ make: 'TOYOTA', model: 'CAMRY', modelYear: 2020 }],
      parkIt: false,
      parkOutSide: true,
      overTheAirUpdate: false,
    });

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ campaignNumber: '20V682000' });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0].potentialUnitsAffected).toBe(5000);
    expect(result.recalls[0].parkOutSide).toBe(true);
  });

  it('surfaces the full affected-vehicle list and the linked investigation for a campaign', async () => {
    const affectedVehicles = [
      { make: 'HONDA', model: 'CIVIC', modelYear: 2022 },
      { make: 'HONDA', model: 'CR-V', modelYear: 2023 },
      { make: 'ACURA', model: 'INTEGRA', modelYear: 2024 },
    ];
    mockService.getRecallCampaign.mockResolvedValue({
      campaignNumber: '24V744000',
      manufacturer: 'Honda (American Honda Motor Co.)',
      component: 'STEERING',
      summary: 'Steering gearbox may bind.',
      consequence: 'Crash risk.',
      remedy: 'Replace the gearbox.',
      receivedDate: '2024-10-03',
      potentialUnitsAffected: 1_693_199,
      investigationId: 'EA23003',
      affectedVehicles,
    });

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ campaignNumber: '24V744000' });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    // One collapsed campaign record — not one row per vehicle, and not a hardcoded count.
    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls).toHaveLength(1);
    expect(parsed.recalls[0].affectedVehicles).toEqual(affectedVehicles);
    expect(parsed.recalls[0].investigationId).toBe('EA23003');

    const text = searchRecalls.format!(parsed)[0].text;
    expect(text).toContain('2022 HONDA CIVIC');
    expect(text).toContain('2024 ACURA INTEGRA');
    expect(text).toContain('EA23003');
  });

  it('accepts missing advisory fields for campaign lookups', async () => {
    mockService.getRecallCampaign.mockResolvedValue({
      campaignNumber: '20V682000',
      manufacturer: 'Toyota',
      summary: 'Fuel leak.',
      consequence: 'Fire.',
      remedy: 'Replace.',
      receivedDate: '2020-11-12',
      potentialUnitsAffected: 5000,
      affectedVehicles: [],
    });

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ campaignNumber: '20V682000' });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls[0].parkIt).toBeUndefined();
    expect(parsed.recalls[0].parkOutSide).toBeUndefined();
    expect(parsed.recalls[0].overTheAirUpdate).toBeUndefined();
    expect(parsed.recalls[0].investigationId).toBeUndefined();
    expect(parsed.recalls[0].affectedVehicles).toEqual([]);
  });

  it('throws when campaign not found', async () => {
    mockService.getRecallCampaign.mockResolvedValue(null);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ campaignNumber: 'ZZZ999999' });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/no recall found/i);
  });

  it('throws when both campaignNumber and vehicle params provided', async () => {
    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      campaignNumber: '20V682000',
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
    });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/either campaignNumber OR/i);
  });

  it('throws when vehicle params incomplete', async () => {
    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ make: 'Toyota' });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/campaignNumber/i);
  });

  it('filters by dateRange', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([
      { ...sampleRecall, reportReceivedDate: '2020-01-15' },
      { ...sampleRecall, campaignNumber: '21V100000', reportReceivedDate: '2021-06-15' },
      { ...sampleRecall, campaignNumber: '22V200000', reportReceivedDate: '2022-03-01' },
    ]);

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: '2021-01-01', before: '2022-01-01' },
    });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0].campaignNumber).toBe('21V100000');
  });

  it('populates enrichment notice when no vehicle recalls found', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ make: 'Nope', model: 'Ghost', modelYear: 2023 });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/nhtsa_lookup_vehicles/i);
  });

  it('format renders alert badges', () => {
    const output = {
      recalls: [
        {
          campaignNumber: '20V682000',
          manufacturer: 'Toyota',
          component: 'FUEL',
          summary: 'Leak.',
          consequence: 'Fire.',
          remedy: 'Fix.',
          reportReceivedDate: '2020-11-12',
          parkIt: true,
          parkOutSide: true,
          overTheAirUpdate: true,
        },
      ],
      totalCount: 1,
    };
    const blocks = searchRecalls.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('DO NOT DRIVE');
    expect(text).toContain('PARK OUTSIDE');
    expect(text).toContain('OTA update available');
  });
});
