/**
 * @fileoverview Tests for nhtsa_search_investigations tool.
 * @module tests/mcp-server/tools/definitions/search-investigations.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

const mockService = { getInvestigations: vi.fn() };

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  mockService.getInvestigations.mockReset();
});

const sampleInvestigations = [
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
  },
];

describe('searchInvestigations', () => {
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

  it('format explains an out-of-range page instead of a bare "showing 0"', () => {
    const text = firstText(
      searchInvestigations.format!({
        totalCount: 5338,
        returned: 0,
        offset: 9000,
        limit: 5,
        investigations: [],
      }),
    );

    expect(text).toContain('No results for this page (offset 9000, limit 5). 5338 total');
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
          recallCampaign: '23V123000',
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

  it('format renders the full summary without truncation', () => {
    const longSummary = `START ${'A'.repeat(6000)} END`;
    const text = firstText(
      searchInvestigations.format!({
        totalCount: 1,
        returned: 1,
        offset: 0,
        limit: 20,
        investigations: [{ nhtsaId: 'PE20001', summary: longSummary }],
      }),
    );

    expect(text).toContain(longSummary);
    expect(text).not.toContain('A...');
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

describe('searchInvestigations — input validation', () => {
  it('rejects a negative limit', () => {
    expect(() => searchInvestigations.input.parse({ limit: -1 })).toThrow();
  });

  it('rejects limit 0', () => {
    expect(() => searchInvestigations.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects a limit above the max', () => {
    expect(() => searchInvestigations.input.parse({ limit: 26 })).toThrow();
    expect(searchInvestigations.input.parse({ limit: 25 }).limit).toBe(25);
  });

  it('rejects a non-integer limit', () => {
    expect(() => searchInvestigations.input.parse({ limit: 2.5 })).toThrow();
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
