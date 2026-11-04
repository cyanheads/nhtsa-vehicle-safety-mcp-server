/**
 * @fileoverview Additional edge-case coverage for nhtsa_decode_vin.
 * @module tests/mcp-server/tools/definitions/decode-vin-edge.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

import { decodeVin } from '@/mcp-server/tools/definitions/decode-vin.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText } from '../../../helpers/content.js';

const mockService = {
  decodeVin: vi.fn(),
  decodeVinBatch: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
});

const sampleVin = {
  vin: '1HGCM82633A004352',
  make: 'HONDA',
  model: 'ACCORD',
  modelYear: '2003',
  bodyClass: 'Sedan/Saloon',
  vehicleType: 'PASSENGER CAR',
  engineHP: '160',
  plantCity: 'MARYSVILLE',
  errorCode: '0',
};

describe('decodeVin — empty VIN list edge cases', () => {
  it('throws empty_vin_list when given an empty array', async () => {
    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: [] });
    await expect(decodeVin.handler(input, ctx)).rejects.toThrow(/non-empty VIN/i);
  });

  it('throws empty_vin_list when given an array of all-whitespace strings', async () => {
    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: ['  ', '\t', ''] });
    await expect(decodeVin.handler(input, ctx)).rejects.toThrow(/non-empty VIN/i);
  });
});

describe('decodeVin — wildcard / partial VINs', () => {
  it('passes wildcard VIN through to service (partial VIN with * positions)', async () => {
    mockService.decodeVin.mockResolvedValue({ ...sampleVin, vin: '1HGCM826*3A*04352' });

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM826*3A*04352' });
    const result = await decodeVin.handler(input, ctx);

    expect(result.vehicles).toHaveLength(1);
    expect(mockService.decodeVin).toHaveBeenCalledWith(
      '1HGCM826*3A*04352',
      undefined,
      expect.anything(),
    );
  });
});

describe('decodeVin — multiple batch VINs with errorCode warnings', () => {
  it('notice fires when at least one batch VIN has non-zero errorCode', async () => {
    mockService.decodeVinBatch.mockResolvedValue([
      { ...sampleVin, vin: 'AAAA', errorCode: '0' },
      { ...sampleVin, vin: 'BBBB', errorCode: '8', errorText: 'Incorrect WMI' },
    ]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: ['AAAA', 'BBBB'] });
    await decodeVin.handler(input, ctx);

    // One of two VINs has a non-zero error
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/1 VIN.*VPIC warnings/i);
  });

  it('no notice when all batch VINs have errorCode 0', async () => {
    mockService.decodeVinBatch.mockResolvedValue([
      { ...sampleVin, vin: 'AAAA', errorCode: '0' },
      { ...sampleVin, vin: 'BBBB', errorCode: '0' },
    ]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: ['AAAA', 'BBBB'] });
    await decodeVin.handler(input, ctx);

    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});

describe('decodeVin — format edge cases', () => {
  it('format renders warning line for non-zero errorCode', () => {
    const output = {
      vehicles: [
        {
          vin: '1HGCM82633A004352',
          make: 'HONDA',
          model: 'ACCORD',
          modelYear: '2003',
          errorCode: '6',
          errorText: 'Partial VIN decode — only 9 positions decoded',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));
    expect(text).toContain('Warning (errorCode: 6)');
    expect(text).toContain('Partial VIN decode');
  });

  it('format renders "Not available" when make/model/year all absent', () => {
    const output = {
      vehicles: [
        {
          vin: 'UNKNOWNVIN000',
          errorCode: '0',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));
    expect(text).toContain('Vehicle details:**');
    expect(text).toContain('Not available');
  });

  it('format renders trim even when make/model/year are absent', () => {
    const output = {
      vehicles: [
        {
          vin: 'UNKNOWNVIN000',
          trim: 'Sport',
          errorCode: '0',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));
    expect(text).toContain('Sport');
  });

  it('format renders safety equipment section when airbag data is present', () => {
    const output = {
      vehicles: [
        {
          vin: '1HGCM82633A004352',
          make: 'HONDA',
          model: 'ACCORD',
          modelYear: '2003',
          airBagLocFront: '1st Row',
          electronicStabilityControl: 'Standard',
          abs: 'Standard',
          errorCode: '0',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));
    expect(text).toContain('Safety Equipment');
    expect(text).toContain('Front airbags: 1st Row');
    expect(text).toContain('ESC: Standard');
    expect(text).toContain('ABS: Standard');
  });

  it('format omits safety equipment section when no safety fields present', () => {
    const output = {
      vehicles: [
        {
          vin: '1HGCM82633A004352',
          make: 'HONDA',
          model: 'ACCORD',
          modelYear: '2003',
          errorCode: '0',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));
    expect(text).not.toContain('Safety Equipment');
  });
});

describe('decodeVin — input schema validation', () => {
  it('Zod accepts a single string VIN', () => {
    const parsed = decodeVin.input.parse({ vin: '1HGCM82633A004352' });
    expect(parsed.vin).toBe('1HGCM82633A004352');
  });

  it('Zod accepts an array of VINs', () => {
    const parsed = decodeVin.input.parse({ vin: ['VIN1', 'VIN2'] });
    expect(parsed.vin).toEqual(['VIN1', 'VIN2']);
  });

  it('Zod accepts optional modelYear', () => {
    const parsed = decodeVin.input.parse({ vin: 'VIN1', modelYear: 2020 });
    expect(parsed.modelYear).toBe(2020);
  });

  it('rejects a fractional modelYear rather than forwarding it to VPIC', () => {
    expect(() => decodeVin.input.parse({ vin: 'VIN1', modelYear: 2020.5 })).toThrow();
  });

  it('accepts a pre-1980 modelYear — no lower bound is imposed', () => {
    expect(decodeVin.input.parse({ vin: 'VIN1', modelYear: 1968 }).modelYear).toBe(1968);
  });
});

describe('decodeVin — VIN parsing timing', () => {
  /** Sizes double from 1,000 to 64,000 characters: a 64× span, below Bun's regex tier switch. */
  const SIZES = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
  /** Thread CPU time one call may spend at any size, in microseconds. */
  const MAX_CPU_US_PER_CALL = 50_000;

  /** Least thread CPU time per call, in microseconds, over five batches of `calls` calls. */
  async function cpuPerCallUs(vin: string, calls: number): Promise<number> {
    const input = decodeVin.input.parse({ vin });
    const ctx = createMockContext({ errors: decodeVin.errors });
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) {
        await Promise.resolve(decodeVin.handler(input, ctx)).then(
          () => {
            throw new Error('Expected the timing input to be rejected');
          },
          (error: { data?: { reason?: string } }) => {
            if (error.data?.reason !== 'invalid_vin' && error.data?.reason !== 'empty_vin_list') {
              throw error;
            }
          },
        );
      }
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / calls);
    }
    return least;
  }

  it.each<[string, (size: number) => string]>([
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    [
      'joined full VINs with a bad last character',
      (n) => `${'1HGCM82633A004352;'.repeat(n / 18)}-`,
    ],
    [
      'joined VIN,YYYY chunks with a bad last character',
      (n) => `${'1HGCM82633A004352,2003 '.repeat(n / 23)}-`,
    ],
    ['a comma run that overlaps the VIN,YYYY form', (n) => '1,'.repeat(n / 2)],
    ['one long token with a bad last character', (n) => `${'A'.repeat(n)}-`],
  ])('parses %s in linear time', async (_shape, build) => {
    expect(mockService.decodeVin).not.toHaveBeenCalled();
    const perCall: number[] = [];
    for (const size of SIZES) {
      const cpuUs = await cpuPerCallUs(build(size), SIZES.at(-1)! / size);
      expect(cpuUs).toBeLessThan(MAX_CPU_US_PER_CALL);
      perCall.push(cpuUs);
    }
    expect(perCall.at(-1)! / perCall[0]!).toBeLessThan(256);
    expect(mockService.decodeVin).not.toHaveBeenCalled();
    expect(mockService.decodeVinBatch).not.toHaveBeenCalled();
  });
});
