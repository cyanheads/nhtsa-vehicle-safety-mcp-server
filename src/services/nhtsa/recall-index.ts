/**
 * @fileoverview In-memory index of NHTSA's recall flat files (FLAT_RCL_POST_2010 and
 * FLAT_RCL_PRE_2010): one record per campaign, grouped from the files' rows by campaign number
 * and searched by make, model, model year, and received date, newest first.
 * @module services/nhtsa/recall-index
 */

import type { DateRange } from './date-range.js';
import type { FlatFileRow, ReadFlatFile } from './flat-file.js';
import type { IndexedRecall } from './types.js';

/**
 * 0-based field positions in the recall files (layout: RCL.txt). A campaign's rows repeat its
 * campaign fields and differ in the make, model, model year, and component.
 */
const FIELD = {
  campaignNumber: 1,
  make: 2,
  model: 3,
  modelYear: 4,
  component: 6,
  manufacturer: 7,
  potentialUnitsAffected: 11,
  receivedDate: 15,
  summary: 19,
  consequence: 20,
  remedy: 21,
  doNotDrive: 27,
  parkOutside: 28,
} as const;

/** YEARTXT for a model year that is unknown or does not apply. */
const MODEL_YEAR_NOT_APPLICABLE = '9999';

/** Joins a campaign's distinct component descriptions into one `component` value. */
const COMPONENT_SEPARATOR = ' | ';

/**
 * One vehicle row's make, model, and model year, as a search compares them. Make and model are
 * uppercased, and every row naming the same vehicle shares one key across campaigns.
 */
interface VehicleKey {
  readonly make: string;
  readonly model: string;
  /** Undefined for a model year the row leaves unknown, which no model-year filter matches. */
  readonly modelYear: number | undefined;
}

interface Entry {
  readonly recall: IndexedRecall;
  readonly vehicles: readonly VehicleKey[];
}

/** A broad recall search. Absent filters match everything; vehicle filters match one row. */
export interface RecallSearch {
  dateRange?: DateRange | undefined;
  limit: number;
  /** Matched against the whole make name, ignoring case. */
  make?: string | undefined;
  /** Matched against the whole model name, ignoring case. */
  model?: string | undefined;
  modelYear?: number | undefined;
  offset: number;
}

/** One page of a {@link RecallSearch}, with the exact count of every match. */
export interface RecallSearchPage {
  recalls: IndexedRecall[];
  totalCount: number;
}

/** Descending order for strings compared by code unit. */
const descending = (a: string, b: string): number => Number(a < b) - Number(a > b);

/** The recall campaigns from the flat files, newest received date first, ties by campaign number descending. */
export class RecallIndex {
  private readonly entries: readonly Entry[];

  constructor(entries: Entry[]) {
    this.entries = entries.sort(
      (a, b) =>
        descending(a.recall.reportReceivedDate, b.recall.reportReceivedDate) ||
        descending(a.recall.campaignNumber, b.recall.campaignNumber),
    );
  }

  /** Campaigns in the index. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * The page of campaigns matching every filter in `query`. A campaign matches the vehicle
   * filters only when one of its rows carries all of them; a make from one row and a model from
   * another never match together. Date bounds are inclusive.
   */
  search(query: RecallSearch): RecallSearchPage {
    const make = query.make?.toUpperCase();
    const model = query.model?.toUpperCase();
    const { modelYear, offset, limit } = query;
    const after = query.dateRange?.after;
    const before = query.dateRange?.before;
    const byVehicle = Boolean(make || model || modelYear !== undefined);
    const matchesVehicle = (v: VehicleKey): boolean =>
      (!make || v.make === make) &&
      (!model || v.model === model) &&
      (modelYear === undefined || v.modelYear === modelYear);

    const recalls: IndexedRecall[] = [];
    let totalCount = 0;
    for (const { recall, vehicles } of this.entries) {
      const received = recall.reportReceivedDate;
      if ((after && received < after) || (before && received > before)) continue;
      if (byVehicle && !vehicles.some(matchesVehicle)) continue;
      if (totalCount >= offset && recalls.length < limit) recalls.push(recall);
      totalCount++;
    }
    return { recalls, totalCount };
  }
}

/**
 * Build the index from the recall flat files at `urls`, each read in turn through `read`. Rows
 * of one campaign merge into one record wherever they appear, across files included.
 */
export async function loadRecallIndex(
  read: ReadFlatFile,
  urls: readonly string[],
): Promise<RecallIndex> {
  const builder = new RecallIndexBuilder();
  for (const url of urls) await read(url, (row) => builder.add(row));
  return builder.build();
}

/** A campaign whose components and vehicle rows are still being collected. */
interface Draft {
  readonly components: string[];
  readonly recall: IndexedRecall;
  readonly vehicles: VehicleKey[];
}

/**
 * Groups rows by campaign number. A campaign's first row supplies its campaign fields; later
 * rows decode only the component and vehicle fields, never the text the files repeat. Every
 * kept string is a field decoded on its own or built from one, never a slice of file text.
 */
class RecallIndexBuilder {
  private readonly drafts = new Map<string, Draft>();
  /** One vehicle key per distinct uppercase make, model, and model year. */
  private readonly keys = new Map<string, VehicleKey>();
  /** One string per distinct uppercase make or model name. */
  private readonly names = new Map<string, string>();

  add(row: FlatFileRow): void {
    const campaignNumber = row.field(FIELD.campaignNumber);
    if (!campaignNumber) return;
    let draft = this.drafts.get(campaignNumber);
    if (!draft) {
      const recall = campaignFields(row, campaignNumber);
      if (!recall) return;
      draft = { components: [], recall, vehicles: [] };
      this.drafts.set(campaignNumber, draft);
    }

    const component = row.field(FIELD.component);
    if (component && !draft.components.includes(component)) draft.components.push(component);
    const vehicle = this.vehicleKey(row);
    if (vehicle && !draft.vehicles.includes(vehicle)) draft.vehicles.push(vehicle);
  }

  build(): RecallIndex {
    const entries: Entry[] = [];
    for (const { components, recall, vehicles } of this.drafts.values()) {
      if (components.length > 0) recall.component = components.join(COMPONENT_SEPARATOR);
      entries.push({ recall, vehicles });
    }
    return new RecallIndex(entries);
  }

  private name(raw: string): string {
    const upper = raw.toUpperCase();
    const known = this.names.get(upper);
    if (known !== undefined) return known;
    this.names.set(upper, upper);
    return upper;
  }

  /** The row's vehicle, or undefined when it names no make, model, or usable model year. */
  private vehicleKey(row: FlatFileRow): VehicleKey | undefined {
    const make = this.name(row.field(FIELD.make));
    const model = this.name(row.field(FIELD.model));
    const yearText = row.field(FIELD.modelYear);
    const modelYear =
      /^\d{4}$/.test(yearText) && yearText !== MODEL_YEAR_NOT_APPLICABLE
        ? Number(yearText)
        : undefined;
    if (!make && !model && modelYear === undefined) return;

    const id = `${make}\t${model}\t${modelYear ?? ''}`;
    let key = this.keys.get(id);
    if (!key) {
      key = { make, model, modelYear };
      this.keys.set(id, key);
    }
    return key;
  }
}

/**
 * The campaign fields of a campaign's first row, or undefined when its received date is not a
 * YYYYMMDD date: such a row has no place in a newest-first, date-bounded search.
 */
function campaignFields(row: FlatFileRow, campaignNumber: string): IndexedRecall | undefined {
  const reportReceivedDate = isoDate(row.field(FIELD.receivedDate));
  if (!reportReceivedDate) return;
  const units = row.field(FIELD.potentialUnitsAffected);
  const summary = row.field(FIELD.summary);
  const consequence = row.field(FIELD.consequence);
  const remedy = row.field(FIELD.remedy);
  const parkIt = advisory(row.field(FIELD.doNotDrive));
  const parkOutSide = advisory(row.field(FIELD.parkOutside));
  return {
    campaignNumber,
    manufacturer: row.field(FIELD.manufacturer),
    reportReceivedDate,
    ...(/^\d+$/.test(units) ? { potentialUnitsAffected: Number(units) } : {}),
    ...(summary ? { summary } : {}),
    ...(consequence ? { consequence } : {}),
    ...(remedy ? { remedy } : {}),
    ...(parkIt !== undefined ? { parkIt } : {}),
    ...(parkOutSide !== undefined ? { parkOutSide } : {}),
  };
}

/** A consumer advisory field: "Yes" or "No", anything else unreported. */
function advisory(value: string): boolean | undefined {
  if (value === 'Yes') return true;
  if (value === 'No') return false;
  return;
}

/** YYYYMMDD as YYYY-MM-DD, built from the digits' values so it shares no storage with the field. */
function isoDate(raw: string): string | undefined {
  if (!/^\d{8}$/.test(raw)) return;
  const yyyymmdd = Number(raw);
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(Math.trunc(yyyymmdd / 10_000), 4)}-${pad(Math.trunc(yyyymmdd / 100) % 100, 2)}-${pad(yyyymmdd % 100, 2)}`;
}
