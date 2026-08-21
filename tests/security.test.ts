/**
 * @fileoverview Security tests — injection attempts, oversized inputs, and secret leakage.
 * @module tests/security
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Keeps the module's real constants (e.g. MANUFACTURER_RESULT_CAP) that handlers read. */
vi.mock('@/services/nhtsa/nhtsa-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nhtsa/nhtsa-service.js')>()),
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { decodeVin } from '@/mcp-server/tools/definitions/decode-vin.tool.js';
import { lookupVehicles } from '@/mcp-server/tools/definitions/lookup-vehicles.tool.js';
import { searchComplaints } from '@/mcp-server/tools/definitions/search-complaints.tool.js';
import { searchInvestigations } from '@/mcp-server/tools/definitions/search-investigations.tool.js';
import { searchRecalls } from '@/mcp-server/tools/definitions/search-recalls.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from './helpers/content.js';

const mockService = {
  getAllMakes: vi.fn(),
  getComplaintsByVehicle: vi.fn(),
  getInvestigations: vi.fn(),
  getModels: vi.fn(),
  getVehicleTypes: vi.fn(),
  getManufacturer: vi.fn(),
  getRecallsByVehicle: vi.fn(),
  getRecallCampaign: vi.fn(),
  decodeVin: vi.fn(),
  decodeVinBatch: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

/** Collect all env var names — none should appear verbatim in tool output. */
const SENSITIVE_ENV_PATTERNS = ['process.env', 'SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'CREDENTIAL'];

function assertNoSecretLeakage(text: string): void {
  for (const pattern of SENSITIVE_ENV_PATTERNS) {
    expect(text.toLowerCase()).not.toContain(pattern.toLowerCase());
  }
}

describe('injection safety — searchRecalls', () => {
  it('passes SQL/script injection in make through to service without eval', async () => {
    /** The handler must not throw on injection-looking inputs — it forwards them as opaque
     *  strings to the service. The service is mocked; what matters is no eval/injection occurs. */
    mockService.getRecallsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({
      make: "Toyota'; DROP TABLE recalls; --",
      model: 'Camry',
      modelYear: 2020,
    });
    const result = await searchRecalls.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    // Service called with the literal injected string — no execution
    expect(mockService.getRecallsByVehicle).toHaveBeenCalledWith(
      "Toyota'; DROP TABLE recalls; --",
      'Camry',
      2020,
      expect.anything(),
    );
  });

  it('passes XSS payload in campaignNumber as opaque input', async () => {
    mockService.getRecallCampaign.mockResolvedValue(null);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ campaignNumber: '<script>alert(1)</script>' });
    await expect(searchRecalls.handler(input, ctx)).rejects.toThrow();
    // Handler threw because campaign not found — not because XSS was evaluated
    expect(mockService.getRecallCampaign).toHaveBeenCalledWith(
      '<script>alert(1)</script>',
      expect.anything(),
    );
  });

  it('output text contains no secret-looking values', async () => {
    mockService.getRecallsByVehicle.mockResolvedValue([
      {
        campaignNumber: '20V682000',
        manufacturer: 'Toyota',
        component: 'FUEL SYSTEM',
        summary: 'Leak.',
        consequence: 'Fire.',
        remedy: 'Replace.',
        reportReceivedDate: '2020-11-12',
      },
    ]);

    const ctx = createMockContext({ errors: searchRecalls.errors });
    const input = searchRecalls.input.parse({ make: 'Toyota', model: 'Camry', modelYear: 2020 });
    const result = await searchRecalls.handler(input, ctx);
    const text = firstText(searchRecalls.format!(result));
    assertNoSecretLeakage(text);
  });
});

describe('injection safety — searchComplaints', () => {
  it('passes path-traversal-like model string to service as opaque input', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: '../../../etc/passwd',
      modelYear: 2020,
    });
    const result = await searchComplaints.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(mockService.getComplaintsByVehicle).toHaveBeenCalledWith(
      'Toyota',
      '../../../etc/passwd',
      2020,
      expect.anything(),
    );
  });

  it('component filter with injection-like value does substring match, does not execute code', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([
      { odiNumber: 1, components: 'ENGINE', crash: false, fire: false },
    ]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      component: "ENGINE'); DROP TABLE--",
    });
    const result = await searchComplaints.handler(input, ctx);
    // The injection doesn't match 'ENGINE' (uppercase full match), so 0 results
    // The point: no exception, no SQL executed
    expect(result.totalCount).toBe(0);
  });
});

describe('injection safety — searchInvestigations', () => {
  it('passes injection-like query string as opaque text search', async () => {
    mockService.getInvestigations.mockResolvedValue([]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({
      query: "brake failure'; SELECT * FROM investigations--",
    });
    const result = await searchInvestigations.handler(input, ctx);
    expect(result.totalCount).toBe(0);
  });
});

describe('injection safety — lookupVehicles', () => {
  it('passes URL-override-like make string to service without SSRF', async () => {
    mockService.getModels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: lookupVehicles.errors });
    const input = lookupVehicles.input.parse({
      operation: 'models',
      make: 'http://evil.example.com/override',
    });
    const result = await lookupVehicles.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    // Service called with literal — no URL override occurs at handler level
    expect(mockService.getModels).toHaveBeenCalledWith(
      'http://evil.example.com/override',
      undefined,
      expect.anything(),
    );
  });
});

describe('oversized input handling', () => {
  it('searchComplaints with limit at max (50) does not crash', async () => {
    mockService.getComplaintsByVehicle.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = searchComplaints.input.parse({
      make: 'Toyota',
      model: 'Camry',
      modelYear: 2020,
      limit: 50,
    });
    const result = await searchComplaints.handler(input, ctx);
    expect(result.limit).toBe(50);
  });

  it('searchComplaints rejects limit above max via Zod', () => {
    expect(() =>
      searchComplaints.input.parse({
        make: 'Toyota',
        model: 'Camry',
        modelYear: 2020,
        limit: 51,
      }),
    ).toThrow();
  });

  it('searchComplaints rejects limit < 1 via Zod', () => {
    expect(() =>
      searchComplaints.input.parse({
        make: 'Toyota',
        model: 'Camry',
        modelYear: 2020,
        limit: 0,
      }),
    ).toThrow();
  });

  it('decodeVin throws when vin array has 51 elements (exceeds batch limit)', async () => {
    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: Array.from({ length: 51 }, (_, i) => `VIN${i}`) });
    await expect(decodeVin.handler(input, ctx)).rejects.toThrow(/50/);
  });

  it('lookupVehicles rejects limit > 200 via Zod', () => {
    expect(() => lookupVehicles.input.parse({ operation: 'makes', limit: 201 })).toThrow();
  });

  it('lookupVehicles rejects offset < 0 via Zod', () => {
    expect(() => lookupVehicles.input.parse({ operation: 'makes', offset: -1 })).toThrow();
  });

  it('searchInvestigations rejects an unbounded limit via Zod', () => {
    expect(() => searchInvestigations.input.parse({ limit: 100_000 })).toThrow();
  });

  it('searchInvestigations rejects negative limit/offset via Zod', () => {
    expect(() => searchInvestigations.input.parse({ limit: -1 })).toThrow();
    expect(() => searchInvestigations.input.parse({ offset: -1 })).toThrow();
  });

  it('searchInvestigations rejects a free-form status value via Zod', () => {
    expect(() => searchInvestigations.input.parse({ status: 'open' })).toThrow();
  });

  it('searchInvestigations with limit at max does not crash', async () => {
    mockService.getInvestigations.mockResolvedValue([]);

    const ctx = createMockContext({ errors: searchInvestigations.errors });
    const input = searchInvestigations.input.parse({ limit: 25 });
    const result = await searchInvestigations.handler(input, ctx);
    expect(result.limit).toBe(25);
  });
});

describe('secret leakage prevention', () => {
  it('format output for investigations contains no secret-pattern strings', () => {
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
          summary: 'Reports of brake issues.',
          openDate: '2023-01-15',
        },
      ],
    };
    const blocks = searchInvestigations.format!(output);
    assertNoSecretLeakage(firstText(blocks));
  });

  it('format output for decoded VIN contains no secret-pattern strings', () => {
    const output = {
      vehicles: [
        {
          vin: '1HGCM82633A004352',
          make: 'HONDA',
          model: 'ACCORD',
          modelYear: '2003',
          engineHP: '160',
          plantCity: 'MARYSVILLE',
        },
      ],
    };
    const blocks = decodeVin.format!(output);
    assertNoSecretLeakage(firstText(blocks));
  });
});
