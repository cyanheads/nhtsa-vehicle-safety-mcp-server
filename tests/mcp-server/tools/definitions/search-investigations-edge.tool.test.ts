/**
 * @fileoverview Additional coverage for nhtsa_search_investigations — combined filters,
 * model/component filters, DP/RQ type codes, empty dataset notice.
 * @module tests/mcp-server/tools/definitions/search-investigations-edge.tool
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

const baseInvestigations = [
  {
    nhtsaId: 'PE20001',
    investigationType: 'PE',
    status: 'O',
    makes: ['TOYOTA'],
    models: ['CAMRY'],
    years: [2020],
    components: ['BRAKES'],
    subject: 'Toyota Camry brake failure',
    summary: 'Reports of brake failure.',
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
    summary: 'Engine stalling.',
    openDate: '2022-05-01',
    closeDate: '2023-01-01',
  },
  {
    nhtsaId: 'DP22003',
    investigationType: 'DP',
    status: 'O',
    makes: ['FORD'],
    models: ['F-150'],
    years: [2022],
    components: ['STEERING'],
    subject: 'Ford steering defect petition',
    summary: 'Steering defect.',
    openDate: '2024-01-01',
  },
  {
    nhtsaId: 'RQ23004',
    investigationType: 'RQ',
    status: 'C',
    makes: ['BMW'],
    models: ['3 SERIES'],
    years: [2023],
    components: ['FUEL SYSTEM'],
    subject: 'BMW fuel system recall query',
    summary: 'Fuel system issue.',
    openDate: '2024-06-01',
    closeDate: '2025-01-01',
  },
];

describe('searchInvestigations — model filter', () => {
  it('filters by model (case-insensitive)', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ model: 'civic' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('EA21002');
  });

  it('model filter returns zero when no matches', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ model: 'Nonexistent' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(0);
  });
});

describe('searchInvestigations — component filter', () => {
  it('filters by component (case-insensitive)', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ component: 'steering' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('DP22003');
  });
});

describe('searchInvestigations — combined ANDed filters', () => {
  it('make AND investigationType narrows results correctly', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({
      make: 'Toyota',
      investigationType: 'PE',
    });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('PE20001');
  });

  it('make AND status AND component all ANDed — returns zero if no match', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    // Toyota + Open + ENGINE — Toyota only has BRAKES
    const input = searchInvestigations.input.parse({
      make: 'Toyota',
      status: 'O',
      component: 'ENGINE',
    });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/try broadening/i);
  });

  it('effectiveQuery lists all applied filters', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({
      make: 'Ford',
      status: 'O',
      component: 'STEERING',
    });
    await searchInvestigations.handler(input, ctx);

    const query = getEnrichment(ctx).effectiveQuery as string;
    expect(query).toContain('make="Ford"');
    expect(query).toContain('status="O"');
    expect(query).toContain('component="STEERING"');
  });
});

describe('searchInvestigations — DP and RQ type codes', () => {
  it('filters by DP (Defect Petition) type', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ investigationType: 'DP' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('DP22003');
    expect(result.investigations[0]!.investigationTypeName).toBe('Defect Petition');
  });

  it('filters by RQ (Recall Query) type', async () => {
    mockService.getInvestigations.mockResolvedValue(baseInvestigations);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ investigationType: 'RQ' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.investigations[0]!.nhtsaId).toBe('RQ23004');
    expect(result.investigations[0]!.investigationTypeName).toBe('Recall Query');
  });

  it('unknown investigation type code returns the raw code as the name', async () => {
    mockService.getInvestigations.mockResolvedValue([
      {
        nhtsaId: 'XY99999',
        investigationType: 'XY',
        status: 'O',
        makes: [],
        models: [],
        years: [],
        components: [],
      },
    ]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.investigations[0]!.investigationTypeName).toBe('XY');
  });
});

describe('searchInvestigations — empty dataset notice', () => {
  it('surfaces unexpected-notice when dataset returns zero with no filters', async () => {
    mockService.getInvestigations.mockResolvedValue([]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/unexpected/i);
  });
});

describe('searchInvestigations — format edge cases', () => {
  it('format renders "No investigations found" when totalCount is 0', () => {
    const blocks = searchInvestigations.format!({
      totalCount: 0,
      returned: 0,
      offset: 0,
      limit: 20,
      investigations: [],
    });
    expect(firstText(blocks)).toContain('No investigations found');
  });

  it('format shows correct count header', () => {
    const output = {
      totalCount: 2,
      returned: 1,
      offset: 0,
      limit: 1,
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
          subject: 'Brakes',
          summary: 'Issues.',
          openDate: '2023-01-15',
        },
      ],
    };
    const text = firstText(searchInvestigations.format!(output));
    expect(text).toContain('2 investigation(s) found');
    // Only 1 shown
    expect(text).toContain('showing 1');
  });

  it('format omits empty makes/models/years sections', () => {
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
          subject: 'Brakes',
          summary: 'Issues.',
          openDate: '2023-01-15',
        },
      ],
    };
    const text = firstText(searchInvestigations.format!(output));
    expect(text).not.toContain('**Makes:**');
    expect(text).not.toContain('**Models:**');
  });
});
