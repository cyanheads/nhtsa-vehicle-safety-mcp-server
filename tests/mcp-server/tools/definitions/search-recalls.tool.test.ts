/**
 * @fileoverview Tests for nhtsa_search_recalls tool.
 * @module tests/mcp-server/tools/definitions/search-recalls.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(mockService.getRecallsByVehicle).toHaveBeenCalledWith('Toyota', 'Camry', 2020);
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
      subject: 'Fuel pipe',
      summary: 'Fuel leak.',
      consequence: 'Fire.',
      remedy: 'Replace.',
      receivedDate: '2020-11-12',
      potentialUnitsAffected: 5000,
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

  it('accepts missing advisory fields for campaign lookups', async () => {
    mockService.getRecallCampaign.mockResolvedValue({
      campaignNumber: '20V682000',
      manufacturer: 'Toyota',
      subject: 'Fuel pipe',
      summary: 'Fuel leak.',
      consequence: 'Fire.',
      remedy: 'Replace.',
      receivedDate: '2020-11-12',
      potentialUnitsAffected: 5000,
    });

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ campaignNumber: '20V682000' });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls[0].parkIt).toBeUndefined();
    expect(parsed.recalls[0].parkOutSide).toBeUndefined();
    expect(parsed.recalls[0].overTheAirUpdate).toBeUndefined();
  });

  it('throws when campaign not found', async () => {
    mockService.getRecallCampaign.mockResolvedValue(null);

    const ctx = createMockContext();
    const input = searchRecalls.input.parse({ campaignNumber: 'ZZZ999999' });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/no recall found/i);
  });

  it('throws when both campaignNumber and vehicle params provided', async () => {
    const ctx = createMockContext();
    const input = searchRecalls.input.parse({
      campaignNumber: '20V682000',
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
    });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/either campaignNumber OR/i);
  });

  it('throws when vehicle params incomplete', async () => {
    const ctx = createMockContext();
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
