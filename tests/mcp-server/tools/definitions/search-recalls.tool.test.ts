/**
 * @fileoverview Tests for nhtsa_search_recalls tool.
 * @module tests/mcp-server/tools/definitions/search-recalls.tool
 */

import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

/** The server's clamp mode, flipped per test; the environment parsing has its own suite. */
const serverConfig = vi.hoisted(() => ({ clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => serverConfig }));

import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = {
  getRecallsByVehicle: vi.fn(),
  getRecallCampaigns: vi.fn(),
  searchRecallFiles: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
  mockService.searchRecallFiles.mockRejectedValue(new Error('unexpected recall-file search'));
  serverConfig.clampLimits = true;
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
  it('preserves missing record dates when blank bounds are unset', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([
      { ...sampleRecall, reportReceivedDate: '' },
    ]);
    const result = await runToolContract(searchRecalls, {
      make: ' Toyota ',
      model: ' Camry ',
      modelYear: 2020,
      campaignNumber: ' ',
      dateRange: { after: ' ', before: '' },
    });
    expect(result.structuredContent).toMatchObject({
      totalCount: 1,
      effectiveQuery: 'Toyota Camry 2020',
    });
    expect(mockService.getRecallsByVehicle).toHaveBeenCalledWith(
      'Toyota',
      'Camry',
      2020,
      expect.anything(),
    );
  });

  it('retains campaign_not_found with a valid active range', async () => {
    mockService.getRecallCampaigns.mockResolvedValue([]);
    const result = await runToolContract(searchRecalls, {
      campaignNumber: 'ZZZ999999',
      dateRange: { before: '2024-01-01' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'campaign_not_found' } },
    });
    expect(readerText(result.content)).toContain('Verify the campaign number');
  });
  it.each(['campaign', 'vehicle'])(
    'applies inclusive calendar bounds in %s mode (#35)',
    async (mode) => {
      mockService.getRecallCampaigns.mockResolvedValue([
        { ...sampleRecall, receivedDate: '2020-12-11', affectedVehicles: [] },
      ]);
      mockService.getRecallsByVehicle.mockResolvedValue([
        sampleRecall,
        { ...sampleRecall, reportReceivedDate: '' },
      ]);
      const key =
        mode === 'campaign'
          ? { campaignNumber: '20V682000' }
          : { make: 'Toyota', model: 'Camry', modelYear: 2020 };
      const included = await runToolContract(searchRecalls, {
        ...key,
        dateRange: { after: '2020-12-11', before: '2020-12-11' },
      });
      expect(included.isError).not.toBe(true);
      expect(included.structuredContent).toMatchObject({
        totalCount: 1,
        effectiveQuery: expect.stringContaining('2020-12-11'),
      });
      const excluded = await runToolContract(searchRecalls, {
        ...key,
        dateRange: { after: '2021-01-01' },
      });
      expect(excluded.structuredContent).toMatchObject({
        totalCount: 0,
        notice: expect.stringMatching(/date range/i),
      });
      expect(readerText(excluded.content)).toMatch(/date range/i);
      expect(readerText(excluded.content)).not.toContain('nhtsa_lookup_vehicles');
    },
  );

  it.each(['2025', '2025-02-30', '2025-01-01T00:00:00Z', 'not-a-date'])(
    'rejects %s before upstream (#35)',
    async (after) => {
      const result = await runToolContract(searchRecalls, {
        campaignNumber: '20V682000',
        dateRange: { after },
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'invalid_date',
            recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
          },
        },
      });
      expect(mockService.getRecallCampaigns).not.toHaveBeenCalled();
    },
  );

  it('rejects inverted bounds before upstream (#35)', async () => {
    const result = await runToolContract(searchRecalls, {
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: '2025-01-01', before: '2020-01-01' },
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'inverted_date_range' } },
    });
    expect(mockService.getRecallsByVehicle).not.toHaveBeenCalled();
  });
  it('searches by vehicle', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0]!.campaignNumber).toBe('20V682000');
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

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls[0]!.parkIt).toBeUndefined();
    expect(parsed.recalls[0]!.parkOutSide).toBeUndefined();
    expect(parsed.recalls[0]!.overTheAirUpdate).toBeUndefined();
  });

  it('searches by campaign number', async () => {
    mockService.getRecallCampaigns.mockResolvedValue([
      {
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
      },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ campaignNumber: '20V682000' });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0]!.potentialUnitsAffected).toBe(5000);
    expect(result.recalls[0]!.parkOutSide).toBe(true);
  });

  it('surfaces the full affected-vehicle list and the linked investigation for a campaign', async () => {
    const affectedVehicles = [
      { make: 'HONDA', model: 'CIVIC', modelYear: 2022 },
      { make: 'HONDA', model: 'CR-V', modelYear: 2023 },
      { make: 'ACURA', model: 'INTEGRA', modelYear: 2024 },
    ];
    mockService.getRecallCampaigns.mockResolvedValue([
      {
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
      },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ campaignNumber: '24V744000' });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    // One collapsed campaign record — not one row per vehicle, and not a hardcoded count.
    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls).toHaveLength(1);
    expect(parsed.recalls[0]!.affectedVehicles).toEqual(affectedVehicles);
    expect(parsed.recalls[0]!.investigationId).toBe('EA23003');

    const text = firstText(searchRecalls.format!(parsed));
    expect(text).toContain('2022 HONDA CIVIC');
    expect(text).toContain('2024 ACURA INTEGRA');
    expect(text).toContain('EA23003');
  });

  it('accepts missing advisory fields for campaign lookups', async () => {
    mockService.getRecallCampaigns.mockResolvedValue([
      {
        campaignNumber: '20V682000',
        manufacturer: 'Toyota',
        summary: 'Fuel leak.',
        consequence: 'Fire.',
        remedy: 'Replace.',
        receivedDate: '2020-11-12',
        potentialUnitsAffected: 5000,
        affectedVehicles: [],
      },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ campaignNumber: '20V682000' });
    const result = await searchRecalls.handler(input, ctx);
    const parsed = searchRecalls.output.parse(result);

    expect(parsed.totalCount).toBe(1);
    expect(parsed.recalls[0]!.parkIt).toBeUndefined();
    expect(parsed.recalls[0]!.parkOutSide).toBeUndefined();
    expect(parsed.recalls[0]!.overTheAirUpdate).toBeUndefined();
    expect(parsed.recalls[0]!.investigationId).toBeUndefined();
    expect(parsed.recalls[0]!.affectedVehicles).toEqual([]);
  });

  it('throws when campaign not found', async () => {
    mockService.getRecallCampaigns.mockResolvedValue([]);

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

  it('throws missing_required_combo when no lookup key or broad filter is given', async () => {
    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({});
    await expect(searchRecalls.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_required_combo' },
    });
  });

  it('filters by dateRange', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([
      { ...sampleRecall, reportReceivedDate: '2020-01-15' },
      { ...sampleRecall, campaignNumber: '21V100000', reportReceivedDate: '2021-06-15' },
      { ...sampleRecall, campaignNumber: '22V200000', reportReceivedDate: '2022-03-01' },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      dateRange: { after: '2021-01-01', before: '2022-01-01' },
    });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.recalls[0]!.campaignNumber).toBe('21V100000');
  });

  it('populates enrichment notice when no vehicle recalls found', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ make: 'Nope', model: 'Ghost', modelYear: 2023 });
    const result = await searchRecalls.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toBe(
      'No recalls found. This vehicle may have no recalls on file, or NHTSA may list them under another model name, such as a series name or a base name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search recalls under each.',
    );
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
    const text = firstText(blocks);
    expect(text).toContain('DO NOT DRIVE');
    expect(text).toContain('PARK OUTSIDE');
    expect(text).toContain('OTA update available');
    expect(text).toContain(
      '**Advisories:** Do not drive: yes | Park outside: yes | Over-the-air update: yes',
    );
  });

  it('format states present-false advisories instead of dropping them', () => {
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
          parkIt: false,
          parkOutSide: false,
          overTheAirUpdate: false,
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));

    expect(text).toContain(
      '**Advisories:** Do not drive: no | Park outside: no | Over-the-air update: no',
    );
    // The badge stays reserved for active alerts — an explicit "no" is not one.
    expect(text).not.toContain('DO NOT DRIVE');
    expect(text).not.toContain('PARK OUTSIDE');
  });

  it('format distinguishes advisories NHTSA never reported from explicit "no"', () => {
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
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));

    expect(text).toContain('**Advisories:** None reported by NHTSA');
  });

  it('format renders present-false advisories on a campaign-scoped recall too', () => {
    const output = {
      recalls: [
        {
          campaignNumber: '24V744000',
          manufacturer: 'Honda',
          summary: 'Gearbox may bind.',
          consequence: 'Crash risk.',
          remedy: 'Replace.',
          reportReceivedDate: '2024-10-03',
          potentialUnitsAffected: 1000,
          affectedVehicles: [{ make: 'HONDA', model: 'CIVIC', modelYear: 2022 }],
          parkIt: false,
          parkOutSide: false,
          overTheAirUpdate: true,
        },
      ],
      totalCount: 1,
    };
    const text = firstText(searchRecalls.format!(output));

    expect(text).toContain(
      '**Advisories:** Do not drive: no | Park outside: no | Over-the-air update: yes',
    );
  });
});

/** One campaign as the recall-file index returns it. */
const indexedRecall = {
  campaignNumber: '26V690000',
  manufacturer: 'Toyota Motor Engineering & Manufacturing',
  component: 'SEATS | STRUCTURE',
  summary: 'Seat backs may fail.',
  consequence: 'Injury risk.',
  remedy: 'Dealers will repair.',
  reportReceivedDate: '2026-10-20',
  potentialUnitsAffected: 1200,
  parkIt: false,
  parkOutSide: true,
};

type Envelope = {
  error: { code: number; message: string; data: { reason?: string; recovery?: { hint?: string } } };
};
const envelopeOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as Envelope).error;

function expectNoUpstreamWork(): void {
  expect(mockService.getRecallCampaigns).not.toHaveBeenCalled();
  expect(mockService.getRecallsByVehicle).not.toHaveBeenCalled();
  expect(mockService.searchRecallFiles).not.toHaveBeenCalled();
}

describe('searchRecalls — broad search (#37)', () => {
  it('searches the recall files by make and date bound, on both surfaces', async () => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [indexedRecall], totalCount: 42 });

    const result = await runToolContract(searchRecalls, {
      make: ' Toyota ',
      dateRange: { after: '2025-01-01' },
    });

    expect(mockService.searchRecallFiles).toHaveBeenCalledWith(
      {
        make: 'Toyota',
        model: undefined,
        modelYear: undefined,
        dateRange: { after: '2025-01-01', before: undefined },
        limit: 20,
        offset: 0,
      },
      expect.anything(),
    );
    expect(mockService.getRecallCampaigns).not.toHaveBeenCalled();
    expect(mockService.getRecallsByVehicle).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      recalls: [indexedRecall],
      totalCount: 42,
      returned: 1,
      offset: 0,
      limit: 20,
      effectiveQuery: 'make=TOYOTA dateRange(after=2025-01-01)',
    });
    const text = readerText(result.content);
    expect(text).toContain('42 recall(s) found');
    expect(text).toContain(
      'Page: returned 1 of 42, offset 0, limit 20, newest received date first',
    );
    expect(text).toContain('Use offset=1 to retrieve the next page.');
    expect(text).toContain('Component: SEATS | STRUCTURE');
    expect(text).toContain('Units Affected: 1200');
    expect(text).toContain('Advisories: Do not drive: no | Park outside: yes');
    expect(text).toContain('make=TOYOTA dateRange(after=2025-01-01)');
  });

  it.each([
    [{ model: 'Camry' }, { model: 'Camry' }, 'model=CAMRY'],
    [{ modelYear: 2020 }, { modelYear: 2020 }, 'modelYear=2020'],
    [
      { make: 'Toyota', model: 'Camry' },
      { make: 'Toyota', model: 'Camry' },
      'make=TOYOTA model=CAMRY',
    ],
    [
      { make: 'Toyota', modelYear: 2020, campaignNumber: ' ' },
      { make: 'Toyota', modelYear: 2020 },
      'make=TOYOTA modelYear=2020',
    ],
    [
      { dateRange: { before: '2009-12-31' } },
      { dateRange: { after: undefined, before: '2009-12-31' } },
      'dateRange(before=2009-12-31)',
    ],
  ])('routes %j to the recall files', async (args, query, effectiveQuery) => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [indexedRecall], totalCount: 1 });

    const result = await runToolContract(searchRecalls, args);

    expect(mockService.searchRecallFiles).toHaveBeenCalledWith(
      expect.objectContaining({ ...query, limit: 20, offset: 0 }),
      expect.anything(),
    );
    expect(mockService.getRecallsByVehicle).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ effectiveQuery, returned: 1 });
  });

  it('omits fields a campaign record leaves blank and renders them as not available', async () => {
    const sparse = {
      campaignNumber: '66V008001',
      manufacturer: 'CHRYSLER CORPORATION',
      reportReceivedDate: '1966-10-12',
    };
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [sparse], totalCount: 1 });

    const result = await runToolContract(searchRecalls, { dateRange: { before: '1966-12-31' } });

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { recalls: unknown[] }).recalls).toEqual([sparse]);
    const text = readerText(result.content);
    expect(text).toContain('Summary: Not available');
    expect(text).toContain('Consequence: Not available');
    expect(text).toContain('Remedy: Not available');
    expect(text).toContain('Advisories: None reported by NHTSA');
    expect(text).not.toContain('Units Affected');
    expect(text).not.toContain('Component');
  });

  it.each([
    {},
    { limit: 5 },
    { offset: 3 },
    { dateRange: { after: ' ', before: '' } },
    { make: '  ', model: '' },
  ])(
    'fails %j with missing_required_combo naming the broad filters, before upstream work',
    async (args) => {
      const result = await runToolContract(searchRecalls, args);

      expect(result.isError).toBe(true);
      const error = envelopeOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('missing_required_combo');
      expect(error.data.recovery?.hint).toBe(
        'Provide a campaignNumber, or at least one of make, model, modelYear, or a dateRange bound; make, model, and modelYear together look up one vehicle.',
      );
      expect(readerText(result.content)).toContain(
        'at least one of make, model, modelYear, or a dateRange bound',
      );
      expectNoUpstreamWork();
    },
  );

  it.each([
    { campaignNumber: '20V682000', limit: 5 },
    { campaignNumber: '20V682000', offset: 0 },
    { make: 'Toyota', model: 'Camry', modelYear: 2020, limit: 10 },
    { make: 'Toyota', model: 'Camry', modelYear: 2020, offset: 0 },
  ])('fails %j with mode_conflict before upstream work', async (args) => {
    const result = await runToolContract(searchRecalls, args);

    expect(result.isError).toBe(true);
    const error = envelopeOf(result);
    expect(error.data.reason).toBe('mode_conflict');
    expect(error.message).toBe(
      'limit and offset page a broad search only; a campaignNumber or full make + model + modelYear lookup returns every match at once.',
    );
    expect(error.data.recovery?.hint).toBe(
      'Drop limit and offset to get every match at once, or page a broad search instead: replace campaignNumber with make, model, modelYear, or a dateRange bound, or leave one of make, model, and modelYear out of a vehicle lookup.',
    );
    expect(readerText(result.content)).toContain('Drop limit and offset');
    expectNoUpstreamWork();
  });

  it('names the filters to relax when nothing matches', async () => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [], totalCount: 0 });

    const named = await runToolContract(searchRecalls, {
      make: 'Toyota',
      model: 'Camry',
      dateRange: { after: '2025-01-01' },
    });
    const yearOnly = await runToolContract(searchRecalls, { modelYear: 1901 });
    const modelOnly = await runToolContract(searchRecalls, { model: 'Silverado' });

    expect(named.structuredContent).toMatchObject({
      recalls: [],
      totalCount: 0,
      returned: 0,
      offset: 0,
      limit: 20,
      notice:
        "No recall campaign matches make, model, and dateRange. Relax or remove one of these filters. The make and model filters match whole names as NHTSA's recall records spell them, ignoring case, and NHTSA may file a vehicle's recalls under another model name, such as a series name or a base name.",
    });
    expect(yearOnly.structuredContent).toMatchObject({
      notice: 'No recall campaign matches modelYear. Relax or remove this filter.',
    });
    expect(modelOnly.structuredContent).toMatchObject({
      notice:
        "No recall campaign matches model. Relax or remove this filter. The make and model filters match whole names as NHTSA's recall records spell them, ignoring case, and NHTSA may file a vehicle's recalls under another model name, such as a series name or a base name.",
    });
    const text = readerText(named.content);
    expect(text).toContain('No recalls found matching the search criteria.');
    expect(text).toContain('Page: returned 0 of 0, offset 0, limit 20');
    expect(text).toContain('No recall campaign matches make, model, and dateRange.');
  });

  it('explains a page past the last match without a next-page hint', async () => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [], totalCount: 42 });

    const result = await runToolContract(searchRecalls, { make: 'Toyota', offset: 42 });

    expect(result.structuredContent).toMatchObject({
      recalls: [],
      totalCount: 42,
      returned: 0,
      offset: 42,
      limit: 20,
      notice: 'No results for this page (offset 42, limit 20). 42 total — try a smaller offset.',
    });
    const text = readerText(result.content);
    expect(text).toContain('Page: returned 0 of 42, offset 42, limit 20');
    expect(text).not.toContain('Use offset=');
  });

  it('lowers an over-maximum limit to 50 and leads the notice with it', async () => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [], totalCount: 42 });

    const result = await runToolContract(searchRecalls, { make: 'Toyota', limit: 51, offset: 60 });

    expect(mockService.searchRecallFiles).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 60 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      limit: 50,
      notice:
        'limit 51 exceeds the maximum of 50; returned 0. No results for this page (offset 60, limit 50). 42 total — try a smaller offset.',
    });
  });

  it('names the next offset in the clamp notice while matches remain', async () => {
    mockService.searchRecallFiles.mockResolvedValue({ recalls: [indexedRecall], totalCount: 42 });

    const result = await runToolContract(searchRecalls, { make: 'Toyota', limit: 1e21 });

    expect(result.structuredContent).toMatchObject({
      limit: 50,
      notice: 'limit 1e+21 exceeds the maximum of 50; returned 1 — continue at offset=1.',
    });
  });

  it('rejects an over-maximum limit with limit_too_large when clamping is off, before upstream work', async () => {
    serverConfig.clampLimits = false;

    const rejected = await runToolContract(searchRecalls, { make: 'Toyota', limit: 51 });

    const error = envelopeOf(rejected);
    expect(error.data.reason).toBe('limit_too_large');
    expect(error.message).toBe('limit 51 exceeds the maximum of 50.');
    expect(error.data.recovery?.hint).toBe(
      'Request a limit of 50 or less and page through the rest with offset.',
    );
    expectNoUpstreamWork();

    mockService.searchRecallFiles.mockResolvedValue({ recalls: [], totalCount: 0 });
    const atMax = await runToolContract(searchRecalls, { make: 'Toyota', limit: 50 });
    expect(atMax.structuredContent).toMatchObject({ limit: 50 });
  });

  it('rejects a limit below 1 or a negative offset at the schema', () => {
    expect(() => searchRecalls.input.parse({ make: 'Toyota', limit: 0 })).toThrow();
    expect(() => searchRecalls.input.parse({ make: 'Toyota', limit: 2.5 })).toThrow();
    expect(() => searchRecalls.input.parse({ make: 'Toyota', offset: -1 })).toThrow();
  });

  it('surfaces a recall-file load that timed out as the call error', async () => {
    mockService.searchRecallFiles.mockRejectedValue(
      timeout('Loading NHTSA recall data did not finish within 120 s.'),
    );

    const result = await runToolContract(searchRecalls, { make: 'Toyota' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).code).toBe(JsonRpcErrorCode.Timeout);
    expect(readerText(result.content)).toContain(
      'Loading NHTSA recall data did not finish within 120 s.',
    );
  });

  it('never reads the recall files for a campaignNumber or full vehicle lookup, and adds no paging fields', async () => {
    mockService.getRecallCampaigns.mockResolvedValue([
      {
        ...sampleRecall,
        receivedDate: '2020-12-11',
        potentialUnitsAffected: 5,
        affectedVehicles: [],
      },
    ]);
    mockService.getRecallsByVehicle.mockResolvedValue([sampleRecall]);

    const campaign = await runToolContract(searchRecalls, { campaignNumber: '20V682000' });
    const vehicle = await runToolContract(searchRecalls, {
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
    });

    expect(mockService.searchRecallFiles).not.toHaveBeenCalled();
    for (const result of [campaign, vehicle]) {
      expect(result.isError).not.toBe(true);
      expect(Object.keys(result.structuredContent as object).sort()).toEqual([
        'effectiveQuery',
        'recalls',
        'totalCount',
      ]);
      expect(readerText(result.content)).not.toContain('Page:');
    }
  });
});

describe('searchRecalls — campaign text NHTSA sends as null (#55)', () => {
  const fetchMock = vi.fn();
  /** 66V008001 for a 1967 Dodge Dart, as api.nhtsa.gov returns it: the campaign text is null. */
  const nullTextRow = {
    Manufacturer: 'CHRYSLER CORPORATION',
    NHTSACampaignNumber: '66V008001',
    parkIt: false,
    parkOutSide: false,
    overTheAirUpdate: false,
    ReportReceivedDate: '12/10/1966',
    Component: 'WHEELS',
    PotentialNumberofUnitsAffected: 1101,
    Summary: null,
    Consequence: null,
    Remedy: null,
    Notes: 'POSSIBLE INTERFERENCE BETWEEN THE FLANGE OF THE WHEEL DISC AND THE BRAKE DRUM.',
    ModelYear: '1967',
    Make: 'DODGE',
    Model: 'DART',
  };
  let row: Record<string, unknown> = nullTextRow;

  beforeEach(async () => {
    row = nullTextRow;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const { hostname, pathname } = new URL(url);
      if (
        hostname !== 'api.nhtsa.gov' ||
        (pathname !== '/recalls/campaignNumber' && pathname !== '/recalls/recallsByVehicle')
      ) {
        throw new Error('unmocked fetch');
      }
      return Response.json({
        Count: 1,
        Message: 'Results returned successfully',
        results: [row],
      });
    });
    const actual = await vi.importActual<typeof import('@/services/nhtsa/nhtsa-service.js')>(
      '@/services/nhtsa/nhtsa-service.js',
    );
    vi.mocked(getNhtsaService).mockReturnValue(new actual.NhtsaService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([[{ campaignNumber: '66V008001' }], [{ make: 'Dodge', model: 'Dart', modelYear: 1967 }]])(
    'returns the campaign for %j, omitting the null fields and rendering them as not available',
    async (args) => {
      const result = await runToolContract(searchRecalls, args);

      expect(result.isError).not.toBe(true);
      const [recall] = (result.structuredContent as { recalls: Record<string, unknown>[] }).recalls;
      expect(recall).toMatchObject({
        campaignNumber: '66V008001',
        manufacturer: 'CHRYSLER CORPORATION',
        component: 'WHEELS',
        reportReceivedDate: '1966-10-12',
      });
      for (const field of ['summary', 'consequence', 'remedy']) {
        expect(recall).not.toHaveProperty(field);
      }
      const text = readerText(result.content);
      expect(text).toContain('Summary: Not available');
      expect(text).toContain('Consequence: Not available');
      expect(text).toContain('Remedy: Not available');
      expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
    },
  );

  it('reports a campaign unit count when NHTSA sends one, and omits it when NHTSA does not', async () => {
    const counted = await runToolContract(searchRecalls, { campaignNumber: '66V008001' });
    const { PotentialNumberofUnitsAffected: _, ...uncountedRow } = nullTextRow;
    row = uncountedRow;
    const uncounted = await runToolContract(searchRecalls, { campaignNumber: '66V008001' });

    const recallOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { recalls: Record<string, unknown>[] }).recalls[0];
    expect(recallOf(counted)).toMatchObject({ potentialUnitsAffected: 1101 });
    expect(readerText(counted.content)).toContain('Units Affected: 1101');
    expect(uncounted.isError).not.toBe(true);
    expect(recallOf(uncounted)).not.toHaveProperty('potentialUnitsAffected');
    expect(readerText(uncounted.content)).not.toContain('Units Affected');
  });
});

describe('searchRecalls — campaign numbers through the campaignNumber endpoint (#57)', () => {
  const fetchMock = vi.fn();
  const fuelPump = {
    Manufacturer: 'Toyota Motor Engineering & Manufacturing',
    NHTSACampaignNumber: '20V682000',
    parkIt: false,
    parkOutSide: false,
    overTheAirUpdate: false,
    ReportReceivedDate: '04/11/2020',
    Component: 'FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP',
    PotentialNumberofUnitsAffected: 1_525_742,
    Summary: 'The low-pressure fuel pump inside the fuel tank may fail.',
    Consequence: 'If the fuel pump fails, the engine can stall while driving.',
    Remedy: 'Dealers will replace the fuel pump assembly, free of charge.',
    Notes: 'Owners may contact Toyota customer service.',
  };
  /** 20V682000 as the endpoint returns it: one row per vehicle, one of them repeated. */
  const fullNumberRows = [
    { ...fuelPump, ModelYear: '2020', Make: 'TOYOTA', Model: 'SIENNA' },
    { ...fuelPump, ModelYear: '2017', Make: 'LEXUS', Model: 'RX350' },
    { ...fuelPump, ModelYear: '2020', Make: 'TOYOTA', Model: 'SIENNA' },
    { ...fuelPump, ModelYear: '2019', Make: 'LEXUS', Model: 'GS300' },
  ];
  const ventHose = {
    parkIt: false,
    parkOutSide: false,
    overTheAirUpdate: false,
    NHTSAActionNumber: 'EA00015',
    Component: 'FUEL SYSTEM, GASOLINE:STORAGE:TANK ASSEMBLY',
    Summary: 'Cracks have developed in the fuel tank vent hose.',
    Consequence: 'Fuel leakage in the presence of an ignition source can result in a fire.',
    Remedy: 'Dealers will replace the vent hose.',
    Make: 'MERCURY',
    Model: 'VILLAGER',
  };
  const ford = {
    ...ventHose,
    Manufacturer: 'FORD MOTOR COMPANY',
    NHTSACampaignNumber: '00V419002',
    ReportReceivedDate: '02/01/2001',
    PotentialNumberofUnitsAffected: 394_000,
  };
  const nissan = {
    ...ventHose,
    Manufacturer: 'NISSAN NORTH AMERICA, INC.',
    NHTSACampaignNumber: '00V419001',
    ReportReceivedDate: '15/12/2000',
    PotentialNumberofUnitsAffected: 268_229,
  };
  /** 00V419 as the endpoint returns it: the rows of both campaigns it prefixes, interleaved. */
  const prefixRows = [
    { ...ford, ModelYear: '1993' },
    { ...nissan, ModelYear: '1993' },
    { ...ford, ModelYear: '1994' },
    { ...nissan, ModelYear: '1994' },
  ];
  const rowsByNumber = new Map<string, unknown[]>([
    ['20V682000', fullNumberRows],
    ['00V419', prefixRows],
  ]);

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const { hostname, pathname, searchParams } = new URL(url);
      if (hostname !== 'api.nhtsa.gov' || pathname !== '/recalls/campaignNumber') {
        throw new Error('unmocked fetch');
      }
      const results = rowsByNumber.get(searchParams.get('campaignNumber') ?? '') ?? [];
      return Response.json({
        Count: results.length,
        Message: 'Results returned successfully',
        results,
      });
    });
    const actual = await vi.importActual<typeof import('@/services/nhtsa/nhtsa-service.js')>(
      '@/services/nhtsa/nhtsa-service.js',
    );
    vi.mocked(getNhtsaService).mockReturnValue(new actual.NhtsaService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const villager = (modelYear: number) => ({ make: 'MERCURY', model: 'VILLAGER', modelYear });
  const ventHoseRecall = {
    component: 'FUEL SYSTEM, GASOLINE:STORAGE:TANK ASSEMBLY',
    summary: 'Cracks have developed in the fuel tank vent hose.',
    consequence: 'Fuel leakage in the presence of an ignition source can result in a fire.',
    remedy: 'Dealers will replace the vent hose.',
    affectedVehicles: [villager(1993), villager(1994)],
    investigationId: 'EA00015',
    parkIt: false,
    parkOutSide: false,
    overTheAirUpdate: false,
  };
  const nissanRecall = {
    campaignNumber: '00V419001',
    manufacturer: 'NISSAN NORTH AMERICA, INC.',
    reportReceivedDate: '2000-12-15',
    potentialUnitsAffected: 268_229,
    ...ventHoseRecall,
  };
  const fordRecall = {
    campaignNumber: '00V419002',
    manufacturer: 'FORD MOTOR COMPANY',
    reportReceivedDate: '2001-01-02',
    potentialUnitsAffected: 394_000,
    ...ventHoseRecall,
  };

  it('returns a full campaign number as one campaign on both surfaces', async () => {
    const result = await runToolContract(searchRecalls, { campaignNumber: '20V682000' });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      recalls: [
        {
          campaignNumber: '20V682000',
          manufacturer: 'Toyota Motor Engineering & Manufacturing',
          component: 'FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP',
          summary: 'The low-pressure fuel pump inside the fuel tank may fail.',
          consequence: 'If the fuel pump fails, the engine can stall while driving.',
          remedy: 'Dealers will replace the fuel pump assembly, free of charge.',
          reportReceivedDate: '2020-11-04',
          potentialUnitsAffected: 1_525_742,
          affectedVehicles: [
            { make: 'TOYOTA', model: 'SIENNA', modelYear: 2020 },
            { make: 'LEXUS', model: 'RX350', modelYear: 2017 },
            { make: 'LEXUS', model: 'GS300', modelYear: 2019 },
          ],
          parkIt: false,
          parkOutSide: false,
          overTheAirUpdate: false,
        },
      ],
      totalCount: 1,
      effectiveQuery: '20V682000',
    });
    expect(readerText(result.content)).toBe(
      [
        '1 recall(s) found',
        '20V682000',
        'Component: FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP',
        'Units Affected: 1525742',
        'Date: 2020-11-04',
        'Manufacturer: Toyota Motor Engineering & Manufacturing',
        'Advisories: Do not drive: no | Park outside: no | Over-the-air update: no',
        'Affected Vehicles (3):',
        '2020 TOYOTA SIENNA',
        '2017 LEXUS RX350',
        '2019 LEXUS GS300',
        'The low-pressure fuel pump inside the fuel tank may fail.',
        'Consequence: If the fuel pump fails, the engine can stall while driving.',
        'Remedy: Dealers will replace the fuel pump assembly, free of charge.',
        'effectiveQuery: 20V682000',
      ].join('\n'),
    );
  });

  it('returns every campaign a 6-character number covers, each from its own rows', async () => {
    const result = await runToolContract(searchRecalls, { campaignNumber: '00V419' });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toStrictEqual({
      recalls: [nissanRecall, fordRecall],
      totalCount: 2,
      effectiveQuery: '00V419',
    });
    const text = readerText(result.content);
    expect(text).toContain('2 recall(s) found');
    const nissanAt = text.indexOf('00V419001\nComponent:');
    const fordAt = text.indexOf('00V419002\nComponent:');
    expect(nissanAt).toBeGreaterThan(-1);
    expect(fordAt).toBeGreaterThan(nissanAt);
    expect(text.slice(nissanAt, fordAt)).toContain(
      'Units Affected: 268229\nDate: 2000-12-15\nManufacturer: NISSAN NORTH AMERICA, INC.',
    );
    expect(text.slice(fordAt)).toContain(
      'Units Affected: 394000\nDate: 2001-01-02\nManufacturer: FORD MOTOR COMPANY',
    );
  });

  it.each([
    [{ before: '2000-12-31' }, ['00V419001']],
    [{ after: '2001-01-01' }, ['00V419002']],
    [{ after: '2000-12-15', before: '2001-01-02' }, ['00V419001', '00V419002']],
  ])('applies dateRange %j to each campaign separately', async (dateRange, campaigns) => {
    const result = await runToolContract(searchRecalls, { campaignNumber: '00V419', dateRange });

    expect(result.isError).not.toBe(true);
    const { recalls, totalCount } = result.structuredContent as {
      recalls: { campaignNumber: string }[];
      totalCount: number;
    };
    expect(recalls.map((recall) => recall.campaignNumber)).toStrictEqual(campaigns);
    expect(totalCount).toBe(campaigns.length);
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(readerText(result.content)).toContain(`${campaigns.length} recall(s) found`);
  });

  it('names how many campaigns a number covers when the date range excludes all of them', async () => {
    const result = await runToolContract(searchRecalls, {
      campaignNumber: '00V419',
      dateRange: { after: '2001-02-01' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      recalls: [],
      totalCount: 0,
      notice:
        'The campaign number covers 2 campaigns, but none match the date range. Broaden or remove the date bounds.',
    });
    expect(readerText(result.content)).toContain(
      'The campaign number covers 2 campaigns, but none match the date range.',
    );
  });

  it('keeps the single-campaign notice when a full number falls outside the date range', async () => {
    const result = await runToolContract(searchRecalls, {
      campaignNumber: '20V682000',
      dateRange: { before: '2020-11-03' },
    });

    expect(result.structuredContent).toMatchObject({
      recalls: [],
      totalCount: 0,
      notice:
        'The campaign exists, but no recalls match the date range. Broaden or remove the date bounds.',
    });
  });

  it('fails with campaign_not_found when the endpoint returns no rows', async () => {
    const result = await runToolContract(searchRecalls, { campaignNumber: '99V999' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'campaign_not_found' } },
    });
    expect(readerText(result.content)).toContain('No recall found for campaign "99V999".');
  });
});
