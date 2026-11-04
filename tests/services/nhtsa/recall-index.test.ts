/**
 * @fileoverview Tests for the recall flat-file index (#37), read through NhtsaService and the
 * real flat-file loader: grouping by campaign, the one-row vehicle match, ordering, paging, both
 * files, line endings, the shared load, and retained memory.
 * @module tests/services/nhtsa/recall-index
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { RecallSearch } from '@/services/nhtsa/recall-index.js';

const HOST = 'static.nhtsa.gov';
const POST_URL = `https://${HOST}/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip`;
const PRE_URL = `https://${HOST}/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip`;
const INV_URL = `https://${HOST}/odi/ffdd/inv/FLAT_INV.zip`;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('unmocked fetch'));
});

const encoder = new TextEncoder();

/** One recall-file row in the RCL.txt layout: 29 TAB-separated fields. */
interface RclRow {
  campaign: string;
  component?: string;
  consequence?: string;
  doNotDrive?: string;
  make?: string;
  manufacturer?: string;
  model?: string;
  /** NOTES, a column the index never reads. */
  notes?: string;
  parkOutside?: string;
  received?: string;
  remedy?: string;
  summary?: string;
  units?: string;
  year?: string;
}

function rcl(row: RclRow): string {
  const cells = Array.from({ length: 29 }, () => '');
  cells[0] = '1';
  cells[1] = row.campaign;
  cells[2] = row.make ?? 'TOYOTA';
  cells[3] = row.model ?? 'CAMRY';
  cells[4] = row.year ?? '2020';
  cells[6] = row.component ?? 'FUEL SYSTEM';
  cells[7] = row.manufacturer ?? 'Toyota Motor Engineering & Manufacturing';
  cells[11] = row.units ?? '100';
  cells[15] = row.received ?? '20250115';
  cells[19] = row.summary ?? 'Fuel may leak.';
  cells[20] = row.consequence ?? 'A fire may occur.';
  cells[21] = row.remedy ?? 'Dealers will replace the pipe.';
  cells[22] = row.notes ?? '';
  cells[27] = row.doNotDrive ?? 'No';
  cells[28] = row.parkOutside ?? 'No';
  return cells.join('\t');
}

/** A 200 response streaming a ZIP of `text` in 16 KB chunks, as a network body arrives. */
function zipResponse(name: string, text: string): Response {
  const zipped = zipSync({ [name]: [encoder.encode(text), { level: 1 }] });
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= zipped.length) {
          controller.close();
          return;
        }
        controller.enqueue(zipped.slice(offset, offset + 16 * 1024));
        offset += 16 * 1024;
      },
    }),
  );
}

/**
 * A PRE_2010 row the index skips, having no received date: a file the loader accepts that adds
 * no campaign, so a test's campaigns come from POST_2010 alone.
 */
const PRE_FILLER = rcl({ campaign: '09V000000', received: '' });

/** Serve the two recall files, CRLF-terminated as NHTSA publishes them. */
function serveRecallFiles(post: string[], pre: string[] = [PRE_FILLER]): void {
  mockFetch.mockImplementation(async (input: string) => {
    if (new URL(input).hostname !== HOST) throw new Error('unmocked fetch');
    if (input === POST_URL)
      return zipResponse('FLAT_RCL_POST_2010.txt', `${post.join('\r\n')}\r\n`);
    if (input === PRE_URL) return zipResponse('FLAT_RCL_PRE_2010.txt', `${pre.join('\r\n')}\r\n`);
    throw new Error(`unmocked fetch ${input}`);
  });
}

const everything = { offset: 0, limit: 1000 } as const;

async function search(query: Partial<RecallSearch>) {
  return await new NhtsaService().searchRecallFiles({ ...everything, ...query });
}

const campaigns = (page: { recalls: { campaignNumber: string }[] }) =>
  page.recalls.map((r) => r.campaignNumber);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Run a full, synchronous garbage collection under Bun or Node. */
function forceGc(): void {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
  if (bun) {
    bun.gc(true);
    return;
  }
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
}

describe('recall index records (#37)', () => {
  it('groups rows by campaign, joining its distinct components in file order', async () => {
    serveRecallFiles([
      rcl({ campaign: '25V100000', component: 'STEERING', year: '2020', doNotDrive: 'Yes' }),
      rcl({ campaign: '25V100000', component: 'SUSPENSION', year: '2021' }),
      rcl({ campaign: '25V100000', component: 'STEERING', year: '2022' }),
    ]);

    const page = await search({});

    expect(page.totalCount).toBe(1);
    expect(page.recalls[0]).toEqual({
      campaignNumber: '25V100000',
      component: 'STEERING | SUSPENSION',
      consequence: 'A fire may occur.',
      manufacturer: 'Toyota Motor Engineering & Manufacturing',
      parkIt: true,
      parkOutSide: false,
      potentialUnitsAffected: 100,
      remedy: 'Dealers will replace the pipe.',
      reportReceivedDate: '2025-01-15',
      summary: 'Fuel may leak.',
    });
  });

  it('takes the campaign fields from its first row only', async () => {
    serveRecallFiles([
      rcl({ campaign: '25V100000', summary: 'First.', received: '20250115' }),
      rcl({ campaign: '25V100000', summary: 'Second.', received: '20240101', units: '9' }),
    ]);

    const [recall] = (await search({})).recalls;

    expect(recall).toMatchObject({
      summary: 'First.',
      reportReceivedDate: '2025-01-15',
      potentialUnitsAffected: 100,
    });
  });

  it('omits blank text, unparseable units, and unreported advisories instead of inventing them', async () => {
    serveRecallFiles([
      rcl({
        campaign: '66V008001',
        received: '19661012',
        summary: '',
        consequence: ' ',
        remedy: '',
        units: '',
        doNotDrive: '',
        parkOutside: 'N/A',
        component: '',
      }),
    ]);

    const [recall] = (await search({})).recalls;

    expect(recall).toEqual({
      campaignNumber: '66V008001',
      manufacturer: 'Toyota Motor Engineering & Manufacturing',
      reportReceivedDate: '1966-10-12',
    });
  });

  it('skips rows with no campaign number or no YYYYMMDD received date', async () => {
    serveRecallFiles([
      rcl({ campaign: '' }),
      rcl({ campaign: '25V100000', received: '2025-01-15' }),
      rcl({ campaign: '25V200000', received: '' }),
      rcl({ campaign: '25V300000' }),
    ]);

    expect(campaigns(await search({}))).toEqual(['25V300000']);
  });
});

describe('recall index search (#37)', () => {
  it('matches vehicle filters within one row: a make from one row and a model from another never match', async () => {
    serveRecallFiles([
      rcl({ campaign: '25V000001', make: 'TOYOTA', model: 'CAMRY', year: '2020' }),
      rcl({ campaign: '25V000002', make: 'TOYOTA', model: 'COROLLA', year: '2019' }),
      rcl({ campaign: '25V000002', make: 'LEXUS', model: 'CAMRY', year: '2020' }),
      rcl({ campaign: '25V000003', make: 'TOYOTA', model: 'CAMRY', year: '2019' }),
      rcl({ campaign: '25V000003', make: 'TOYOTA', model: 'COROLLA', year: '2021' }),
    ]);

    expect(campaigns(await search({ make: 'Toyota', model: 'Camry' }))).toEqual([
      '25V000003',
      '25V000001',
    ]);
    expect(campaigns(await search({ model: 'CAMRY', modelYear: 2020 }))).toEqual([
      '25V000002',
      '25V000001',
    ]);
    expect(campaigns(await search({ model: 'Camry', modelYear: 2021 }))).toEqual([]);
    expect(campaigns(await search({ make: 'Lexus', model: 'Corolla' }))).toEqual([]);
  });

  it('matches whole make and model names, ignoring case', async () => {
    serveRecallFiles([
      rcl({ campaign: '25V000001', make: 'MERCEDES-BENz', model: 'SPRINTER 2500' }),
      rcl({ campaign: '25V000002', make: 'TOYOTA', model: 'CAMRY HYBRID' }),
    ]);

    expect(campaigns(await search({ make: 'Mercedes-Benz' }))).toEqual(['25V000001']);
    expect(campaigns(await search({ model: 'sprinter 2500' }))).toEqual(['25V000001']);
    expect(campaigns(await search({ model: 'Camry' }))).toEqual([]);
    expect(campaigns(await search({ make: 'Toyo' }))).toEqual([]);
  });

  it('never matches a model year the files record as 9999', async () => {
    serveRecallFiles([
      rcl({ campaign: '25E000001', make: 'GOODYEAR', model: 'TIRE', year: '9999' }),
    ]);

    expect(campaigns(await search({ modelYear: 9999 }))).toEqual([]);
    expect(campaigns(await search({ make: 'Goodyear' }))).toEqual(['25E000001']);
  });

  it('orders newest received date first, ties by campaign number descending', async () => {
    serveRecallFiles([
      rcl({ campaign: '24V500000', received: '20240601' }),
      rcl({ campaign: '25E000100', received: '20250301' }),
      rcl({ campaign: '25V000900', received: '20250301' }),
      rcl({ campaign: '25V000200', received: '20250301' }),
      rcl({ campaign: '26V000001', received: '20260101' }),
    ]);

    expect(campaigns(await search({}))).toEqual([
      '26V000001',
      '25V000900',
      '25V000200',
      '25E000100',
      '24V500000',
    ]);
  });

  it('applies inclusive received-date bounds', async () => {
    serveRecallFiles([
      rcl({ campaign: '25V000001', received: '20250101' }),
      rcl({ campaign: '25V000002', received: '20250102' }),
      rcl({ campaign: '24V000003', received: '20241231' }),
      rcl({ campaign: '25V000004', received: '20250201' }),
    ]);

    expect(
      campaigns(await search({ dateRange: { after: '2025-01-01', before: '2025-01-02' } })),
    ).toEqual(['25V000002', '25V000001']);
    expect(campaigns(await search({ dateRange: { before: '2024-12-31' } }))).toEqual(['24V000003']);
  });

  it('pages with an exact total, in order, and returns an empty page past the end', async () => {
    serveRecallFiles(
      Array.from({ length: 7 }, (_, i) =>
        rcl({ campaign: `25V00000${i}`, received: `2025010${i + 1}` }),
      ),
    );

    const first = await search({ offset: 0, limit: 3 });
    const last = await search({ offset: 6, limit: 3 });
    const past = await search({ offset: 7, limit: 3 });

    expect(first.totalCount).toBe(7);
    expect(campaigns(first)).toEqual(['25V000006', '25V000005', '25V000004']);
    expect(last.totalCount).toBe(7);
    expect(campaigns(last)).toEqual(['25V000000']);
    expect(past).toEqual({ recalls: [], totalCount: 7 });
  });
});

describe('recall files (#37)', () => {
  it('reads the post-2010 file, then the pre-2010 file, and reaches pre-2010 campaigns', async () => {
    serveRecallFiles(
      [rcl({ campaign: '25V000001', received: '20250101' })],
      [
        rcl({
          campaign: '67V009002',
          make: 'DODGE',
          model: 'DART',
          year: '1967',
          received: '19670310',
        }),
        rcl({
          campaign: '66V008001',
          make: 'DODGE',
          model: 'DART',
          year: '1967',
          received: '19661012',
        }),
      ],
    );

    const page = await search({ dateRange: { before: '2009-12-31' } });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([POST_URL, PRE_URL]);
    expect(campaigns(page)).toEqual(['67V009002', '66V008001']);
  });

  it('merges a campaign whose rows span both files into one record', async () => {
    serveRecallFiles(
      [rcl({ campaign: '09V500000', received: '20091230', component: 'BRAKES', model: 'A' })],
      [rcl({ campaign: '09V500000', received: '20091230', component: 'TIRES', model: 'B' })],
    );

    const page = await search({ model: 'B' });

    expect(page.totalCount).toBe(1);
    expect(page.recalls[0]!.component).toBe('BRAKES | TIRES');
  });

  it('parses CRLF endings, blank lines, and whitespace-only lines cleanly', async () => {
    const lines = [
      rcl({ campaign: '25V000001', parkOutside: 'Yes' }),
      '',
      '   ',
      rcl({ campaign: '25V000002', received: '20250116' }),
      '',
    ];
    serveRecallFiles(lines, ['', rcl({ campaign: '01V000001', received: '20010101' }), '']);

    const page = await search({});

    expect(campaigns(page)).toEqual(['25V000002', '25V000001', '01V000001']);
    expect(page.recalls[1]!.parkOutSide).toBe(true);
    for (const recall of page.recalls) {
      for (const value of Object.values(recall)) {
        if (typeof value === 'string') expect(value).not.toMatch(/[\r\n\t]/);
      }
    }
  });
});

describe('recall file loading (#37)', () => {
  it('shares one load among concurrent cold callers and serves later calls from the cache', async () => {
    serveRecallFiles([rcl({ campaign: '25V000001' })]);
    const svc = new NhtsaService();

    const [a, b] = await Promise.all([
      svc.searchRecallFiles({ ...everything, make: 'Toyota' }),
      svc.searchRecallFiles({ ...everything, make: 'Honda' }),
    ]);
    const c = await svc.searchRecallFiles({ ...everything });

    expect(a.totalCount).toBe(1);
    expect(b.totalCount).toBe(0);
    expect(c.totalCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails the callers of a failed load, caches nothing, and loads again on the next call', async () => {
    mockFetch.mockImplementation(async (input: string) => {
      if (new URL(input).hostname !== HOST) throw new Error('unmocked fetch');
      return new Response('not a zip', { status: 200 });
    });
    const svc = new NhtsaService();

    const failures = await Promise.all([
      svc.searchRecallFiles({ ...everything }).catch((e: unknown) => e),
      svc.searchRecallFiles({ ...everything }).catch((e: unknown) => e),
    ]);

    for (const failure of failures) {
      expect(failure).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);

    serveRecallFiles([rcl({ campaign: '25V000001' })]);
    expect((await svc.searchRecallFiles({ ...everything })).totalCount).toBe(1);
  });

  it('times out a load after 120 s, naming the recall data, and retries on the next call', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        (input: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (new URL(input).hostname !== HOST) reject(new Error('unmocked fetch'));
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const svc = new NhtsaService();
      let settled = false;
      const failure = svc.searchRecallFiles({ ...everything }).catch((e: unknown) => {
        settled = true;
        return e;
      });

      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await failure).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Loading NHTSA recall data did not finish within 120 s.',
      });

      serveRecallFiles([rcl({ campaign: '25V000001' })]);
      expect((await svc.searchRecallFiles({ ...everything })).totalCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for an investigations load to finish before reading the recall files', async () => {
    const inv = Promise.withResolvers<Response>();
    mockFetch.mockImplementation(async (input: string) => {
      if (new URL(input).hostname !== HOST) throw new Error('unmocked fetch');
      if (input === INV_URL) return inv.promise;
      if (input === POST_URL)
        return zipResponse('FLAT_RCL_POST_2010.txt', `${rcl({ campaign: '25V000001' })}\r\n`);
      if (input === PRE_URL) return zipResponse('FLAT_RCL_PRE_2010.txt', `${PRE_FILLER}\r\n`);
      throw new Error(`unmocked fetch ${input}`);
    });
    const svc = new NhtsaService();

    const investigations = svc.getInvestigations();
    await settle();
    const recalls = svc.searchRecallFiles({ ...everything });
    await settle();

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([INV_URL]);

    inv.resolve(zipResponse('FLAT_INV.txt', 'PE25001\tTOYOTA\tCAMRY\t2020\tBRAKES\tToyota\n'));
    await investigations;
    expect((await recalls).totalCount).toBe(1);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([INV_URL, POST_URL, PRE_URL]);
  });

  it('retains memory in proportion to the kept fields, not the decompressed files (#54)', async () => {
    const campaignCount = 256;
    const rowsPerCampaign = 32;
    const summaryChars = 4000;
    /**
     * Every row names a new model, so the index keeps a vehicle key from every row, and every
     * row repeats its campaign's long summary. The index keeps make and model as uppercased
     * copies, so this measures what the index keeps; the next test covers a kept field sliced
     * out of a decoded line.
     */
    let seed = 1;
    const letters = (count: number) =>
      Array.from({ length: count }, () => {
        seed = (seed * 48_271) % 2_147_483_647;
        return String.fromCharCode(97 + (seed % 26));
      }).join('');
    const lines: string[] = [];
    for (let c = 0; c < campaignCount; c++) {
      const summary = letters(summaryChars);
      for (let row = 0; row < rowsPerCampaign; row++) {
        lines.push(
          rcl({
            campaign: `25V${String(c).padStart(6, '0')}`,
            model: `MODEL ${c}-${row}`,
            component: `PART ${row % 4}`,
            summary,
          }),
        );
      }
    }
    const text = `${lines.join('\r\n')}\r\n`;
    const textBytes = encoder.encode(text).length;
    lines.length = 0;
    let post = `${rcl({ campaign: '25V000001' })}\r\n`;
    mockFetch.mockImplementation(async (input: string) => {
      if (new URL(input).hostname !== HOST) throw new Error('unmocked fetch');
      return input === POST_URL
        ? zipResponse('FLAT_RCL_POST_2010.txt', post)
        : zipResponse('FLAT_RCL_PRE_2010.txt', `${PRE_FILLER}\r\n`);
    });
    /**
     * A small load first, so state the loader creates once per process stays out of the
     * measure; a large one could stay reachable through a stale stack slot and hide the next.
     */
    await new NhtsaService().searchRecallFiles({ ...everything, limit: 1 });
    forceGc();
    const before = process.memoryUsage().heapUsed;
    post = text;

    const svc = new NhtsaService();
    const page = await svc.searchRecallFiles({ ...everything, model: `MODEL 255-31` });
    forceGc();
    const retained = process.memoryUsage().heapUsed - before;

    expect(page.totalCount).toBe(1);
    expect(page.recalls[0]!.component).toBe('PART 0 | PART 1 | PART 2 | PART 3');
    expect(retained).toBeLessThan(textBytes / 4);
    // Keep the service, and with it the index, alive through the measure.
    expect(svc).toBeInstanceOf(NhtsaService);
  });

  it('keeps no decoded line alive through the campaign fields it keeps (#54)', async () => {
    const campaignCount = 4096;
    /**
     * One row per campaign, its bulk in NOTES, which the index never reads. The index keeps the
     * row's manufacturer, summary, consequence, and remedy as decoded: one sliced out of the
     * decoded line would pin the whole line and put the retained heap near `textBytes`, while
     * fields decoded on their own keep only themselves.
     */
    const notes = 'N'.repeat(8000);
    const text = `${Array.from({ length: campaignCount }, (_, c) =>
      rcl({ campaign: `25V${String(c).padStart(6, '0')}`, notes }),
    ).join('\r\n')}\r\n`;
    const textBytes = encoder.encode(text).length;
    let post = `${rcl({ campaign: '25V000001' })}\r\n`;
    mockFetch.mockImplementation(async (input: string) => {
      if (new URL(input).hostname !== HOST) throw new Error('unmocked fetch');
      return input === POST_URL
        ? zipResponse('FLAT_RCL_POST_2010.txt', post)
        : zipResponse('FLAT_RCL_PRE_2010.txt', `${PRE_FILLER}\r\n`);
    });
    // A small load first, as in the test above.
    await new NhtsaService().searchRecallFiles({ ...everything, limit: 1 });
    forceGc();
    const before = process.memoryUsage().heapUsed;
    post = text;

    const svc = new NhtsaService();
    const page = await svc.searchRecallFiles({ ...everything, limit: 1 });
    forceGc();
    const retained = process.memoryUsage().heapUsed - before;

    expect(page.totalCount).toBe(campaignCount);
    expect(retained).toBeLessThan(textBytes / 4);
    expect(svc).toBeInstanceOf(NhtsaService);
  });
});
