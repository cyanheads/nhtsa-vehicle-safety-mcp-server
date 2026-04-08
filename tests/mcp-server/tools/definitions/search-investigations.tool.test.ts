/**
 * @fileoverview Tests for nhtsa_search_investigations tool.
 * @module tests/mcp-server/tools/definitions/search-investigations.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

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
    subject: 'Toyota Camry brake failure',
    description: 'Reports of brake failure in 2020 Toyota Camry vehicles.',
    openDate: '2023-01-15',
    latestActivityDate: '2023-06-01',
    issueYear: '2023',
  },
  {
    nhtsaId: 'EA21002',
    investigationType: 'EA',
    status: 'C',
    subject: 'Honda Civic engine stall',
    description: 'Engine stalling in 2021 Honda Civic.',
    openDate: '2022-05-01',
    latestActivityDate: '2023-01-01',
    issueYear: '2022',
  },
  {
    nhtsaId: 'PE22003',
    investigationType: 'PE',
    status: 'O',
    subject: 'Ford F-150 transmission',
    description: 'Transmission issues in Ford F-150.',
    openDate: '2024-01-01',
    latestActivityDate: '2024-06-01',
    issueYear: '2024',
  },
];

describe('searchInvestigations', () => {
  it('returns all investigations when no filters', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(3);
    expect(result.investigations).toHaveLength(3);
  });

  it('filters by investigationType', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({ investigationType: 'PE' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.investigations.every((i) => i.investigationType === 'PE')).toBe(true);
  });

  it('filters by status', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({ status: 'C' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.investigations[0].nhtsaId).toBe('EA21002');
  });

  it('filters by make (text match)', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({ make: 'Toyota' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.investigations[0].nhtsaId).toBe('PE20001');
  });

  it('filters by query (text match)', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({ query: 'transmission' });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.investigations[0].nhtsaId).toBe('PE22003');
  });

  it('paginates with offset/limit', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({ limit: 1, offset: 1 });
    const result = await searchInvestigations.handler(input, ctx);

    expect(result.total).toBe(3);
    expect(result.investigations).toHaveLength(1);
    expect(result.investigations[0].nhtsaId).toBe('EA21002');
  });

  it('returns investigation type names', async () => {
    mockService.getInvestigations.mockResolvedValue(sampleInvestigations);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);

    const pe = result.investigations.find((i) => i.investigationType === 'PE');
    expect(pe?.investigationTypeName).toBe('Preliminary Evaluation');
    const ea = result.investigations.find((i) => i.investigationType === 'EA');
    expect(ea?.investigationTypeName).toBe('Engineering Analysis');
  });

  it('accepts sparse investigation fields without inventing values', async () => {
    mockService.getInvestigations.mockResolvedValue([
      {
        nhtsaId: undefined,
        investigationType: undefined,
        status: undefined,
        subject: undefined,
        description: undefined,
        openDate: undefined,
        latestActivityDate: undefined,
        issueYear: undefined,
      },
    ]);

    const ctx = createMockContext();
    const input = searchInvestigations.input.parse({});
    const result = await searchInvestigations.handler(input, ctx);
    const parsed = searchInvestigations.output.parse(result);
    const text = searchInvestigations.format!(parsed)[0].text;

    expect(parsed.total).toBe(1);
    expect(parsed.investigations[0].subject).toBeUndefined();
    expect(parsed.investigations[0].statusName).toBeUndefined();
    expect(text).toContain('Unknown ID');
    expect(text).toContain('Not available');
  });

  it('format renders investigation details', () => {
    const output = {
      total: 1,
      investigations: [
        {
          nhtsaId: 'PE20001',
          investigationType: 'PE',
          investigationTypeName: 'Preliminary Evaluation',
          status: 'O',
          statusName: 'Open',
          subject: 'Brake failure',
          description: 'Reports of issues.',
          openDate: '2023-01-15',
          latestActivityDate: '2023-06-01',
        },
      ],
    };
    const blocks = searchInvestigations.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('OPEN');
    expect(text).toContain('Preliminary Evaluation');
    expect(text).toContain('Brake failure');
  });
});
