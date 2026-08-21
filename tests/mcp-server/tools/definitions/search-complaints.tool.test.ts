/**
 * @fileoverview Tests for nhtsa_search_complaints tool.
 * @module tests/mcp-server/tools/definitions/search-complaints.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { searchComplaints } from '@/mcp-server/tools/definitions/search-complaints.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

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
  it('returns complaints with component breakdown and enrichment query', async () => {
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
    expect(getEnrichment(ctx).effectiveQuery).toBe('Toyota Camry 2020');
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

  it('returns empty when no complaints and populates enrichment notice', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({ make: 'Fake', model: 'Car', modelYear: 2020 });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(result.complaints).toEqual([]);
    expect(result.componentBreakdown).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/nhtsa_lookup_vehicles/i);
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
    const text = firstText(searchComplaints.format!(parsed));

    expect(parsed.totalCount).toBe(1);
    expect(parsed.complaints[0]!.crash).toBeUndefined();
    expect(parsed.complaints[0]!.components).toBeUndefined();
    expect(text).toContain('#Unknown');
    expect(text).toContain('Not available');
    expect(text).not.toContain('CRASH');
    expect(text).not.toContain('FIRE');
    // Absent stays absent — no severity line is invented for fields NHTSA never sent.
    expect(text).not.toContain('Reported:');
  });

  it('format states present-false and zero severity fields instead of dropping them', () => {
    const output = {
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 20,
      componentBreakdown: [],
      complaints: [
        {
          odiNumber: 11223344,
          dateOfIncident: '2021-01-01',
          dateComplaintFiled: '2021-02-01',
          components: 'ENGINE',
          summary: 'Stalled.',
          crash: false,
          fire: false,
          numberOfInjuries: 0,
          numberOfDeaths: 0,
        },
      ],
    };
    const text = firstText(searchComplaints.format!(output));

    expect(text).toContain('Reported: Crash: no | Fire: no | Injuries: 0 | Deaths: 0');
    // The bracketed badge stays reserved for actual crash/fire/casualty reports.
    expect(text).not.toContain('[CRASH');
  });

  it('format lists only the severity fields NHTSA reported', () => {
    const output = {
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 20,
      componentBreakdown: [],
      complaints: [
        {
          odiNumber: 11223345,
          dateComplaintFiled: '2021-02-01',
          crash: true,
          numberOfDeaths: 0,
        },
      ],
    };
    const text = firstText(searchComplaints.format!(output));

    expect(text).toContain('Reported: Crash: yes | Deaths: 0');
    expect(text).not.toContain('Fire:');
    expect(text).not.toContain('Injuries:');
  });

  it('format discloses an incident date the record contradicts', () => {
    const output = searchComplaints.output.parse({
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 20,
      componentBreakdown: [],
      complaints: [
        {
          odiNumber: 10877133,
          unreliableIncidentDate: { reported: '1016-06-28', reason: 'predates_model_year' },
          dateComplaintFiled: '2016-06-28',
          components: 'ENGINE',
        },
      ],
    });
    const text = firstText(searchComplaints.format!(output));

    expect(text).toContain('1016-06-28');
    expect(text).toContain('predates the vehicle model year');
    // Not presented as the incident date, and not collapsed into "NHTSA had no date".
    expect(text).not.toContain('— 1016-06-28 (filed');
    expect(text).not.toContain('Not available (filed');
  });

  it('format names the filing date as what a future-dated incident contradicts', () => {
    const output = searchComplaints.output.parse({
      totalCount: 1,
      returned: 1,
      offset: 0,
      limit: 20,
      componentBreakdown: [],
      complaints: [
        {
          odiNumber: 844272,
          unreliableIncidentDate: { reported: '2019-07-28', reason: 'postdates_filing' },
          dateComplaintFiled: '1999-08-04',
        },
      ],
    });
    const text = firstText(searchComplaints.format!(output));

    expect(text).toContain('2019-07-28');
    expect(text).toContain('falls after the complaint was filed');
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

  it('notices an offset past the end of a non-empty result set', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => complaint({ odiNumber: i })),
    );

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      limit: 5,
      offset: 9000,
    });
    const result = await searchComplaints.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.returned).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('offset 9000');
    expect(notice).toContain('limit 5');
    expect(notice).toContain('3 total');
    expect(notice).toMatch(/try a smaller offset/i);
    // Not the no-matches notice — the filters did match.
    expect(notice).not.toMatch(/nhtsa_lookup_vehicles/i);
  });

  it('keeps the no-matches notice when nothing matched at all', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      offset: 9000,
    });
    await searchComplaints.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toMatch(/nhtsa_lookup_vehicles/i);
  });

  it('format explains an out-of-range page instead of a bare "returned 0"', () => {
    const text = firstText(
      searchComplaints.format!({
        totalCount: 264,
        returned: 0,
        offset: 9000,
        limit: 5,
        componentBreakdown: [
          {
            component: 'ENGINE',
            count: 264,
            crashCount: 0,
            fireCount: 0,
            injuryCount: 0,
            deathCount: 0,
          },
        ],
        complaints: [],
      }),
    );

    expect(text).toContain('No results for this page (offset 9000, limit 5). 264 total');
    expect(text).not.toContain('to retrieve the next page');
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
    const text = firstText(blocks);
    expect(text).toContain('2 complaint(s)');
    expect(text).toContain('ENGINE');
    expect(text).toContain('CRASH');
    expect(text).toContain('Use offset=1');
  });

  it('rejects a fractional modelYear rather than sending it upstream', () => {
    expect(() =>
      searchComplaints.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020.5 }),
    ).toThrow();
    expect(
      searchComplaints.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 }).modelYear,
    ).toBe(2020);
  });
});
