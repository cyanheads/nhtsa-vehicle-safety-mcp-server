/**
 * @fileoverview Tests for nhtsa_decode_vin tool.
 * @module tests/mcp-server/tools/definitions/decode-vin.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
  driveType: 'FWD',
  engineCylinders: '4',
  engineDisplacementL: '2.4',
  engineHP: '160',
  fuelType: 'Gasoline',
  trim: 'EX',
  manufacturer: 'HONDA',
  plantCity: 'MARYSVILLE',
  plantState: 'OHIO',
  plantCountry: 'USA',
  airBagLocFront: '1st Row',
  airBagLocSide: '',
  airBagLocCurtain: '',
  airBagLocKnee: '',
  electronicStabilityControl: '',
  abs: '',
  tractionControl: '',
  errorCode: '0',
  errorText: '',
};

describe('decodeVin', () => {
  it('decodes a single VIN', async () => {
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM82633A004352' });
    const result = await decodeVin.handler(input, ctx);

    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0]!.make).toBe('HONDA');
    expect(mockService.decodeVin).toHaveBeenCalledWith(
      '1HGCM82633A004352',
      undefined,
      expect.anything(),
    );
  });

  it('passes modelYear when provided', async () => {
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM82633A004352', modelYear: 2003 });
    await decodeVin.handler(input, ctx);

    expect(mockService.decodeVin).toHaveBeenCalledWith(
      '1HGCM82633A004352',
      2003,
      expect.anything(),
    );
  });

  it('decodes batch of VINs', async () => {
    mockService.decodeVinBatch.mockResolvedValue([
      sampleVin,
      { ...sampleVin, vin: 'BBB', make: 'TOYOTA' },
    ]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: ['1HGCM82633A004352', 'BBB'] });
    const result = await decodeVin.handler(input, ctx);

    expect(result.vehicles).toHaveLength(2);
    expect(mockService.decodeVinBatch).toHaveBeenCalled();
  });

  it('throws on >50 VINs', async () => {
    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: Array.from({ length: 51 }, (_, i) => `VIN${i}`) });
    await expect(decodeVin.handler(input, ctx)).rejects.toThrow(/50/);
  });

  it('format renders vehicle details', () => {
    const output = { vehicles: [sampleVin] };
    const blocks = decodeVin.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('HONDA');
    expect(text).toContain('ACCORD');
    expect(text).toContain('160 HP');
    expect(text).toContain('MARYSVILLE');
  });

  it('format states a clean decode rather than rendering nothing', () => {
    const output = {
      vehicles: [
        {
          ...sampleVin,
          errorCode: '0',
          errorText: '0 - VIN decoded clean. Check Digit (9th position) is correct',
        },
      ],
    };
    const text = firstText(decodeVin.format!(output));

    expect(text).toContain('**Decode status (errorCode: 0):**');
    expect(text).toContain('VIN decoded clean');
    expect(text).not.toContain('Warning (errorCode');
  });

  it('format falls back to plain clean-decode wording when VPIC sends no errorText', () => {
    const output = { vehicles: [{ ...sampleVin, errorCode: '0', errorText: '' }] };
    const text = firstText(decodeVin.format!(output));

    expect(text).toContain(
      '**Decode status (errorCode: 0):** VPIC decoded this VIN with no errors.',
    );
  });

  it('format renders no decode-status line when VPIC omitted errorCode', () => {
    const output = { vehicles: [{ vin: '1HGCM82633A004352', make: 'HONDA' }] };
    const text = firstText(decodeVin.format!(output));

    expect(text).not.toContain('Decode status');
    expect(text).not.toContain('Warning (errorCode');
  });

  it('returns empty vehicles when service returns null (empty VPIC results)', async () => {
    // #8 fix: decodeVin service now returns null instead of throwing on empty Results[]
    mockService.decodeVin.mockResolvedValue(null);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: 'TEST' });
    const result = await decodeVin.handler(input, ctx);

    expect(result.vehicles).toHaveLength(0);
    // format() should render "No VIN decode results."
    const text = firstText(decodeVin.format!(result));
    expect(text).toContain('No VIN decode results.');
  });

  it('populates effectiveQuery enrichment for single VIN', async () => {
    // #14 fix: ctx.enrich({ effectiveQuery }) surfaces batch/count context
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM82633A004352' });
    await decodeVin.handler(input, ctx);

    expect(getEnrichment(ctx).effectiveQuery).toBe('1 VIN (single)');
  });

  it('populates effectiveQuery enrichment for batch VINs', async () => {
    mockService.decodeVinBatch.mockResolvedValue([sampleVin, { ...sampleVin, vin: 'BBB' }]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: ['1HGCM82633A004352', 'BBB'] });
    await decodeVin.handler(input, ctx);

    expect(getEnrichment(ctx).effectiveQuery).toBe('2 VINs (batch)');
  });

  it('populates notice enrichment for partial decode (non-zero errorCode)', async () => {
    // #14 fix: ctx.enrich.notice() flags partial decodes
    const partialVin = { ...sampleVin, errorCode: '6', errorText: 'Partial VIN decode' };
    mockService.decodeVin.mockResolvedValue(partialVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM82633A004352' });
    await decodeVin.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/VPIC warnings/i);
    expect(notice).toMatch(/errorCode/i);
  });

  it('does not populate notice enrichment when errorCode is 0 or absent', async () => {
    mockService.decodeVin.mockResolvedValue({ ...sampleVin, errorCode: '0' });

    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: '1HGCM82633A004352' });
    await decodeVin.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});
