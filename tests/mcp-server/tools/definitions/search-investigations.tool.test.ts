/**
 * @fileoverview Tests for nhtsa_search_investigations tool.
 * @module tests/mcp-server/tools/definitions/search-investigations.tool
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

/** The server's clamp mode, flipped per test; the environment parsing has its own suite. */
const serverConfig = vi.hoisted(() => ({ clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => serverConfig }));

import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Investigation } from '@/services/nhtsa/types.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = { getInvestigations: vi.fn() };

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  mockService.getInvestigations.mockReset();
  serverConfig.clampLimits = true;
});

const sampleInvestigations: Investigation[] = [
  {
    nhtsaId: 'PE20001',
    investigationType: 'PE',
    status: 'O',
    makes: ['TOYOTA'],
    models: ['CAMRY'],
    years: [2020],
    components: ['BRAKES'],
    subject: 'Toyota Camry brake failure',
    summary: 'Reports of brake failure in 2020 Toyota Camry vehicles.',
    openDate: '2023-01-15',
    vehicles: [{ make: 'TOYOTA', model: 'CAMRY', year: 2020 }],
  },
  {
    nhtsaId: 'EA21002',
    investigationType: 'EA',
    status: 'C',
    makes: ['HONDA'],
    models: ['CIVIC'],
    years: [2021],
    components: ['ENGINE'],
    subject: 'Honda Civic engine stall',
    summary: 'Engine stalling in 2021 Honda Civic.',
    openDate: '2022-05-01',
    closeDate: '2023-01-01',
    vehicles: [{ make: 'HONDA', model: 'CIVIC', year: 2021 }],
  },
  {
    nhtsaId: 'PE22003',
    investigationType: 'PE',
    status: 'O',
    makes: ['FORD'],
    models: ['F-150'],
    years: [2022],
    components: ['TRANSMISSION'],
    subject: 'Ford F-150 transmission',
    summary: 'Transmission issues in Ford F-150.',
    openDate: '2024-01-01',
    vehicles: [{ make: 'FORD', model: 'F-150', year: 2022 }],
  },
];

/** `count` summarized investigations, as the loader would hand them over. */
function manyInvestigations(count: number): Investigation[] {
  return Array.from({ length: count }, (_, i) => ({
    nhtsaId: `PE${String(90_000 - i).padStart(5, '0')}`,
    investigationType: 'PE',
    status: 'O',
    subject: `Subject ${i}`,
    summary: `Summary ${i}`,
    vehicles: [],
  }));
}

describe('searchInvestigations', () => {
  it.each([{}, { after: ' ', before: '\t' }])(
    'allows inactive date range %j with exact ID',
    async (range) => {
      mockService.getInvestigations.mockResolvedValue(sampleInvestigations);
      const result = await runToolContract(searchInvestigations, {
        nhtsaId: ' EA21002 ',
        openDateRange: range,
        closeDateRange: range,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        investigations: [{ nhtsaId: 'EA21002' }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('DateRange');
    },
  );

  it.each(['openDateRange', 'closeDateRange'] as const)(
    'wires invalid/inverted %s recovery before loading',
    async (field) => {
      for (const [range, reason] of [
        [{ after: '2025-02-29' }, 'invalid_date'],
        [{ after: '2025-01-01', before: '2020-01-01' }, 'inverted_date_range'],
      ] as const) {
        const result = await runToolContract(searchInvestigations, { [field]: range });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason, recovery: { hint: expect.any(String) } } },
        });
        expect(readerText(result.content)).toContain(field);
        expect(mockService.getInvestigations).not.toHaveBeenCalled();
      }
    },
  );

  it('distinguishes dated zero matches from a past-end filtered page', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);
    const empty = await runToolContract(searchInvestigations, {
      openDateRange: { after: '2030-01-01' },
    });
    expect(empty.structuredContent).toMatchObject({
      totalCount: 0,
      returned: 0,
      notice: expect.stringContaining('removing a filter'),
    });
    const past = await runToolContract(searchInvestigations, {
      closeDateRange: { before: '2023-01-01' },
      offset: 1,
    });
    expect(past.structuredContent).toMatchObject({
      totalCount: 1,
      returned: 0,
      notice: expect.stringContaining('try a smaller offset'),
    });
    expect(readerText(past.content)).not.toContain('Try broadening');
  });
  it('filters both date ranges before count/page and ANDs status (#38)', async () => {
    mockService.getInvestigations.mockResolvedValue([
      ...sampleInvestigations,
      { ...sampleInvestigations[1], nhtsaId: 'EA21003', closeDate: '2023-01-02' },
      { ...sampleInvestigations[1], nhtsaId: 'EA21004', closeDate: undefined },
      { ...sampleInvestigations[1], nhtsaId: 'EA21005', openDate: 'bad-date' },
    ]);
    const result = await runToolContract(searchInvestigations, {
      status: 'C',
      openDateRange: { after: '2022-05-01', before: '2022-05-01' },
      closeDateRange: { after: '2023-01-01', before: '2023-01-02' },
      limit: 1,
      offset: 1,
    } as never);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      returned: 1,
      investigations: [{ nhtsaId: 'EA21003' }],
      effectiveQuery: expect.stringContaining('closeDateRange'),
    });
    expect(readerText(result.content)).toContain('EA21003');
  });

  it('rejects exact-ID date conflicts before loading (#38)', async () => {
    const result = await runToolContract(searchInvestigations, {
      nhtsaId: 'EA21002',
      closeDateRange: { after: '2020-01-01' },
    } as never);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'mode_conflict' } },
    });
    expect(mockService.getInvestigations).not.toHaveBeenCalled();
  });

  it('assembles one past-end recovery sentence (#39)', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);
    const result = await runToolContract(searchInvestigations, { offset: 999 });
    const text = readerText(result.content);
    expect(text.split('try a smaller offset').length - 1).toBe(1);
    expect(result.structuredContent).toMatchObject({
      totalCount: 3,
      returned: 0,
      notice: expect.stringContaining('try a smaller offset'),
    });
  });
  it('returns all investigations when no filters and populates effectiveQuery', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.investigations).toHaveLength(3);
    expect(getEnrichment(ctx).effectiveQuery).toBe('(all)');
  });

  it('filters by investigationType', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ investigationType: 'PE' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(2);
    expect(result.investigations).toHaveLength(2);
    expect(result.investigations.every((i) => i.investigationType === 'PE')).toBe(true);
  });

  it('filters by status', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ status: 'C' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('EA21002');
  });

  it('filters by make (structured makes[] match)', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ make: 'Toyota' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('PE20001');
  });

  it('fetches one investigation by exact nhtsaId, case-insensitively', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ nhtsaId: 'ea21002' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('EA21002');
    expect(getEnrichment(ctx).effectiveQuery).toContain('nhtsaId="ea21002"');
  });

  it('nhtsaId matches the whole ID, not a prefix or substring', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ nhtsaId: 'EA21' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/no investigation has the id/i);
  });

  it('rejects nhtsaId combined with another filter instead of silently dropping it', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ nhtsaId: 'EA21002', make: 'Toyota' });
    await expect(searchInvestigations.handler(input, ctx)).rejects.toThrow(/either nhtsaId/i);
    expect(mockService.getInvestigations).not.toHaveBeenCalled();
  });

  it('allows nhtsaId alongside pagination arguments', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ nhtsaId: 'EA21002', limit: 5, offset: 0 });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.limit).toBe(5);
  });

  it('free-text query matches an investigation ID that its own text never names', async () => {
    mockService.getInvestigations.mockResolvedValue([
      ...sampleInvestigations,
      {
        nhtsaId: 'AQ25001',
        investigationType: 'AQ',
        status: 'O',
        makes: ['KIA'],
        models: ['TELLURIDE'],
        years: [2025],
        components: ['ELECTRICAL SYSTEM'],
        subject: 'Audit query',
        summary: 'Summary that never quotes its own identifier.',
        openDate: '2025-02-01',
      },
    ]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ query: 'AQ25001' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('AQ25001');
  });

  it('filters by query (text match against subject/summary)', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ query: 'transmission' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('PE22003');
  });

  it('paginates with offset/limit and echoes the pagination state', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ limit: 1, offset: 1 });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.investigations).toHaveLength(1);
    expect(result.investigations[0]!.nhtsaId).toBe('EA21002');
    expect(result.returned).toBe(1);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(1);
  });

  it('echoes default pagination values when limit/offset are omitted', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.returned).toBe(3);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(20);
  });

  it('returns investigation type names', async () => {
    mockService.getInvestigations.mockResolvedValue([
      ...sampleInvestigations,
      {
        nhtsaId: 'AQ25002',
        investigationType: 'AQ',
        status: 'O',
        makes: ['TESLA'],
        models: ['MODEL Y'],
        years: [2023],
        components: ['ADAS'],
        subject: 'Tesla ADAS audit query',
        summary: 'NHTSA is opening this Audit Query.',
        openDate: '2025-01-01',
      },
    ]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    const pe = result.investigations.find((i) => i.investigationType === 'PE');
    expect(pe?.investigationTypeName).toBe('Preliminary Evaluation');
    const ea = result.investigations.find((i) => i.investigationType === 'EA');
    expect(ea?.investigationTypeName).toBe('Engineering Analysis');
    const aq = result.investigations.find((i) => i.investigationType === 'AQ');
    expect(aq?.investigationTypeName).toBe('Audit Query');
  });

  it('falls back to raw code for unmapped investigation types', async () => {
    mockService.getInvestigations.mockResolvedValue([
      {
        nhtsaId: 'SQ00012',
        investigationType: 'SQ',
        status: 'O',
        makes: ['GM'],
        models: ['MALIBU'],
        years: [2000],
        components: ['ENGINE'],
        subject: 'SQ subject',
        summary: 'SQ summary.',
        openDate: '2000-01-01',
      },
      {
        nhtsaId: 'C85001',
        investigationType: 'C',
        status: 'C',
        makes: ['FORD'],
        models: ['PINTO'],
        years: [1985],
        components: ['FUEL SYSTEM'],
        openDate: '1985-06-01',
        closeDate: '1985-12-01',
      },
    ]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    const sq = result.investigations.find((i) => i.investigationType === 'SQ');
    expect(sq?.investigationTypeName).toBe('SQ');
    const c = result.investigations.find((i) => i.investigationType === 'C');
    expect(c?.investigationTypeName).toBe('C');
  });

  it('populates enrichment notice when no investigations match filters', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ make: 'Nonexistent Brand XYZ' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no investigations matched/i);
  });

  it('notices an offset past the end of a non-empty result set', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ limit: 5, offset: 9000 });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.returned).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('offset 9000');
    expect(notice).toContain('limit 5');
    expect(notice).toContain('3 total');
    expect(notice).toMatch(/try a smaller offset/i);
    // Not the no-matches notice — the filters did match.
    expect(notice).not.toMatch(/try broadening/i);
  });

  it('keeps the no-matches notice when the filters matched nothing', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ make: 'Nonexistent Brand XYZ', offset: 9000 });
    await searchInvestigations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toMatch(/no investigations matched/i);
  });

  it('format retains out-of-range page facts and leaves recovery to enrichment', () => {
    const text = firstText(
      searchInvestigations.format!({
        totalCount: 5338,
        returned: 0,
        offset: 9000,
        limit: 5,
        investigations: [],
      }),
    );

    expect(text).toContain('**5338 investigation(s) found** (showing 0, offset 9000, limit 5)');
    expect(text).not.toContain('try a smaller offset');
    expect(text).not.toContain('to retrieve the next page');
  });

  it('accepts sparse investigation fields without inventing values', async () => {
    mockService.getInvestigations.mockResolvedValue([
      {
        nhtsaId: undefined,
        investigationType: undefined,
        status: undefined,
        makes: [],
        models: [],
        years: [],
        components: [],
        subject: undefined,
        summary: undefined,
        openDate: undefined,
      },
    ]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);
    const parsed = searchInvestigations.output.parse(result);
    const text = firstText(searchInvestigations.format!(parsed));

    expect(parsed.totalCount).toBe(1);
    expect(parsed.investigations[0]!.subject).toBeUndefined();
    expect(parsed.investigations[0]!.statusName).toBeUndefined();
    expect(text).toContain('Unknown ID');
    expect(text).toContain('Not available');
  });

  it('format renders investigation details', () => {
    const output = {
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 20,
      investigations: [
        {
          nhtsaId: 'PE20001',
          investigationType: 'PE',
          investigationTypeName: 'Preliminary Evaluation',
          status: 'O',
          statusName: 'Open',
          makes: ['TOYOTA'],
          models: ['CAMRY'],
          years: [2020],
          components: ['BRAKES'],
          subject: 'Brake failure',
          summary: 'Reports of issues.',
          openDate: '2023-01-15',
          recallCampaigns: ['23V123000'],
        },
      ],
    };
    const blocks = searchInvestigations.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('Open');
    expect(text).toContain('Preliminary Evaluation');
    expect(text).toContain('Brake failure');
    expect(text).toContain('TOYOTA');
    expect(text).toContain('23V123000');
  });

  it('format keeps every list value recoverable: semicolons between names, commas between campaigns (#48)', () => {
    const text = readerText(
      searchInvestigations.format!({
        totalCount: 1,
        returned: 1,
        offset: 0,
        limit: 20,
        investigations: [
          {
            nhtsaId: 'EA15001',
            makes: ['ELECTRIC TRANSIT, INC.', 'HONDA'],
            models: ['RG-35, RG-40', 'CIVIC'],
            years: [2012, 2015],
            components: ['FUEL SYSTEM, DIESEL', 'AIR BAGS'],
            manufacturers: ['Honda (American Honda Motor Co.)', 'Takata (TK Global, LLC)'],
            recallCampaigns: ['14V668', '23V838000'],
          },
        ],
      }),
    );

    expect(text).toContain('Makes: ELECTRIC TRANSIT, INC.; HONDA');
    expect(text).toContain('Models: RG-35, RG-40; CIVIC');
    expect(text).toContain('Years: 2012, 2015');
    expect(text).toContain('Components: FUEL SYSTEM, DIESEL; AIR BAGS');
    expect(text).toContain(
      'Manufacturers: Honda (American Honda Motor Co.); Takata (TK Global, LLC)',
    );
    expect(text).toContain('Recall Campaigns: 14V668, 23V838000');
  });

  it('format emits next-page guidance only when results remain', () => {
    const page = {
      totalCount: 38,
      returned: 2,
      offset: 0,
      limit: 2,
      investigations: [{ nhtsaId: 'PE20001' }, { nhtsaId: 'EA21002' }],
    };
    expect(firstText(searchInvestigations.format!(page))).toContain(
      'Use offset=2 to retrieve the next page.',
    );

    const lastPage = { ...page, totalCount: 2 };
    expect(firstText(searchInvestigations.format!(lastPage))).not.toContain(
      'to retrieve the next page',
    );
  });
});

describe('searchInvestigations — summaries in search rows (#52)', () => {
  const longSummary = `START ${'A'.repeat(6000)} END`;
  const withLongSummary = [{ ...sampleInvestigations[0]!, summary: longSummary }];

  it('omits summaries from search rows by default and names the way back', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const result = await runToolContract(searchInvestigations, { make: 'Toyota' });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      investigations: Record<string, unknown>[];
      notice?: string;
    };
    expect(structured.investigations).toHaveLength(1);
    expect(structured.investigations[0]).not.toHaveProperty('summary');
    expect(structured.investigations[0]).toMatchObject({
      nhtsaId: 'PE20001',
      subject: 'Toyota Camry brake failure',
      openDate: '2023-01-15',
      makes: ['TOYOTA'],
    });
    expect(structured.notice).toBe(
      'Search rows omit summaries: fetch one investigation by nhtsaId for its full summary, or repeat this search with includeSummary: true.',
    );
    const text = readerText(result.content);
    expect(text).not.toContain('Reports of brake failure');
    expect(text).toContain('includeSummary: true');
  });

  it('restores summaries verbatim with includeSummary: true, untruncated (#19)', async () => {
    mockService.getInvestigations.mockResolvedValue(withLongSummary);

    const result = await runToolContract(searchInvestigations, { includeSummary: true });

    expect(result.structuredContent).toMatchObject({
      investigations: [{ nhtsaId: 'PE20001', summary: longSummary }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = readerText(result.content);
    expect(text).toContain(longSummary);
    expect(text).not.toContain('includeSummary');
  });

  it.each([
    { label: 'without includeSummary', args: {} },
    { label: 'with includeSummary: false', args: { includeSummary: false } },
    { label: 'with includeSummary: true', args: { includeSummary: true } },
  ])('returns the full summary in nhtsaId mode $label (#19)', async ({ args }) => {
    mockService.getInvestigations.mockResolvedValue(withLongSummary);

    const result = await runToolContract(searchInvestigations, { nhtsaId: 'PE20001', ...args });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      investigations: [{ nhtsaId: 'PE20001', summary: longSummary }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(readerText(result.content)).toContain(longSummary);
  });

  it('adds no omission line when no row on the page carried a summary', async () => {
    mockService.getInvestigations.mockResolvedValue([
      { nhtsaId: 'PE20009', subject: 'No summary published', vehicles: [] },
    ]);

    const result = await runToolContract(searchInvestigations, {});

    expect(result.structuredContent).toMatchObject({ totalCount: 1, returned: 1 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('adds no omission line to an empty or past-end page', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const empty = await runToolContract(searchInvestigations, { make: 'Nonexistent' });
    const past = await runToolContract(searchInvestigations, { offset: 999 });

    for (const result of [empty, past]) {
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).not.toContain('includeSummary');
    }
  });

  it('still searches summary text with query while omitting it from the row', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const result = await runToolContract(searchInvestigations, { query: 'stalling' });

    expect(result.structuredContent).toMatchObject({
      totalCount: 1,
      investigations: [{ nhtsaId: 'EA21002' }],
    });
    expect(
      (result.structuredContent as { investigations: object[] }).investigations[0],
    ).not.toHaveProperty('summary');
  });
});

describe('searchInvestigations — page limit (#53)', () => {
  it('serves a 50-row page and echoes the default of 20 when limit is omitted', async () => {
    mockService.getInvestigations.mockResolvedValue(manyInvestigations(60));

    const atMax = await runToolContract(searchInvestigations, { limit: 50 });
    const byDefault = await runToolContract(searchInvestigations, {});

    expect(atMax.structuredContent).toMatchObject({ totalCount: 60, returned: 50, limit: 50 });
    expect(byDefault.structuredContent).toMatchObject({ returned: 20, limit: 20 });
    expect((atMax.structuredContent as { notice: string }).notice).not.toContain('exceeds');
  });

  it('clamps limit 51 to the 50-row page, notice first, joined with the summary line', async () => {
    mockService.getInvestigations.mockResolvedValue(manyInvestigations(60));

    const result = await runToolContract(searchInvestigations, { limit: 51 });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ totalCount: 60, returned: 50, limit: 50 });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toBe(
      'limit 51 exceeds the maximum of 50; returned 50 — continue at offset=50. Search rows omit summaries: fetch one investigation by nhtsaId for its full summary, or repeat this search with includeSummary: true.',
    );
    const text = readerText(result.content);
    expect(text).toContain(
      'limit 51 exceeds the maximum of 50; returned 50 — continue at offset=50.',
    );
    expect(text.split('exceeds the maximum').length - 1).toBe(1);
  });

  it('names no next offset on a clamped page that reaches the end', async () => {
    mockService.getInvestigations.mockResolvedValue(manyInvestigations(60));

    const result = await runToolContract(searchInvestigations, {
      limit: 51,
      offset: 50,
      includeSummary: true,
    });

    expect(result.structuredContent).toMatchObject({ returned: 10, limit: 50 });
    expect((result.structuredContent as { notice: string }).notice).toBe(
      'limit 51 exceeds the maximum of 50; returned 10.',
    );
  });

  it('carries the clamp and the out-of-range page in one notice', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const result = await runToolContract(searchInvestigations, { limit: 51, offset: 999 });

    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toMatch(/^limit 51 exceeds the maximum of 50; returned 0\. /);
    expect(notice).toContain('try a smaller offset');
    expect(readerText(result.content).split('try a smaller offset').length - 1).toBe(1);
  });

  it('rejects limit 51 with limit_too_large naming the cap when clamping is off', async () => {
    serverConfig.clampLimits = false;

    const result = await runToolContract(searchInvestigations, { limit: 51 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        message: 'limit 51 exceeds the maximum of 50.',
        data: { reason: 'limit_too_large', recovery: { hint: expect.stringContaining('50') } },
      },
    });
    expect(readerText(result.content)).toContain('limit 51 exceeds the maximum of 50.');
    expect(mockService.getInvestigations).not.toHaveBeenCalled();
  });

  it('serves a limit at the cap unchanged when clamping is off', async () => {
    serverConfig.clampLimits = false;
    mockService.getInvestigations.mockResolvedValue(manyInvestigations(60));

    const result = await runToolContract(searchInvestigations, { limit: 50 });

    expect(result.structuredContent).toMatchObject({ returned: 50, limit: 50 });
  });
});

describe('searchInvestigations — through the flat-file loader (#48, #51)', () => {
  const fetchMock = vi.fn();
  const row = (
    nhtsaId: string,
    make: string,
    model: string,
    year: string,
    component: string,
    mfr: string,
    openDate: string,
    campno = '',
  ) => [
    nhtsaId,
    make,
    model,
    year,
    component,
    mfr,
    openDate,
    '',
    campno,
    `${nhtsaId} subject`,
    `${nhtsaId} summary`,
  ];
  const HONDA = 'Honda (American Honda Motor Co.)';
  const TAKATA = 'Takata (TK Global, LLC)';
  /**
   * Six records: open-date order with a same-day pair (DP22005, DP22004) and two undated ones
   * (PE98001, AQ98002); EA21002 has rows (HONDA, CIVIC, 2015) and (HONDA, ACCORD, 2017) but no
   * (HONDA, CIVIC, 2017), and AQ98002 has (FORD, F-150) and (TOYOTA, TUNDRA) but no
   * (FORD, TUNDRA).
   */
  const rows = [
    row('AQ98002', 'FORD', 'F-150', '2015', 'ENGINE', 'Ford Motor Company', ''),
    row('AQ98002', 'TOYOTA', 'TUNDRA', '2016', 'ENGINE', 'Toyota Motor Corporation', ''),
    row('EA21002', 'HONDA', 'CIVIC', '2015', 'ENGINE', HONDA, '20210301', '23V085'),
    row('EA21002', 'HONDA', 'ACCORD', '2017', 'FUEL SYSTEM, DIESEL', TAKATA, '20210301', '23V838'),
    row('EA21002', 'HONDA', 'CIVIC', '2015', 'ENGINE', HONDA, '20210301', '23V085'),
    row('DP22004', 'HONDA', 'CIVIC', '2012', 'STEERING', HONDA, '20220110'),
    row('PE98001', 'HONDA', 'CIVIC', '9999', 'ENGINE', HONDA, ''),
    row('DP22005', 'HONDA', 'CIVIC', '2015', 'STEERING', HONDA, '20220110'),
    row('PE23001', 'TOYOTA', 'CAMRY', '2020', 'BRAKES', 'Toyota Motor Corporation', '20230115'),
  ];

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).hostname !== 'static.nhtsa.gov') throw new Error('unmocked fetch');
      const text = rows.map((r) => r.join('\t')).join('\n');
      return new Response(zipSync({ 'FLAT_INV.txt': new TextEncoder().encode(text) }));
    });
    const actual = await vi.importActual<typeof import('@/services/nhtsa/nhtsa-service.js')>(
      '@/services/nhtsa/nhtsa-service.js',
    );
    vi.mocked(getNhtsaService).mockReturnValue(new actual.NhtsaService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ids = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { investigations: { nhtsaId: string }[] }).investigations.map(
      (i) => i.nhtsaId,
    );

  it('walks two pages newest-opened first: same-day IDs descending, undated last', async () => {
    const first = await runToolContract(searchInvestigations, { limit: 3 });
    const second = await runToolContract(searchInvestigations, { limit: 3, offset: 3 });

    expect(ids(first)).toStrictEqual(['PE23001', 'DP22005', 'DP22004']);
    expect(ids(second)).toStrictEqual(['EA21002', 'PE98001', 'AQ98002']);
    expect(first.structuredContent).toMatchObject({ totalCount: 6 });
    expect(readerText(first.content)).toContain('Use offset=3 to retrieve the next page.');
    expect(readerText(second.content)).not.toContain('to retrieve the next page');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ make: 'Honda', model: 'Civic', modelYear: 2015 }, ['DP22005', 'EA21002']],
    [{ model: 'Accord', modelYear: 2017 }, ['EA21002']],
    [{ model: 'Civic', modelYear: 2017 }, []],
    [{ make: 'Honda', model: 'Accord' }, ['EA21002']],
    [{ make: 'Toyota', model: 'Tundra' }, ['AQ98002']],
    [{ make: 'Ford', model: 'Tundra' }, []],
    [{ model: 'civic' }, ['DP22005', 'DP22004', 'EA21002', 'PE98001']],
    [{ modelYear: 2015 }, ['DP22005', 'EA21002', 'AQ98002']],
    [{ modelYear: 9999 }, []],
    // Names match within the make and model, case-insensitively, still on one association.
    [{ make: 'hond', model: 'acc' }, ['EA21002']],
    [{ model: 'F-1', modelYear: 2015 }, ['AQ98002']],
    [{ make: 'toy', model: 'f-1' }, []],
  ])('matches %j on one vehicle association: %j', async (args, expected) => {
    const result = await runToolContract(searchInvestigations, args);

    expect(result.isError).not.toBe(true);
    expect(ids(result)).toStrictEqual(expected);
  });

  it('never matches modelYear on a record whose rows carry no model year', async () => {
    const result = await runToolContract(searchInvestigations, {
      model: 'Civic',
      query: 'PE98001',
      modelYear: 2015,
    });

    expect(result.structuredContent).toMatchObject({ totalCount: 0 });
  });

  it('explains the one-association rule on a zero-match page and echoes modelYear', async () => {
    const result = await runToolContract(searchInvestigations, {
      make: 'Honda',
      model: 'Civic',
      modelYear: 2017,
    });

    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      effectiveQuery: 'make="Honda", model="Civic", modelYear=2017',
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain(
      'make, model, and modelYear must all match on the same vehicle association',
    );
    expect(readerText(result.content)).toContain('modelYear=2017');
  });

  it('returns every manufacturer and campaign on both surfaces, with no association rows', async () => {
    const result = await runToolContract(searchInvestigations, { nhtsaId: 'EA21002' });

    const [investigation] = (result.structuredContent as { investigations: object[] })
      .investigations;
    expect(investigation).toMatchObject({
      manufacturers: [HONDA, TAKATA],
      recallCampaigns: ['23V085', '23V838'],
      components: ['ENGINE', 'FUEL SYSTEM, DIESEL'],
      years: [2015, 2017],
      summary: 'EA21002 summary',
    });
    for (const key of ['manufacturer', 'recallCampaign', 'vehicles']) {
      expect(investigation).not.toHaveProperty(key);
    }
    const text = readerText(result.content);
    expect(text).toContain(`Manufacturers: ${HONDA}; ${TAKATA}`);
    expect(text).toContain('Recall Campaigns: 23V085, 23V838');
    expect(text).toContain('Components: ENGINE; FUEL SYSTEM, DIESEL');
  });

  it('rejects modelYear alongside nhtsaId with mode_conflict before loading', async () => {
    const result = await runToolContract(searchInvestigations, {
      nhtsaId: 'EA21002',
      modelYear: 2015,
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'mode_conflict' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchInvestigations — input validation', () => {
  it('rejects a negative limit', () => {
    expect(() => searchInvestigations.input.parse({ limit: -1 })).toThrow();
  });

  it('rejects limit 0', () => {
    expect(() => searchInvestigations.input.parse({ limit: 0 })).toThrow();
  });

  it('leaves an over-cap limit to the handler, which clamps or rejects it', () => {
    expect(searchInvestigations.input.parse({ limit: 51 }).limit).toBe(51);
    expect(searchInvestigations.input.parse({ limit: 1e21 }).limit).toBe(1e21);
  });

  it('rejects a non-integer limit', () => {
    expect(() => searchInvestigations.input.parse({ limit: 2.5 })).toThrow();
  });

  it('rejects a non-integer modelYear', () => {
    expect(() => searchInvestigations.input.parse({ modelYear: 2017.5 })).toThrow();
    expect(searchInvestigations.input.parse({ modelYear: 2017 }).modelYear).toBe(2017);
  });

  it('rejects a negative offset', () => {
    expect(() => searchInvestigations.input.parse({ offset: -1 })).toThrow();
  });

  it('rejects a status outside the O/C enum', () => {
    expect(() => searchInvestigations.input.parse({ status: 'open' })).toThrow();
    expect(() => searchInvestigations.input.parse({ status: 'o' })).toThrow();
    expect(searchInvestigations.input.parse({ status: 'O' }).status).toBe('O');
    expect(searchInvestigations.input.parse({ status: 'C' }).status).toBe('C');
  });
});
