/**
 * @fileoverview Additional edge-case and security tests for nhtsa_search_recalls.
 * @module tests/mcp-server/tools/definitions/search-recalls-edge.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

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
};

describe('searchRecalls — date filtering', () => {
  it('throws invalid_date when after is not a valid date string', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: 'not-a-date' },
    });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/invalid date/i);
  });

  it('throws invalid_date when before is not a valid date string', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { before: 'garbage' },
    });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow(/invalid date/i);
  });

  it('accepts form-client empty-string dateRange (both bounds empty)', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    // Form clients may submit dateRange with empty string values instead of omitting it
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: '', before: '' },
    });
    const result = await searchRecalls.handler(input, ctx);
    // Empty strings are falsy — no filtering applied, all recalls returned
    expect(result.totalCount).toBe(1);
  });

  it('filters to only recalls within a date range (inclusive boundary)', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([
      { ...sampleRecall, reportReceivedDate: '2020-12-11' },
      { ...sampleRecall, campaignNumber: '21V100000', reportReceivedDate: '2021-06-15' },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: '2021-01-01', before: '2021-12-31' },
    });
    const result = await searchRecalls.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.recalls[0]!.campaignNumber).toBe('21V100000');
  });
});

describe('searchRecalls — format', () => {
  it('format renders campaign with units affected, vehicle list, and investigation link', () => {
    const output = {
      recalls: [
        {
          campaignNumber: '20V682000',
          manufacturer: 'Toyota',
          summary: 'Leak.',
          consequence: 'Fire.',
          remedy: 'Replace.',
          reportReceivedDate: '2020-11-12',
          potentialUnitsAffected: 5000,
          investigationId: 'EA23003',
          affectedVehicles: [
            { make: 'TOYOTA', model: 'CAMRY', modelYear: 2020 },
            { make: 'TOYOTA', model: 'AVALON', modelYear: 2021 },
          ],
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));
    expect(text).toContain('Units Affected:** 5000');
    expect(text).toContain('Affected Vehicles (2)');
    expect(text).toContain('2020 TOYOTA CAMRY');
    expect(text).toContain('2021 TOYOTA AVALON');
    expect(text).toContain('EA23003');
    expect(text).toContain('nhtsa_search_investigations');
  });

  it('format omits the vehicle list for an equipment campaign with no vehicles', () => {
    const output = {
      recalls: [
        {
          campaignNumber: '20E123000',
          manufacturer: 'Equipment Co',
          summary: 'Latch defect.',
          consequence: 'Injury risk.',
          remedy: 'Replace latch.',
          reportReceivedDate: '2020-11-12',
          potentialUnitsAffected: 100,
          affectedVehicles: [],
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));
    expect(text).not.toContain('Affected Vehicles');
    expect(text).not.toContain('Investigation:');
    expect(text).toContain('20E123000');
  });

  it('format renders "No recalls found" when totalCount is 0', () => {
    const blocks = searchRecalls.format!({ recalls: [], totalCount: 0 });
    expect(firstText(blocks)).toContain('No recalls found');
  });

  it('format renders recall without optional alert badges when flags absent', () => {
    const output = {
      recalls: [
        {
          campaignNumber: '20V682000',
          manufacturer: 'Toyota',
          component: 'FUEL',
          summary: 'Leak.',
          consequence: 'Fire.',
          remedy: 'Replace.',
          reportReceivedDate: '2020-11-12',
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));
    expect(text).not.toContain('DO NOT DRIVE');
    expect(text).not.toContain('PARK OUTSIDE');
    expect(text).toContain('20V682000');
    expect(text).toContain('**Advisories:** None reported by NHTSA');
  });
});

describe('searchRecalls — input schema validation', () => {
  it('rejects a fractional modelYear rather than sending it upstream', () => {
    expect(() =>
      searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020.5 }),
    ).toThrow();
    expect(
      searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 }).modelYear,
    ).toBe(2020);
  });
});
