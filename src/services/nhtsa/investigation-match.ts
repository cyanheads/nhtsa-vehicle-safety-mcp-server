/**
 * @fileoverview Investigation matching shared by nhtsa_search_investigations and
 * nhtsa_get_vehicle_safety: the vehicle-association match that decides which investigations cover
 * a make, model, and model year, the type-name lookup behind the `investigationType` filter, and
 * the type and status names both tools render.
 * @module services/nhtsa/investigation-match
 */

import type { Investigation } from './types.js';

/**
 * The five ODI investigation types with a published name, keyed by the type code that opens their
 * IDs. Other prefixes in the data (SQ, EQ, RP, ID, TA, C, …) have no name.
 */
export const INVESTIGATION_TYPE_MAP: ReadonlyMap<string, string> = new Map([
  ['PE', 'Preliminary Evaluation'],
  ['EA', 'Engineering Analysis'],
  ['DP', 'Defect Petition'],
  ['RQ', 'Recall Query'],
  ['AQ', 'Audit Query'],
]);

const STATUS_MAP: ReadonlyMap<string, string> = new Map([
  ['O', 'Open'],
  ['C', 'Closed'],
]);

/** Type code by lowercased type name, derived from INVESTIGATION_TYPE_MAP. */
const TYPE_CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  [...INVESTIGATION_TYPE_MAP].map(([code, name]) => [name.toLowerCase(), code]),
);

/** The type's name, or the code itself for a type without one. */
export function investigationTypeName(code: string): string {
  return INVESTIGATION_TYPE_MAP.get(code) ?? code;
}

/** The status's name ("Open", "Closed"), or the code itself for any other status. */
export function investigationStatusName(status: string): string {
  return STATUS_MAP.get(status) ?? status;
}

/**
 * The type code a caller's `investigationType` value selects. A type name matched whole after
 * trimming and ignoring case ("preliminary evaluation") gives its code ("PE"); any other value is
 * taken as a code, trimmed and uppercased. Whether that code exists is the caller's question: the
 * accepted codes are the ones the loaded records carry.
 */
export function investigationTypeCode(value: string): string {
  const trimmed = value.trim();
  return TYPE_CODE_BY_NAME.get(trimmed.toLowerCase()) ?? trimmed.toUpperCase();
}

/**
 * A vehicle filter: `make` and `model` match within an association's make and model ignoring case
 * ("Cherokee" matches "GRAND CHEROKEE"), `modelYear` matches its year exactly. Pass trimmed,
 * nonblank values; `undefined` leaves that field unfiltered.
 */
export interface InvestigationVehicleFilter {
  make?: string | undefined;
  model?: string | undefined;
  modelYear?: number | undefined;
}

/**
 * The model names on the investigation's vehicle associations that carry every supplied filter
 * value, all on the same association, in association order without repeats; `undefined` when no
 * association matches. A matching association with no model name adds none, so a match can come
 * back as `[]`. An association without a make, model, or year never matches a filter on it, and
 * an investigation with no associations never matches.
 */
export function matchedModels(
  investigation: Investigation,
  filter: InvestigationVehicleFilter,
): string[] | undefined {
  const make = filter.make?.toLowerCase();
  const model = filter.model?.toLowerCase();
  const { modelYear } = filter;
  let matched = false;
  const models: string[] = [];
  for (const vehicle of investigation.vehicles) {
    if (
      (make === undefined || (vehicle.make?.toLowerCase().includes(make) ?? false)) &&
      (model === undefined || (vehicle.model?.toLowerCase().includes(model) ?? false)) &&
      (modelYear === undefined || vehicle.year === modelYear)
    ) {
      matched = true;
      if (vehicle.model !== undefined && !models.includes(vehicle.model)) {
        models.push(vehicle.model);
      }
    }
  }
  return matched ? models : undefined;
}
