/**
 * @fileoverview Tests for nhtsa_decode_vin tool.
 * @module tests/mcp-server/tools/definitions/decode-vin.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nhtsa/nhtsa-service.js', () => ({
  getNhtsaService: vi.fn(),
  initNhtsaService: vi.fn(),
}));

/** The server's clamp mode, flipped per test; the environment parsing has its own suite. */
const serverConfig = vi.hoisted(() => ({ clampLimits: true }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => serverConfig }));

import { decodeVin } from '@/mcp-server/tools/definitions/decode-vin.tool.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { firstText, readerText } from '../../../helpers/content.js';

const mockService = {
  decodeVin: vi.fn(),
  decodeVinBatch: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getNhtsaService).mockReturnValue(mockService as any);
  for (const fn of Object.values(mockService)) fn.mockReset();
  serverConfig.clampLimits = true;
});

/** A distinct, well-formed 17-character VIN per index. */
const vin17 = (i: number) => `1HGCM82633A${String(i).padStart(6, '0')}`;

/** The `structuredContent` of a tool result, success or error. */
function structuredOf(result: { structuredContent?: unknown }): Record<string, any> {
  return (result.structuredContent ?? {}) as Record<string, any>;
}

/** What a `content[]` reader sees, through a CommonMark parse. */
function textOf(result: { content?: unknown }): string {
  return readerText((result.content ?? []) as { type: string; text?: string }[]);
}

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

  it('throws batch_too_large on >50 VINs when the server rejects over-cap batches', async () => {
    serverConfig.clampLimits = false;
    const ctx = createMockContext({ errors: decodeVin.errors });
    const input = decodeVin.input.parse({ vin: Array.from({ length: 51 }, (_, i) => `VIN${i}`) });
    await expect(decodeVin.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'batch_too_large' },
      message: expect.stringMatching(/51 VINs.*at most 50/),
    });
    expect(mockService.decodeVinBatch).not.toHaveBeenCalled();
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

describe('decodeVin — VIN grammar (#49)', () => {
  const A = '1HGCM82633A004352';
  const B = '2T3P1RFV5MW145243';

  /** Run the handler and return the rejection, asserting nothing reached the service. */
  async function rejectionOf(vin: string | string[]) {
    const ctx = createMockContext({ errors: decodeVin.errors });
    const error = await Promise.resolve(
      decodeVin.handler(decodeVin.input.parse({ vin }), ctx),
    ).then(
      () => undefined,
      (e: unknown) => e as { message: string; data?: { reason?: string } },
    );
    expect(mockService.decodeVin).not.toHaveBeenCalled();
    expect(mockService.decodeVinBatch).not.toHaveBeenCalled();
    if (!error) throw new Error('Expected the handler to reject');
    return error;
  }

  it.each([
    ['a comma-joined string', `${A},${B}`],
    ['a comma-and-space-joined string', `${A}, ${B}`],
    ['a space-joined string', `${A} ${B}`],
    ['a newline-joined string', `${A}\n${B}`],
    ['a semicolon-joined string', `${A};${B}`],
    ['a joined array entry', [`${A}, ${B}`]],
  ])('decodes every VIN %s names, as one batch', async (_shape, vin) => {
    mockService.decodeVinBatch.mockResolvedValue([sampleVin, { ...sampleVin, vin: B }]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin }), ctx);

    expect(mockService.decodeVin).not.toHaveBeenCalled();
    expect(mockService.decodeVinBatch).toHaveBeenCalledWith([{ vin: A }, { vin: B }], ctx.signal);
    expect(getEnrichment(ctx).effectiveQuery).toBe('2 VINs (batch)');
  });

  it('flattens joined entries in order and counts the flattened VINs', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: [`${A};${B}`, '5YJ3E1EA*KF'] }), ctx);

    expect(mockService.decodeVinBatch).toHaveBeenCalledWith(
      [{ vin: A }, { vin: B }, { vin: '5YJ3E1EA*KF' }],
      ctx.signal,
    );
    expect(getEnrichment(ctx).effectiveQuery).toBe('3 VINs (batch)');
  });

  it('gives a VIN,YYYY chunk its own model year on the single path', async () => {
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: `${A},2003`, modelYear: 1999 }), ctx);

    expect(mockService.decodeVin).toHaveBeenCalledWith(A, 2003, ctx.signal);
  });

  it('gives a VIN,YYYY batch entry its own year over modelYear, and modelYear to the rest', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(
      decodeVin.input.parse({ vin: [`${A},2003`, B, '5YJ3E1EA*KF,2019'], modelYear: 2021 }),
      ctx,
    );

    expect(mockService.decodeVinBatch).toHaveBeenCalledWith(
      [
        { vin: A, modelYear: 2003 },
        { vin: B, modelYear: 2021 },
        { vin: '5YJ3E1EA*KF', modelYear: 2019 },
      ],
      ctx.signal,
    );
  });

  it('sends and echoes fullwidth digits as ASCII', async () => {
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: `１${A.slice(1)}` }), ctx);

    expect(mockService.decodeVin).toHaveBeenCalledWith(A, undefined, ctx.signal);
  });

  it.each([
    ['lowercase', '1hgcm82633a004352'],
    ['mixed case', '1hGcM82633a004352'],
    ['a one-character partial', '1'],
    ['an 8-character partial', '1HGCM826'],
    ['a 16-character partial', '1HGCM82633A00435'],
    ['a bare 4-digit partial', '2003'],
    ['* at the first and last position', '*HGCM82633A00435*'],
    ['* in the middle', '1HGCM826*3A*04352'],
    ['I, O, and Q, which VPIC flags', '1HGCM82633IOQ4352'],
  ])('passes %s through as sent', async (_shape, vin) => {
    mockService.decodeVin.mockResolvedValue({ ...sampleVin, vin });

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin }), ctx);

    expect(mockService.decodeVin).toHaveBeenCalledWith(vin, undefined, ctx.signal);
  });

  it('trims surrounding whitespace before decoding', async () => {
    mockService.decodeVin.mockResolvedValue(sampleVin);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: ` \t${A}\r\n ` }), ctx);

    expect(mockService.decodeVin).toHaveBeenCalledWith(A, undefined, ctx.signal);
  });

  it('decodes partial VINs sent one per array entry as a batch', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);

    const ctx = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: ['5YJ3E1EA*KF', '1HGCM826'] }), ctx);

    expect(mockService.decodeVinBatch).toHaveBeenCalledWith(
      [{ vin: '5YJ3E1EA*KF' }, { vin: '1HGCM826' }],
      ctx.signal,
    );
  });

  it('rejects a character outside the VIN alphabet, naming the entry, position, and character', async () => {
    const error = await rejectionOf([`${A}&format=xml`, B]);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain(`vin[0]: "${A}&format=xml" has "&" at position 18`);
  });

  it('rejects an 18-character VIN rather than decoding its first 17', async () => {
    const error = await rejectionOf(`${A}X`);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain(`vin: "${A}X" is 18 characters`);
    expect(error.message).toContain('at most 17');
  });

  it.each([
    ['-', '"-"'],
    ['_', '"_"'],
    ['?', '"?"'],
    ['#', '"#"'],
    [':', '":"'],
    ['<', '"<"'],
    ['&', '"&"'],
    ['.', '"."'],
    ['/', '"/"'],
    ['\\', '"\\"'],
    ['%', '"%"'],
    ['+', '"+"'],
    ['Ä', '"Ä" (U+00C4)'],
    ['А', '"А" (U+0410)'],
    ['​', 'U+200B'],
  ])('rejects %j inside a VIN with invalid_vin', async (char, named) => {
    const error = await rejectionOf(['2T3P1RFV5MW145243', `1HGCM${char}82633A004352`]);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain(`vin[1]: `);
    expect(error.message).toContain(`has ${named} at position 6`);
    expect(error.message).toContain('only the letters A-Z (any case), digits, and *');
  });

  it.each([
    ['inner space', '1HGCM 82633A004352'],
    ['inner tab', '1HGCM\t82633A004352'],
  ])('rejects %s, which splits one VIN into partials', async (_shape, vin) => {
    const error = await rejectionOf(vin);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain('vin: "1HGCM" is 5 characters');
    expect(error.message).toContain('only full 17-character VINs');
  });

  it('rejects a partial VIN joined with others in one string', async () => {
    const error = await rejectionOf(`5YJ3E1EA*KF,${A}`);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain('"5YJ3E1EA*KF" is 11 characters');
  });

  it.each([
    ['a 2-digit year', `${A},03`, '"03" is 2 characters'],
    ['a 5-digit year', `${A},20031`, '"20031" is 5 characters'],
  ])('reads %s after a VIN as a partial VIN, not a model year', async (_shape, vin, named) => {
    const error = await rejectionOf(vin);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain(named);
  });

  it('quotes at most 32 characters of an overlong entry in the message', async () => {
    const error = await rejectionOf(`${'A'.repeat(40)}-`);

    expect(error.data?.reason).toBe('invalid_vin');
    expect(error.message).toContain(`vin: "${'A'.repeat(32)}…" has "-" at position 41`);
    expect(error.message).not.toContain('A'.repeat(33));
  });

  it.each<[string, string | string[], string]>([
    ['a blank scalar', '  \t ', 'vin names no VIN'],
    ['a blank array entry', [A, '  '], 'vin[1] names no VIN'],
    ['an entry holding only separators', [A, ' ; , '], 'vin[1] names no VIN'],
  ])('rejects %s with empty_vin_list', async (_shape, vin, named) => {
    const error = await rejectionOf(vin);

    expect(error.data?.reason).toBe('empty_vin_list');
    expect(error.message).toContain(named);
  });

  it('carries invalid_vin and its recovery on both surfaces', async () => {
    const result = await runToolContract(decodeVin, { vin: '1HGCM-82633A004352' });

    expect(result.isError).toBe(true);
    const error = structuredOf(result).error;
    expect(error.data.reason).toBe('invalid_vin');
    expect(error.data.recovery.hint).toBeTypeOf('string');
    const text = textOf(result);
    expect(text).toContain('vin: "1HGCM-82633A004352" has "-" at position 6');
    expect(text).toContain(error.data.recovery.hint);
    expect(text).toContain('(reason invalid_vin');
  });
});

describe('decodeVin — batch cap (#53)', () => {
  /** 57 VINs sent as 19 three-VIN strings, so the cap counts VINs after splitting. */
  const joined57 = Array.from({ length: 19 }, (_, entry) =>
    [0, 1, 2].map((k) => vin17(entry * 3 + k)).join(';'),
  );

  it('decodes a batch at the cap whole, deferring nothing', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);

    const result = await runToolContract(decodeVin, {
      vin: Array.from({ length: 50 }, (_, i) => vin17(i)),
    });

    expect(mockService.decodeVinBatch.mock.calls[0]![0]).toHaveLength(50);
    expect(structuredOf(result)).not.toHaveProperty('deferredVins');
    expect(structuredOf(result).effectiveQuery).toBe('50 VINs (batch)');
    expect(structuredOf(result)).not.toHaveProperty('notice');
  });

  it('decodes the first 50 of 57 and defers the other 7 in order, on both surfaces', async () => {
    mockService.decodeVinBatch.mockResolvedValue([{ ...sampleVin, vin: vin17(0), errorCode: '1' }]);
    const vins = [...joined57];
    vins[18] = `${vin17(54)};${vin17(55)},2010;${vin17(56)}`;

    const result = await runToolContract(decodeVin, { vin: vins, modelYear: 2003 });

    const sent = mockService.decodeVinBatch.mock.calls[0]![0];
    expect(sent).toHaveLength(50);
    expect(sent[0]).toEqual({ vin: vin17(0), modelYear: 2003 });
    expect(sent[49]).toEqual({ vin: vin17(49), modelYear: 2003 });

    const deferred = [
      `${vin17(50)},2003`,
      `${vin17(51)},2003`,
      `${vin17(52)},2003`,
      `${vin17(53)},2003`,
      `${vin17(54)},2003`,
      `${vin17(55)},2010`,
      `${vin17(56)},2003`,
    ];
    const structured = structuredOf(result);
    expect(result.isError).toBeFalsy();
    expect(structured.deferredVins).toEqual(deferred);
    expect(structured.effectiveQuery).toBe('57 VINs (batch): decoded 50, deferred 7');
    expect(structured.notice).toContain('57 VINs');
    expect(structured.notice).toContain('first 50');
    expect(structured.notice).toContain('deferredVins');
    expect(structured.notice).toContain('VPIC warnings');

    const text = textOf(result);
    for (const entry of deferred) expect(text).toContain(entry);
    expect(text).toContain('Deferred VINs (7)');
  });

  it('writes one clamp log line, labelled vin, only when it defers VINs', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);
    const clampLines = (log: unknown) =>
      (log as MockContextLogger).calls.filter((c) => c.msg === 'Clamped an over-cap request');

    const over = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(decodeVin.input.parse({ vin: joined57 }), over);
    const atCap = createMockContext({ errors: decodeVin.errors });
    await decodeVin.handler(
      decodeVin.input.parse({ vin: Array.from({ length: 50 }, (_, i) => vin17(i)) }),
      atCap,
    );

    expect(clampLines(over.log).map((c) => c.data)).toEqual([
      { tool: 'nhtsa_decode_vin', input: 'vin', requested: 57, applied: 50 },
    ]);
    expect(clampLines(atCap.log)).toEqual([]);
  });

  it('accepts deferredVins back as vin, keeping each VIN its model year', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);
    const first = await runToolContract(decodeVin, { vin: joined57, modelYear: 2003 });
    mockService.decodeVinBatch.mockClear();

    await runToolContract(decodeVin, { vin: structuredOf(first).deferredVins });

    expect(mockService.decodeVinBatch.mock.calls[0]![0]).toEqual(
      [50, 51, 52, 53, 54, 55, 56].map((i) => ({ vin: vin17(i), modelYear: 2003 })),
    );
  });

  it('rejects 51 VINs with batch_too_large when the server rejects over-cap batches', async () => {
    serverConfig.clampLimits = false;

    const result = await runToolContract(decodeVin, { vin: joined57.slice(0, 17) });

    expect(structuredOf(result).error.data.reason).toBe('batch_too_large');
    expect(structuredOf(result).error.message).toContain('51 VINs');
    expect(mockService.decodeVinBatch).not.toHaveBeenCalled();
  });

  it('takes exactly 500 VINs after splitting: decodes 50 and defers 450', async () => {
    mockService.decodeVinBatch.mockResolvedValue([]);
    const vin = Array.from({ length: 25 }, (_, entry) =>
      Array.from({ length: 20 }, (_, k) => vin17(entry * 20 + k)).join(' '),
    );

    const result = await runToolContract(decodeVin, { vin });

    expect(result.isError).toBeFalsy();
    expect(mockService.decodeVinBatch.mock.calls[0]![0]).toHaveLength(50);
    expect(structuredOf(result).deferredVins).toHaveLength(450);
    expect(structuredOf(result).effectiveQuery).toBe('500 VINs (batch): decoded 50, deferred 450');
  });

  it.each([true, false])(
    'rejects more than 500 VINs after splitting with batch_too_large (clamping %s)',
    async (clampLimits) => {
      serverConfig.clampLimits = clampLimits;
      const vin = Array.from({ length: 26 }, (_, entry) =>
        Array.from({ length: 20 }, (_, k) => vin17(entry * 20 + k)).join(' '),
      );

      const result = await runToolContract(decodeVin, { vin });

      expect(structuredOf(result).error.data.reason).toBe('batch_too_large');
      expect(structuredOf(result).error.message).toContain('520 VINs');
      expect(structuredOf(result).error.message).toContain('500');
      expect(mockService.decodeVinBatch).not.toHaveBeenCalled();
    },
  );

  it('advertises at most 500 array entries and rejects 501 at the schema', () => {
    const advertised = z.toJSONSchema(decodeVin.input, { io: 'input' }) as unknown as {
      properties: { vin: { anyOf: { type: string; maxItems?: number }[] } };
    };
    expect(advertised.properties.vin.anyOf.find((s) => s.type === 'array')?.maxItems).toBe(500);
    expect(decodeVin.input.safeParse({ vin: Array.from({ length: 500 }, () => 'A') }).success).toBe(
      true,
    );
    expect(decodeVin.input.safeParse({ vin: Array.from({ length: 501 }, () => 'A') }).success).toBe(
      false,
    );
  });
});

describe('decodeVin — driver-assistance equipment (#50)', () => {
  /** The 2021 RAV4 (2T3P1RFV5MW145243) as the service normalizes VPIC's decode. */
  const rav4 = {
    vin: '2T3P1RFV5MW145243',
    make: 'TOYOTA',
    model: 'RAV4',
    modelYear: '2021',
    errorCode: '0',
    crashImminentBraking: 'Standard',
    dynamicBrakeSupport: 'Standard',
    pedestrianAutomaticEmergencyBraking: 'Standard',
    forwardCollisionWarning: 'Standard',
    laneDepartureWarning: 'Standard',
    laneKeepingAssistance: 'Standard',
    laneCenteringAssistance: 'Standard',
    blindSpotWarning: 'Standard',
    rearCrossTrafficAlert: 'Standard',
    backupCamera: 'Standard',
    adaptiveCruiseControl: 'Standard',
    tpmsType: 'Direct',
    airBagLocSeatCushion: 'Passenger Seat Only',
  };
  const lines = [
    'Crash Imminent Braking (CIB): Standard',
    'Dynamic Brake Support (DBS): Standard',
    'Pedestrian Automatic Emergency Braking (PAEB): Standard',
    'Forward Collision Warning (FCW): Standard',
    'Lane Departure Warning (LDW): Standard',
    'Lane Keeping Assistance (LKA): Standard',
    'Lane Centering Assistance: Standard',
    'Blind Spot Warning (BSW): Standard',
    'Rear Cross Traffic Alert: Standard',
    'Backup Camera: Standard',
    'Adaptive Cruise Control (ACC): Standard',
    'Tire Pressure Monitoring System (TPMS) Type: Direct',
    'Seat Cushion Air Bag Locations: Passenger Seat Only',
  ];

  it('returns the fields VPIC decodes on both surfaces, under Safety Equipment', async () => {
    mockService.decodeVin.mockResolvedValue(rav4);

    const result = await runToolContract(decodeVin, { vin: rav4.vin });

    const [vehicle] = structuredOf(result).vehicles;
    expect(vehicle).toEqual(rav4);
    for (const absent of [
      'blindSpotIntervention',
      'rearAutomaticEmergencyBraking',
      'parkingAssist',
    ]) {
      expect(vehicle).not.toHaveProperty(absent);
    }
    const text = textOf(result);
    const safety = text.slice(text.indexOf('Safety Equipment:'));
    for (const line of lines) expect(safety).toContain(line);
    expect(text).not.toContain('does not record whether');
  });

  it('states the Optional caveat when a rendered field is Optional', async () => {
    mockService.decodeVin.mockResolvedValue({
      vin: '5YJ3E1EA*KF',
      make: 'TESLA',
      parkingAssist: 'Optional',
      adaptiveCruiseControl: 'Optional',
    });

    const result = await runToolContract(decodeVin, { vin: '5YJ3E1EA*KF' });

    const text = textOf(result);
    expect(text).toContain('Parking Assist: Optional');
    expect(text).toContain('Adaptive Cruise Control (ACC): Optional');
    expect(text).toContain(
      'Optional: offered on this configuration; the VIN does not record whether this vehicle has it.',
    );
  });

  it('renders no new lines for a VIN VPIC leaves the equipment blank on', async () => {
    mockService.decodeVin.mockResolvedValue({ ...sampleVin, airBagLocFront: '1st Row' });

    const result = await runToolContract(decodeVin, { vin: sampleVin.vin });

    const text = textOf(result);
    expect(text).toContain('Front airbags: 1st Row');
    for (const line of lines) expect(text).not.toContain(line.slice(0, line.indexOf(':')));
    expect(text).not.toContain('does not record whether');
  });

  it('names each new field’s value set in its description', () => {
    const shape = decodeVin.output.shape.vehicles.element.shape;
    for (const field of [
      'crashImminentBraking',
      'dynamicBrakeSupport',
      'pedestrianAutomaticEmergencyBraking',
      'forwardCollisionWarning',
      'laneDepartureWarning',
      'laneKeepingAssistance',
      'laneCenteringAssistance',
      'blindSpotWarning',
      'blindSpotIntervention',
      'rearCrossTrafficAlert',
      'backupCamera',
      'rearAutomaticEmergencyBraking',
      'parkingAssist',
      'adaptiveCruiseControl',
    ] as const) {
      expect(shape[field].description).toMatch(/Standard, Optional, or Not Available/);
      expect(shape[field].description).toContain('does not record whether');
    }
    expect(shape.tpmsType.description).toMatch(/Direct or Indirect/);
    expect(shape.airBagLocSeatCushion.description).toMatch(/Driver Seat Only.*All Rows/);
  });
});
