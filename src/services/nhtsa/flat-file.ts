/**
 * @fileoverview Loader for NHTSA's bulk flat files: ZIP archives of TAB-delimited text on the
 * ODI bulk file server. Streams the download through inflate and splits lines and fields at the
 * byte level, so no file is ever held as one string and every field a consumer keeps is decoded
 * into a string of its own. Loads take turns through one process-wide slot, and each value built
 * from the files sits behind a shared, deadline-bounded load with a TTL cache.
 * @module services/nhtsa/flat-file
 */

import { type McpError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { Unzip, UnzipInflate } from 'fflate';

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;

/** Starting size of the buffer that assembles a line spanning chunks; it doubles as needed. */
const INITIAL_CARRY_BYTES = 64 * 1024;

/**
 * Decodes one field at a time. A string decoded from its own bytes owns its storage, while a
 * `split`, `slice`, or `trim` result of a larger string can reference that string instead (V8
 * sliced strings, JSC substrings) and keep the whole decoded text reachable for as long as the
 * field lives.
 */
const fieldDecoder = new TextDecoder('utf-8');

/** One line of a flat file. Valid only during the `onRow` call that receives it. */
export interface FlatFileRow {
  /**
   * Field `index` (0-based), trimmed as `String.prototype.trim` would, decoded into a fresh
   * string that shares no storage with the file text and is safe to retain. `''` when the
   * field is blank or past the end of the line. Decodes on every call.
   */
  field(index: number): string;
  /** TAB-separated fields on the line, as `line.split('\t').length` counts them. */
  readonly fieldCount: number;
}

/** Reads one flat file within the load that received it; see {@link FlatFileCache}. */
export type ReadFlatFile = (url: string, onRow: (row: FlatFileRow) => void) => Promise<void>;

/** Options for {@link FlatFileCache}. */
export interface FlatFileCacheOptions<T> {
  /** Names the data in the timeout error: `Loading <label> did not finish within <N> s.` */
  label: string;
  /**
   * Builds the value from one or more flat files, each read through `read`. Every `read`
   * waits its turn for the process-wide load slot under this load's deadline.
   */
  load: (read: ReadFlatFile) => Promise<T>;
  /** One deadline for a whole load: every slot wait, download, and parse inside it. */
  timeoutMs: number;
  /** How long a loaded value is served, counted from the moment its load finished. */
  ttlMs: number;
}

/**
 * A value built from NHTSA flat files, loaded on first use and cached for `ttlMs`. Concurrent
 * callers share one pending load. A caller's abort rejects only that caller: the load runs on
 * for the others and for the cache, bounded by its own `timeoutMs` deadline. A failed or
 * timed-out load caches nothing, so the next call starts a fresh one.
 */
export class FlatFileCache<T> {
  private cached: { fetchedAt: number; value: T } | undefined;
  private readonly options: FlatFileCacheOptions<T>;
  private pending: Promise<T> | undefined;

  constructor(options: FlatFileCacheOptions<T>) {
    this.options = options;
  }

  /**
   * The cached value, or the value of the shared load, starting one when none is pending.
   * Rejects with `signal.reason` when `signal` aborts, with a `Timeout` error when the load
   * misses its deadline, and with the load's own error otherwise.
   */
  async get(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.cached && Date.now() - this.cached.fetchedAt < this.options.ttlMs) {
      return this.cached.value;
    }
    this.pending ??= this.startLoad().finally(() => {
      this.pending = undefined;
    });
    const pending = this.pending;
    if (!signal) return await pending;

    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async startLoad(): Promise<T> {
    const { label, load, timeoutMs } = this.options;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException(`Loading ${label} timed out.`, 'TimeoutError')),
      timeoutMs,
    );
    try {
      const value = await load((url, onRow) =>
        readFlatFile(url, onRow, deadline.signal, timeoutMs),
      );
      this.cached = { fetchedAt: Date.now(), value };
      return value;
    } catch (error) {
      if (!deadline.signal.aborted) throw error;
      throw timeout(`Loading ${label} did not finish within ${timeoutMs / 1000} s.`, undefined, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * One flat-file load at a time, process-wide. A load inflates a file of several hundred
 * megabytes and holds its working set until the parse ends, so taking turns bounds peak memory
 * by the largest single load rather than the sum of concurrent ones. Waiters are served in
 * arrival order; a waiter whose signal aborts leaves the queue.
 */
class LoadSlot {
  private held = false;
  private readonly waiters = new Set<() => void>();

  async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(grant);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(grant);
    });
  }

  /** Hand the slot to the longest waiter, or free it. */
  release(): void {
    const [next] = this.waiters;
    if (next === undefined) {
      this.held = false;
      return;
    }
    this.waiters.delete(next);
    next();
  }
}

const loadSlot = new LoadSlot();

/** Hold the load slot while streaming every row of the ZIP at `url`; `signal` bounds the wait. */
async function readFlatFile(
  url: string,
  onRow: (row: FlatFileRow) => void,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await loadSlot.acquire(signal);
  try {
    await streamRows(url, onRow, signal, timeoutMs);
  } finally {
    loadSlot.release();
  }
}

/**
 * Download the ZIP at `url` and pass every non-empty line of each entry to `onRow` as the
 * inflated bytes arrive. Rejects with `ServiceUnavailable` when the body does not unzip into
 * at least one complete entry, or when its entries hold no line; an error thrown by `onRow`
 * propagates unchanged and stops the download.
 */
async function streamRows(
  url: string,
  onRow: (row: FlatFileRow) => void,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const fileName = url.slice(url.lastIndexOf('/') + 1);
  const res = await fetchWithTimeout(
    url,
    // `signal` carries the load's deadline and fires no later than this one.
    timeoutMs,
    requestContextService.createRequestContext({
      operation: 'readFlatFile',
      additionalContext: { file: fileName },
    }),
    { signal },
  );
  if (!res.body) throw unreadable(fileName);

  /** Set by the entry callbacks, which run inside `unzip.push` and must not throw through it. */
  let entryFailure: { error: unknown } | undefined;
  let completedEntries = 0;
  let rows = 0;
  const countRow = (row: FlatFileRow): void => {
    rows++;
    onRow(row);
  };
  const unzip = new Unzip((file) => {
    const lines = new LineSplitter(countRow);
    file.ondata = (error, chunk, final) => {
      if (entryFailure) return;
      if (error) {
        entryFailure = { error: unreadable(fileName, error) };
        return;
      }
      try {
        lines.push(chunk);
        if (final) {
          lines.end();
          completedEntries++;
        }
      } catch (rowError) {
        entryFailure = { error: rowError };
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const push = (chunk: Uint8Array, final: boolean): void => {
    try {
      unzip.push(chunk, final);
    } catch (error) {
      throw unreadable(fileName, error);
    }
    if (entryFailure) throw entryFailure.error;
  };

  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    try {
      signal.throwIfAborted();
      push(value, false);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
  }
  push(new Uint8Array(0), true);
  if (completedEntries === 0) throw unreadable(fileName);
  /** An archive that unzips to nothing is a failed publish, not a dataset with no records. */
  if (rows === 0) throw serviceUnavailable(`NHTSA bulk file ${fileName} holds no rows.`);
}

/** The upstream answered with bytes that do not unzip into a complete entry. */
function unreadable(fileName: string, cause?: unknown): McpError {
  return serviceUnavailable(
    `NHTSA bulk file ${fileName} is not a readable ZIP archive.`,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Splits a byte stream into lines on LF, drops a CR before the LF, and skips empty lines. A
 * line spanning chunks is assembled in `carry`, which grows by doubling so a long line costs
 * linear time. TAB and LF bytes never occur inside a multi-byte UTF-8 sequence, so splitting
 * bytes never cuts a character.
 */
class LineSplitter {
  private carry = new Uint8Array(INITIAL_CARRY_BYTES);
  private carryLength = 0;
  private readonly onRow: (row: FlatFileRow) => void;
  private readonly row = new LineRow();

  constructor(onRow: (row: FlatFileRow) => void) {
    this.onRow = onRow;
  }

  /** Emit the final line, which has no LF after it. */
  end(): void {
    this.emit(this.carry.subarray(0, this.carryLength));
    this.carryLength = 0;
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    let lf = chunk.indexOf(LF);
    if (this.carryLength > 0) {
      if (lf === -1) {
        this.append(chunk);
        return;
      }
      this.append(chunk.subarray(0, lf));
      this.emit(this.carry.subarray(0, this.carryLength));
      this.carryLength = 0;
      start = lf + 1;
      lf = chunk.indexOf(LF, start);
    }
    for (; lf !== -1; lf = chunk.indexOf(LF, start)) {
      this.emit(chunk.subarray(start, lf));
      start = lf + 1;
    }
    this.append(chunk.subarray(start));
  }

  private append(bytes: Uint8Array): void {
    const needed = this.carryLength + bytes.length;
    if (needed > this.carry.length) {
      let size = this.carry.length * 2;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.carry.subarray(0, this.carryLength));
      this.carry = grown;
    }
    this.carry.set(bytes, this.carryLength);
    this.carryLength = needed;
  }

  private emit(line: Uint8Array): void {
    const end = line.at(-1) === CR ? line.length - 1 : line.length;
    if (end > 0) this.onRow(this.row.set(line.subarray(0, end)));
  }
}

/** The ASCII characters `String.prototype.trim` removes: TAB, LF, VT, FF, CR, and SPACE. */
function isAsciiTrimmable(byte: number | undefined): boolean {
  return byte === SPACE || (byte !== undefined && byte >= TAB && byte <= CR);
}

/** The {@link FlatFileRow} handed to `onRow`, re-pointed at each line in turn. */
class LineRow implements FlatFileRow {
  private line: Uint8Array = new Uint8Array(0);
  /** Start offset of each field in `line`, then `line.length + 1` as the end sentinel. */
  private readonly starts: number[] = [];

  get fieldCount(): number {
    return this.starts.length - 1;
  }

  field(index: number): string {
    let start = this.starts[index];
    const next = this.starts[index + 1];
    if (start === undefined || next === undefined) return '';
    let end = next - 1;
    const { line } = this;
    while (start < end && isAsciiTrimmable(line[start])) start++;
    while (end > start && isAsciiTrimmable(line[end - 1])) end--;
    if (start === end) return '';
    /**
     * The byte trim keeps ASCII padding out of the decode; `trim()` then removes non-ASCII
     * whitespace (NBSP, ideographic space) exactly as it would on the whole line, and any
     * slice it takes references only this field's own string.
     */
    return fieldDecoder.decode(line.subarray(start, end)).trim();
  }

  set(line: Uint8Array): this {
    this.line = line;
    this.starts.length = 0;
    this.starts.push(0);
    for (let tab = line.indexOf(TAB); tab !== -1; tab = line.indexOf(TAB, tab + 1)) {
      this.starts.push(tab + 1);
    }
    this.starts.push(line.length + 1);
    return this;
  }
}
