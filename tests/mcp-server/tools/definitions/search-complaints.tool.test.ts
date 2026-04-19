/**
 * @fileoverview Tests for nhtsa_search_complaints tool.
 * @module tests/mcp-server/tools/definitions/search-complaints.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchComplaints } from '@/mcp-server/tools/definitions/search-complaints.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const mockService = { getComplaintsByVehicle: vi.fn() };

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  mockService.getComplaintsByVehicle.mockReset();
});

function complaint(overrides: Record<string, unknown> = {}) {
  return {
    odiNumber: 1,
    manufacturer: 'Toyota',
    crash: false,
    fire: false,
    numberOfInjuries: 0,
    numberOfDeaths: 0,
    dateOfIncident: '2021-01-01',
    dateComplaintFiled: '2021-02-01',
    vin: 'ABC123',
    components: 'ENGINE',
    summary: 'Issue.',
    ...overrides,
  };
}

describe('searchComplaints', () => {
  it('returns complaints with component breakdown', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([
      complaint({ components: 'ENGINE', crash: true, numberOfInjuries: 1 }),
      complaint({ odiNumber: 2, components: 'ENGINE,BRAKES' }),
      complaint({ odiNumber: 3, components: 'BRAKES', fire: true }),
    ]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.componentBreakdown.length).toBeGreaterThanOrEqual(2);
    const engine = result.componentBreakdown.find((b) => b.component === 'ENGINE');
    expect(engine?.count).toBe(2);
    expect(engine?.crashCount).toBe(1);
  });

  it('filters by component (substring match)', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([
      complaint({ components: 'ENGINE AND ENGINE COOLING' }),
      complaint({ odiNumber: 2, components: 'ELECTRICAL SYSTEM' }),
      complaint({ odiNumber: 3, components: 'ENGINE AND ENGINE COOLING,FUEL SYSTEM' }),
    ]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      component: 'ENGINE',
    });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(2);
  });

  it('returns empty when no complaints', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({ make: 'Fake', model: 'Car', modelYear: 2020 });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(result.complaints).toEqual([]);
    expect(result.componentBreakdown).toEqual([]);
  });

  it('accepts sparse complaint fields without inventing values', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([
      complaint({
        odiNumber: undefined,
        crash: undefined,
        fire: undefined,
        numberOfInjuries: undefined,
        numberOfDeaths: undefined,
        dateOfIncident: undefined,
        dateComplaintFiled: undefined,
        vin: undefined,
        components: undefined,
        summary: undefined,
      }),
    ]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchComplaints.handler(input, ctx);
    const parsed = searchComplaints.output.parse(result);
    const text = searchComplaints.format!(parsed)[0].text;

    expect(parsed.totalCount).toBe(1);
    expect(parsed.complaints[0].crash).toBeUndefined();
    expect(parsed.complaints[0].components).toBeUndefined();
    expect(text).toContain('#Unknown');
    expect(text).toContain('Not available');
    expect(text).not.toContain('CRASH');
    expect(text).not.toContain('FIRE');
  });

  it('paginates complaints with default limit of 20', async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      complaint({
        odiNumber: i,
        dateComplaintFiled: `2021-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );
    mockService.getComplaintsByVehicle.mockResolvedValue(many);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(80);
    expect(result.returned).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(20);
    expect(result.complaints).toHaveLength(20);
  });

  it('honors explicit limit and offset', async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      complaint({
        odiNumber: i,
        dateComplaintFiled: `2021-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );
    mockService.getComplaintsByVehicle.mockResolvedValue(many);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      limit: 10,
      offset: 20,
    });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(80);
    expect(result.returned).toBe(10);
    expect(result.offset).toBe(20);
    expect(result.limit).toBe(10);
    expect(result.complaints).toHaveLength(10);
    expect(result.componentBreakdown.length).toBeGreaterThan(0);
  });

  it('format renders breakdown and complaints', () => {
    const output = {
      totalCount: 2,
      returned: 1,
      offset: 0,
      limit: 20,
      componentBreakdown: [
        {
          component: 'ENGINE',
          count: 2,
          crashCount: 1,
          fireCount: 0,
          injuryCount: 1,
          deathCount: 0,
        },
      ],
      complaints: [
        {
          odiNumber: 1,
          dateOfIncident: '2021-01-01',
          dateComplaintFiled: '2021-02-01',
          components: 'ENGINE',
          summary: 'Stalled.',
          crash: true,
          fire: false,
          numberOfInjuries: 1,
          numberOfDeaths: 0,
          vin: 'ABC',
        },
      ],
    };
    const blocks = searchComplaints.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('2 complaint(s)');
    expect(text).toContain('ENGINE');
    expect(text).toContain('CRASH');
    expect(text).toContain('Use offset=1');
  });
});
