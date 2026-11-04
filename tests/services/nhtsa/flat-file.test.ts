/**
 * @fileoverview Tests for the NHTSA flat-file loader: streamed rows and their fields, unreadable
 * archives, the process-wide load slot, and the shared, deadline-bounded cache.
 * @module tests/services/nhtsa/flat-file
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlatFileCache, type FlatFileCacheOptions } from '@/services/nhtsa/flat-file.js';

const HOST = 'static.nhtsa.gov';
const FLAT_URL = `https://${HOST}/odi/ffdd/test/FLAT_TEST.zip`;
const OTHER_URL = `https://${HOST}/odi/ffdd/test/FLAT_OTHER.zip`;
const THIRD_URL = `https://${HOST}/odi/ffdd/test/FLAT_THIRD.zip`;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('unmocked fetch'));
});

const encoder = new TextEncoder();

/** A ZIP of one entry holding `text`; level 0 stores it, so input chunks reach the rows as-is. */
function zipOf(text: string, level: 0 | 6 = 6): Uint8Array {
  return zipSync({ 'FLAT.txt': [encoder.encode(text), { level }] });
}

/** A 200 response whose body streams `bytes` in chunks of `chunkBytes`. */
function streamed(bytes: Uint8Array, chunkBytes = bytes.length, onCancel?: () => void): Response {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkBytes));
        offset += chunkBytes;
      },
      cancel() {
        onCancel?.();
      },
    }),
  );
}

/** Serve `respond(url)` for requests to the bulk file host; anything else stays unmocked. */
function serve(respond: (url: string) => Response | Promise<Response>): void {
  mockFetch.mockImplementation((input: string) => {
    if (new URL(input).hostname !== HOST) return Promise.reject(new Error('unmocked fetch'));
    return Promise.resolve(respond(input));
  });
}

/** A response that never arrives; it rejects with the abort reason when the request aborts. */
function stalled(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) =>
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
  );
}

/** A cache whose value is every row of `urls`, each row as its list of fields. */
function rowsCache(
  overrides: Partial<FlatFileCacheOptions<string[][]>> & { urls?: string[] } = {},
): FlatFileCache<string[][]> {
  const { urls = [FLAT_URL], ...options } = overrides;
  return new FlatFileCache<string[][]>({
    label: 'test data',
    timeoutMs: 120_000,
    ttlMs: 60_000,
    load: async (read) => {
      const rows: string[][] = [];
      for (const url of urls) {
        await read(url, (row) =>
          rows.push(Array.from({ length: row.fieldCount }, (_, i) => row.field(i))),
        );
      }
      return rows;
    },
    ...options,
  });
}

/** Let pending promise chains and stream pulls run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('FlatFileCache rows', () => {
  it('splits LF and CRLF lines, skips empty lines, and trims fields as String#trim does', async () => {
    serve(() =>
      streamed(zipOf('A\t B \tC\r\n\r\n\nD\t\tE\n  \t \n F \tG　\r\nlast\tline without a newline')),
    );
    const outOfRange: string[] = [];
    const cache = rowsCache({
      load: async (read) => {
        const rows: string[][] = [];
        await read(FLAT_URL, (row) => {
          rows.push(Array.from({ length: row.fieldCount }, (_, i) => row.field(i)));
          outOfRange.push(row.field(row.fieldCount), row.field(-1));
        });
        return rows;
      },
    });

    expect(await cache.get()).toEqual([
      ['A', 'B', 'C'],
      ['D', '', 'E'],
      ['', ''],
      ['F', 'G'],
      ['last', 'line without a newline'],
    ]);
    expect(new Set(outOfRange)).toEqual(new Set(['']));
  });

  it.each([
    ['stored', 0],
    ['deflated', 6],
  ] as const)(
    'reassembles lines and characters cut at every byte boundary (%s entry)',
    async (_label, level) => {
      // 2-, 3-, and 4-byte UTF-8 sequences, a CRLF, and TABs, delivered one byte per chunk.
      serve(() =>
        streamed(zipOf('ID1\tCafé “quoted” ’s\t€100\r\nID2\t😀 grin\t\nID3\tñ', level), 1),
      );

      expect(await rowsCache().get()).toEqual([
        ['ID1', 'Café “quoted” ’s', '€100'],
        ['ID2', '😀 grin', ''],
        ['ID3', 'ñ'],
      ]);
    },
  );

  it('assembles a line longer than the line buffer across many chunks', async () => {
    const long = 'é'.repeat(150_000); // 300,000 bytes: the buffer must grow more than once
    serve(() => streamed(zipOf(`HEAD\t${long}\tTAIL\nNEXT\n`, 0), 4096));

    const rows = await rowsCache().get();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toBe('HEAD');
    expect(rows[0]?.[1]).toBe(long);
    expect(rows[0]?.[2]).toBe('TAIL');
    expect(rows[1]).toEqual(['NEXT']);
  });

  it('parses every line of a deflated file streamed in small chunks', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => [`R${i}`, `make ${i % 7}`, `naïve ${i}`]);
    serve(() => streamed(zipOf(`${lines.map((l) => l.join('\t')).join('\n')}\n`), 997));

    expect(await rowsCache().get()).toEqual(lines);
  });

  it('reads every entry of the archive in order', async () => {
    serve(() =>
      streamed(
        zipSync({
          'A.txt': encoder.encode('A1\tx\nA2\ty'),
          'B.txt': encoder.encode('B1\tz\n'),
        }),
        64,
      ),
    );

    expect(await rowsCache().get()).toEqual([
      ['A1', 'x'],
      ['A2', 'y'],
      ['B1', 'z'],
    ]);
  });
});

describe('FlatFileCache failures', () => {
  it('surfaces an upstream HTTP error, caches nothing, and loads on the next call', async () => {
    serve(() => new Response('Service Unavailable', { status: 503 }));
    const cache = rowsCache();

    const error = await cache.get().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503 },
    });
    serve(() => streamed(zipOf('ok\t1\n')));
    expect(await cache.get()).toEqual([['ok', '1']]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  const valid = zipOf(
    Array.from({ length: 500 }, (_, i) => `ID${i}\tvalue ${(i * 7919) % 10007}\n`).join(''),
  );
  /** The single entry's compressed bytes: after the 30-byte local header, name, and extra field. */
  const header = new DataView(valid.buffer, valid.byteOffset);
  const dataStart = 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + header.getUint32(18, true);
  const corrupt = valid.slice();
  corrupt.fill(0xff, dataStart, dataEnd);

  it.each([
    ['an HTML page', () => new Response('<html><body>Down for maintenance</body></html>')],
    ['an empty body', () => new Response(new Uint8Array(0))],
    ['no body', () => new Response(null)],
    ['an archive with no entries', () => streamed(zipSync({}))],
    [
      'an archive cut off inside its entry',
      () => streamed(valid.slice(0, Math.floor((dataStart + dataEnd) / 2)), 64),
    ],
    ['corrupt compressed data', () => streamed(corrupt, 64)],
  ])('rejects %s as an unreadable archive and retries on the next call', async (_label, body) => {
    serve(body);
    const cache = rowsCache();

    const error = await cache.get().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'NHTSA bulk file FLAT_TEST.zip is not a readable ZIP archive.',
    });
    serve(() => streamed(valid));
    expect(await cache.get()).toHaveLength(500);
  });

  it.each([
    ['an empty entry', ''],
    ['an entry of blank lines', '\n\r\n\n'],
  ])(
    'rejects an archive with %s as holding no rows and retries on the next call',
    async (_label, text) => {
      serve(() => streamed(zipOf(text)));
      const cache = rowsCache();

      const error = await cache.get().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'NHTSA bulk file FLAT_TEST.zip holds no rows.',
      });
      serve(() => streamed(zipOf('ok\t1\n')));
      expect(await cache.get()).toEqual([['ok', '1']]);
    },
  );

  it('rethrows a row handler error unchanged and stops the download', async () => {
    const cancelled = vi.fn();
    serve(() => streamed(zipOf('row\t1\n'.repeat(5000), 0), 512, cancelled));
    const failure = new Error('row handler failed');
    const cache = rowsCache({
      load: async (read) => {
        await read(FLAT_URL, () => {
          throw failure;
        });
        return [];
      },
    });

    await expect(cache.get()).rejects.toBe(failure);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe('FlatFileCache load slot', () => {
  it('runs one flat-file load at a time, in arrival order', async () => {
    let active = 0;
    let maxActive = 0;
    const firstResponse = Promise.withResolvers<Response>();
    /** Counts a load as active from its request until its body has been read to the end. */
    const tracked = (text: string): Response => {
      const bytes = zipOf(text);
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              active--;
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(bytes);
          },
        }),
      );
    };
    mockFetch.mockImplementation((input: string) => {
      if (new URL(input).hostname !== HOST) return Promise.reject(new Error('unmocked fetch'));
      active++;
      maxActive = Math.max(maxActive, active);
      return input === FLAT_URL ? firstResponse.promise : Promise.resolve(tracked(input));
    });

    const first = rowsCache().get();
    await settle();
    const second = rowsCache({ urls: [OTHER_URL] }).get();
    const third = rowsCache({ urls: [THIRD_URL] }).get();
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    firstResponse.resolve(tracked('first\t1\n'));
    const values = await Promise.all([first, second, third]);

    expect(maxActive).toBe(1);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([FLAT_URL, OTHER_URL, THIRD_URL]);
    expect(values[0]).toEqual([['first', '1']]);
    expect(values[1]).toHaveLength(1);
    expect(values[2]).toHaveLength(1);
  });

  it('fails a load whose deadline passes while it waits, then frees the slot after a timed-out load', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation((input: string, init: RequestInit) => {
        if (new URL(input).hostname !== HOST) return Promise.reject(new Error('unmocked fetch'));
        return input === FLAT_URL ? stalled(init) : Promise.resolve(streamed(zipOf('b\t2\n')));
      });
      const holder = rowsCache().get();
      const holderError = holder.catch((e: unknown) => e);
      const waiter = rowsCache({ urls: [OTHER_URL], timeoutMs: 30_000 });
      const waiterError = waiter.get().catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(await waiterError).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Loading test data did not finish within 30 s.',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90_000);

      expect(await holderError).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Loading test data did not finish within 120 s.',
      });
      expect(await waiter.get()).toEqual([['b', '2']]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('charges a load the time it waited for the slot', async () => {
    vi.useFakeTimers();
    try {
      const firstResponse = Promise.withResolvers<Response>();
      mockFetch.mockImplementation((input: string, init: RequestInit) => {
        if (new URL(input).hostname !== HOST) return Promise.reject(new Error('unmocked fetch'));
        return input === FLAT_URL ? firstResponse.promise : stalled(init);
      });
      const first = rowsCache().get();
      let waiterSettled = false;
      const waiterError = rowsCache({ urls: [OTHER_URL], timeoutMs: 30_000 })
        .get()
        .catch((e: unknown) => e)
        .finally(() => {
          waiterSettled = true;
        });

      await vi.advanceTimersByTimeAsync(20_000);
      firstResponse.resolve(streamed(zipOf('a\t1\n')));
      expect(await first).toEqual([['a', '1']]);

      // 20 s waiting plus 9.999 s fetching: still inside the 30 s deadline.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(waiterSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await waiterError).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Loading test data did not finish within 30 s.',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the slot after a failed load for the next one in line', async () => {
    const firstResponse = Promise.withResolvers<Response>();
    serve((url) => (url === FLAT_URL ? firstResponse.promise : streamed(zipOf('next\tload\n'))));
    const failed = rowsCache()
      .get()
      .catch((e: unknown) => e);
    await settle();
    const next = rowsCache({ urls: [OTHER_URL] }).get();

    firstResponse.resolve(new Response('Bad Gateway', { status: 502 }));

    expect(await failed).toMatchObject({ data: { status: 502 } });
    expect(await next).toEqual([['next', 'load']]);
  });
});

describe('FlatFileCache shared load', () => {
  it('shares one load among concurrent callers and serves the cache afterwards', async () => {
    const response = Promise.withResolvers<Response>();
    serve(() => response.promise);
    const cache = rowsCache();

    const calls = [cache.get(), cache.get(), cache.get()];
    response.resolve(streamed(zipOf('one\tload\n')));
    const [a, b, c] = await Promise.all(calls);

    expect(a).toEqual([['one', 'load']]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await cache.get()).toBe(a);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects only the caller that aborts; the load finishes for the others', async () => {
    const response = Promise.withResolvers<Response>();
    serve(() => response.promise);
    const cache = rowsCache();
    const leaving = new AbortController();
    const staying = new AbortController();
    const removals = [leaving, staying].map((c) => vi.spyOn(c.signal, 'removeEventListener'));

    const left = cache.get(leaving.signal);
    const stayed = cache.get(staying.signal);
    await settle();
    leaving.abort();

    await expect(left).rejects.toBe(leaving.signal.reason);
    response.resolve(streamed(zipOf('still\there\n')));
    const value = await stayed;
    expect(value).toEqual([['still', 'here']]);
    expect(await cache.get()).toBe(value);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    for (const removal of removals) {
      expect(removal).toHaveBeenCalledWith('abort', expect.any(Function));
    }
  });

  it('starts no load for a caller that has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(rowsCache().get(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('serves the value until ttlMs after its load finished, then loads again', async () => {
    const start = Date.UTC(2026, 0, 1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      let loads = 0;
      serve(() => {
        loads++;
        clock.mockReturnValue(start + 5_000); // the load finishes 5 s after it started
        return streamed(zipOf(`load\t${loads}\n`));
      });
      const cache = rowsCache({ ttlMs: 60_000 });

      const first = await cache.get();
      clock.mockReturnValue(start + 5_000 + 59_999);
      expect(await cache.get()).toBe(first);

      clock.mockReturnValue(start + 5_000 + 60_000);
      expect(await cache.get()).toEqual([['load', '2']]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});
