/**
 * @fileoverview NHTSA API client service. Wraps five public APIs (Recalls, Complaints,
 * Safety Ratings, Investigations, VPIC) with field normalization and caching.
 * @module services/nhtsa/nhtsa-service
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { Unzip, UnzipInflate } from 'fflate';

import type {
  Complaint,
  DecodedVin,
  Investigation,
  NhtsaResponse,
  RawComplaint,
  RawRecallByVehicle,
  RawRecallCampaignDirect,
  RawSafetyRating,
  RawSafetyRatingVariant,
  RawVpicDecodedVin,
  Recall,
  RecallCampaign,
  SafetyRating,
  SafetyRatingVariant,
  VpicMake,
  VpicManufacturer,
  VpicModel,
  VpicResponse,
  VpicVehicleType,
} from './types.js';

const NHTSA_API = 'https://api.nhtsa.gov';
const VPIC_API = 'https://vpic.nhtsa.dot.gov/api';
const ODI_FLAT_INV_URL = 'https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const INVESTIGATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (matches daily file cadence)

/** Normalize sparse upstream strings by trimming and omitting blank values. */
function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Preserve numeric values only when the upstream actually provided them. */
function normalizeOptionalNumber(value?: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * NHTSA returns "12/31/1969" (Unix epoch at US local TZ) for missing dateOfIncident values.
 * Any date before 1990 (the earliest plausible NHTSA complaint) is treated as missing.
 */
function normalizeComplaintIncidentDate(value?: string | null): string | undefined {
  const date = normalizeOptionalString(value);
  if (!date) return;
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) return date;
  return new Date(parsed).getUTCFullYear() < 1990 ? undefined : date;
}

type DefinedOptionalFields<T extends Record<string, unknown>> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function omitUndefined<T extends Record<string, unknown>>(value: T): DefinedOptionalFields<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as DefinedOptionalFields<T>;
}

function normalizeDisplacementLiters(value?: string): string | undefined {
  if (!value) return value;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return value;
  const rounded = Math.round(numeric * 10) / 10;
  return rounded === 0 ? value : String(rounded);
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

/**
 * Detect an NHTSA empty-result envelope on a 400 response.
 * Different endpoints use different casing:
 *   recallsByVehicle:    { Count, Message, results }  (PascalCase Count/Message)
 *   complaintsByVehicle: { count, message, results }  (lowercase)
 * We accept either casing so both paths return empty success instead of throwing.
 */
function isEmptyResultEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  const msg =
    typeof b['Message'] === 'string' ? b['Message'] : (b['message'] as string | undefined);
  const hasResultsArray = Array.isArray(b['results']) || Array.isArray(b['Results']);
  return (
    hasResultsArray &&
    typeof msg === 'string' &&
    msg.toLowerCase().includes('results returned successfully')
  );
}

/** Internal fetchJson init — widens RequestInit.signal to allow `undefined` under exactOptionalPropertyTypes. */
type FetchInit = Omit<RequestInit, 'signal'> & { signal?: AbortSignal | undefined };

export class NhtsaService {
  private investigationCache: { data: Investigation[]; fetchedAt: number } | null = null;

  // ── HTTP ─────────────────────────────────────────────────────────

  private async fetchJson<T>(url: string, init?: FetchInit): Promise<T> {
    const signal = init?.signal ?? undefined;
    let lastError: Error | undefined;
    const endpoint = new URL(url).pathname;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), undefined, { signal });
      }
      const composed = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: composed });
      } catch (error) {
        signal?.throwIfAborted();
        lastError = toError(error, `NHTSA API request failed for ${endpoint}`);
        continue;
      }
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (error) {
          lastError = toError(error, `NHTSA API returned invalid JSON for ${endpoint}`);
          continue;
        }
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = await httpErrorFromResponse(res, { service: 'NHTSA', data: { endpoint } });
        continue;
      }
      if (res.status === 400) {
        // NHTSA returns 400 + a success envelope for valid vehicles with no records:
        // recallsByVehicle:   {"Count":0,"Message":"Results returned successfully","results":[]}
        // complaintsByVehicle: {"count":0,"message":"Results returned successfully","results":[]}
        // Detect case-insensitively — return as empty T rather than throwing.
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw await httpErrorFromResponse(res, { service: 'NHTSA', data: { endpoint } });
        }
        if (isEmptyResultEnvelope(body)) {
          return body as T;
        }
        throw await httpErrorFromResponse(res, { service: 'NHTSA', data: { endpoint } });
      }
      throw await httpErrorFromResponse(res, { service: 'NHTSA', data: { endpoint } });
    }
    throw lastError ?? new Error(`NHTSA API request failed after ${MAX_RETRIES} retries`);
  }

  // ── Recalls ──────────────────────────────────────────────────────

  /** Fetch all recalls for a specific vehicle (no pagination). */
  async getRecallsByVehicle(
    make: string,
    model: string,
    modelYear: number,
    signal?: AbortSignal,
  ): Promise<Recall[]> {
    const params = new URLSearchParams({ make, model, modelYear: String(modelYear) });
    const data = await this.fetchJson<NhtsaResponse<RawRecallByVehicle>>(
      `${NHTSA_API}/recalls/recallsByVehicle?${params}`,
      { signal },
    );
    return (data.results ?? []).map(normalizeRecallByVehicle);
  }

  /**
   * Look up a recall campaign by campaign number via the direct NHTSA endpoint.
   * Returns null if the campaign is not found.
   */
  async getRecallCampaign(
    campaignId: string,
    signal?: AbortSignal,
  ): Promise<RecallCampaign | null> {
    const params = new URLSearchParams({ campaignNumber: campaignId });
    const data = await this.fetchJson<NhtsaResponse<RawRecallCampaignDirect>>(
      `${NHTSA_API}/recalls/campaignNumber?${params}`,
      { signal },
    );
    const raw = (data.results ?? data.Results ?? [])[0];
    return raw ? normalizeRecallCampaignDirect(raw) : null;
  }

  // ── Complaints ───────────────────────────────────────────────────

  /** Fetch all complaints for a specific vehicle (no pagination). */
  async getComplaintsByVehicle(
    make: string,
    model: string,
    modelYear: number,
    signal?: AbortSignal,
  ): Promise<Complaint[]> {
    const params = new URLSearchParams({ make, model, modelYear: String(modelYear) });
    const data = await this.fetchJson<NhtsaResponse<RawComplaint>>(
      `${NHTSA_API}/complaints/complaintsByVehicle?${params}`,
      { signal },
    );
    return (data.results ?? []).map(normalizeComplaint);
  }

  // ── Safety Ratings ───────────────────────────────────────────────

  /** Get NCAP vehicle variants for a make/model/year. */
  async getSafetyRatingVariants(
    modelYear: number,
    make: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<SafetyRatingVariant[]> {
    const data = await this.fetchJson<NhtsaResponse<RawSafetyRatingVariant>>(
      `${NHTSA_API}/SafetyRatings/modelyear/${modelYear}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}`,
      { signal },
    );
    return (data.Results ?? [])
      .filter((r): r is RawSafetyRatingVariant & { VehicleId: number } => r.VehicleId != null)
      .map((r) => ({
        vehicleId: r.VehicleId,
        ...omitUndefined({
          vehicleDescription: normalizeOptionalString(r.VehicleDescription),
        }),
      }));
  }

  /** Get full safety rating detail for a specific vehicle ID. */
  async getSafetyRating(vehicleId: number, signal?: AbortSignal): Promise<SafetyRating | null> {
    const data = await this.fetchJson<NhtsaResponse<RawSafetyRating>>(
      `${NHTSA_API}/SafetyRatings/VehicleId/${vehicleId}`,
      { signal },
    );
    const raw = (data.Results ?? [])[0];
    return raw?.VehicleId != null ? normalizeSafetyRating(raw) : null;
  }

  // ── VIN Decode ───────────────────────────────────────────────────

  /** Decode a single VIN via VPIC. Returns null when VPIC returns an empty Results[]. */
  async decodeVin(
    vin: string,
    modelYear?: number,
    signal?: AbortSignal,
  ): Promise<DecodedVin | null> {
    const yearParam = modelYear ? `&modelyear=${modelYear}` : '';
    const data = await this.fetchJson<VpicResponse<RawVpicDecodedVin>>(
      `${VPIC_API}/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json${yearParam}`,
      { signal },
    );
    const raw = data.Results[0];
    if (!raw) return null;
    return normalizeDecodedVin(raw, vin);
  }

  /** Batch decode up to 50 VINs via VPIC POST endpoint. */
  async decodeVinBatch(
    entries: Array<{ vin: string; modelYear?: number }>,
    signal?: AbortSignal,
  ): Promise<DecodedVin[]> {
    const dataStr = entries.map((e) => (e.modelYear ? `${e.vin},${e.modelYear}` : e.vin)).join(';');
    const body = `DATA=${dataStr}&format=json`;
    const data = await this.fetchJson<VpicResponse<RawVpicDecodedVin>>(
      `${VPIC_API}/vehicles/DecodeVINValuesBatch/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      },
    );
    return data.Results.map((result, index) => normalizeDecodedVin(result, entries[index]?.vin));
  }

  // ── Investigations ───────────────────────────────────────────────

  /** Get all investigations from cache, refreshing if stale (24 h TTL). */
  async getInvestigations(signal?: AbortSignal): Promise<Investigation[]> {
    if (
      this.investigationCache &&
      Date.now() - this.investigationCache.fetchedAt < INVESTIGATION_CACHE_TTL_MS
    ) {
      return this.investigationCache.data;
    }
    const data = await this.fetchFlatInvestigations(signal);
    this.investigationCache = { data, fetchedAt: Date.now() };
    return data;
  }

  /**
   * Download FLAT_INV.zip from the ODI bulk file server, decompress via fflate's
   * synchronous streaming inflate, and parse each TAB-delimited line into the grouped
   * investigations map as it arrives. The 371 MB raw file is never held whole in memory —
   * lines are parsed and discarded on the fly; only the ~5K deduped records are retained.
   * Synchronous `UnzipInflate` fires `ondata` synchronously during each `push`, so the
   * terminal `resolve()` is reached only after every line has been parsed (no async race).
   */
  private async fetchFlatInvestigations(signal?: AbortSignal): Promise<Investigation[]> {
    const res = await fetch(ODI_FLAT_INV_URL, { signal: signal ?? null });
    if (!res.ok || !res.body) {
      throw await httpErrorFromResponse(res, {
        service: 'NHTSA ODI',
        data: { url: ODI_FLAT_INV_URL },
      });
    }

    const grouped = new Map<string, Investigation>();

    await new Promise<void>((resolve, reject) => {
      const decoder = new TextDecoder('utf-8');
      let partial = '';

      const unzip = new Unzip();
      unzip.register(UnzipInflate);

      unzip.onfile = (file) => {
        // FLAT_INV.zip contains exactly one TAB-delimited file.
        file.ondata = (err, chunk, final) => {
          if (err) {
            reject(err);
            return;
          }
          partial += decoder.decode(chunk, { stream: !final });
          const parts = partial.split('\n');
          partial = parts.pop() ?? '';
          for (const line of parts) mergeFlatInvLine(line, grouped);
          if (final && partial.length > 0) {
            mergeFlatInvLine(partial, grouped);
            partial = '';
          }
        };
        file.start();
      };

      const reader = res.body!.getReader();
      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            try {
              unzip.push(new Uint8Array(0), true);
            } catch (e) {
              reject(e);
              return;
            }
            resolve();
            return;
          }
          try {
            unzip.push(value);
          } catch (e) {
            reject(e);
            return;
          }
          pump();
        }, reject);
      };
      pump();
    });

    return Array.from(grouped.values());
  }

  // ── VPIC Lookups ─────────────────────────────────────────────────

  /** Get all makes from VPIC (warning: ~12K results, ~700KB). */
  async getAllMakes(signal?: AbortSignal): Promise<VpicMake[]> {
    const data = await this.fetchJson<VpicResponse<{ Make_ID: number; Make_Name: string }>>(
      `${VPIC_API}/vehicles/GetAllMakes?format=json`,
      { signal },
    );
    return data.Results.map((r) => ({ makeId: r.Make_ID, makeName: r.Make_Name }));
  }

  /** Get models for a make, optionally filtered by year. */
  async getModels(make: string, modelYear?: number, signal?: AbortSignal): Promise<VpicModel[]> {
    const url = modelYear
      ? `${VPIC_API}/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${modelYear}?format=json`
      : `${VPIC_API}/vehicles/GetModelsForMake/${encodeURIComponent(make)}?format=json`;
    const data = await this.fetchJson<
      VpicResponse<{ Make_ID: number; Make_Name: string; Model_ID: number; Model_Name: string }>
    >(url, { signal });
    return data.Results.map((r) => ({
      modelId: r.Model_ID,
      modelName: r.Model_Name,
      makeId: r.Make_ID,
      makeName: r.Make_Name,
    }));
  }

  /** Get vehicle types for a make (deduplicated by ID). */
  async getVehicleTypes(make: string, signal?: AbortSignal): Promise<VpicVehicleType[]> {
    const data = await this.fetchJson<
      VpicResponse<{ VehicleTypeId: number; VehicleTypeName: string }>
    >(`${VPIC_API}/vehicles/GetVehicleTypesForMake/${encodeURIComponent(make)}?format=json`, {
      signal,
    });
    const seen = new Set<number>();
    return data.Results.filter((r) => {
      if (seen.has(r.VehicleTypeId)) return false;
      seen.add(r.VehicleTypeId);
      return true;
    }).map((r) => ({
      vehicleTypeId: r.VehicleTypeId,
      vehicleTypeName: r.VehicleTypeName,
    }));
  }

  /** Get manufacturer details by name or ID (partial match supported). */
  async getManufacturer(nameOrId: string, signal?: AbortSignal): Promise<VpicManufacturer[]> {
    const data = await this.fetchJson<
      VpicResponse<{
        Mfr_ID: number;
        Mfr_Name: string;
        Country: string;
        VehicleTypes: Array<{ IsPrimary: boolean; Name: string; Id?: number }>;
      }>
    >(`${VPIC_API}/vehicles/GetManufacturerDetails/${encodeURIComponent(nameOrId)}?format=json`, {
      signal,
    });
    return data.Results.map((r) => {
      const country = normalizeOptionalString(r.Country);
      const vehicleTypes = (r.VehicleTypes ?? []).flatMap((vt) => {
        const name = normalizeOptionalString(vt.Name);
        if (!name) return [];
        return [vt.Id != null ? { id: vt.Id, name } : { name }];
      });

      return {
        manufacturerId: r.Mfr_ID,
        manufacturerName: r.Mfr_Name,
        ...omitUndefined({ country }),
        vehicleTypes,
      };
    });
  }
}

// ── Normalization ────────────────────────────────────────────────────

/**
 * Parse a date string that may be DD/MM/YYYY (from vehicle recalls API)
 * or ISO 8601 and normalize to YYYY-MM-DD. Returns the original string
 * if parsing fails.
 */
function normalizeDate(raw?: string): string {
  if (!raw) return '';
  // DD/MM/YYYY — detect by slash separators with a 4-digit year at end
  const ddmmyyyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd = '', mm = '', yyyy] = ddmmyyyy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // Already ISO-ish (YYYY-MM-DD or full ISO 8601) — extract date portion
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1] ?? raw;
  return raw;
}

function normalizeRecallByVehicle(r: RawRecallByVehicle): Recall {
  return {
    campaignNumber: r.NHTSACampaignNumber,
    manufacturer: r.Manufacturer,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    reportReceivedDate: normalizeDate(r.ReportReceivedDate),
    ...(r.parkIt !== undefined ? { parkIt: r.parkIt } : {}),
    ...(r.parkOutSide !== undefined ? { parkOutSide: r.parkOutSide } : {}),
    ...(r.overTheAirUpdate !== undefined ? { overTheAirUpdate: r.overTheAirUpdate } : {}),
  };
}

function normalizeRecallCampaignDirect(r: RawRecallCampaignDirect): RecallCampaign {
  const component = normalizeOptionalString(r.Component);
  return {
    campaignNumber: r.NHTSACampaignNumber,
    manufacturer: r.Manufacturer,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    receivedDate: normalizeDate(r.ReportReceivedDate),
    potentialUnitsAffected: r.PotentialNumberofUnitsAffected ?? 0,
    ...(component !== undefined ? { component } : {}),
    ...(r.parkIt !== undefined ? { parkIt: r.parkIt } : {}),
    ...(r.parkOutSide !== undefined ? { parkOutSide: r.parkOutSide } : {}),
    ...(r.overTheAirUpdate !== undefined ? { overTheAirUpdate: r.overTheAirUpdate } : {}),
  };
}

function normalizeComplaint(r: RawComplaint): Complaint {
  return omitUndefined({
    odiNumber: normalizeOptionalNumber(r.odiNumber),
    manufacturer: normalizeOptionalString(r.manufacturer),
    crash: typeof r.crash === 'boolean' ? r.crash : undefined,
    fire: typeof r.fire === 'boolean' ? r.fire : undefined,
    numberOfInjuries: normalizeOptionalNumber(r.numberOfInjuries),
    numberOfDeaths: normalizeOptionalNumber(r.numberOfDeaths),
    dateOfIncident: normalizeComplaintIncidentDate(r.dateOfIncident),
    dateComplaintFiled: normalizeOptionalString(r.dateComplaintFiled),
    vin: normalizeOptionalString(r.vin),
    components: normalizeOptionalString(r.components),
    summary: normalizeOptionalString(r.summary),
  });
}

function normalizeSafetyRating(r: RawSafetyRating): SafetyRating {
  if (r.VehicleId == null) {
    throw new Error('Safety rating response missing VehicleId');
  }

  const vehicleDescription = normalizeOptionalString(r.VehicleDescription);
  const overallRating = normalizeOptionalString(r.OverallRating);
  const frontalOverall = normalizeOptionalString(r.OverallFrontCrashRating);
  const frontalDriverSide = normalizeOptionalString(r.FrontCrashDriversideRating);
  const frontalPassengerSide = normalizeOptionalString(r.FrontCrashPassengersideRating);
  const sideOverall = normalizeOptionalString(r.OverallSideCrashRating);
  const sideDriverSide = normalizeOptionalString(r.SideCrashDriversideRating);
  const sidePassengerSide = normalizeOptionalString(r.SideCrashPassengersideRating);
  const combinedBarrierPoleFront = normalizeOptionalString(
    r['combinedSideBarrierAndPoleRating-Front'],
  );
  const combinedBarrierPoleRear = normalizeOptionalString(
    r['combinedSideBarrierAndPoleRating-Rear'],
  );
  const barrierOverall = normalizeOptionalString(r['sideBarrierRating-Overall']);
  const pole = normalizeOptionalString(r.SidePoleCrashRating);
  const rolloverRating = normalizeOptionalString(r.RolloverRating);
  const rolloverProbability = normalizeOptionalNumber(r.RolloverPossibility);
  const dynamicTipResult = normalizeOptionalString(r.dynamicTipResult);
  const electronicStabilityControl = normalizeOptionalString(r.NHTSAElectronicStabilityControl);
  const forwardCollisionWarning = normalizeOptionalString(r.NHTSAForwardCollisionWarning);
  const laneDepartureWarning = normalizeOptionalString(r.NHTSALaneDepartureWarning);
  const complaintsCount = normalizeOptionalNumber(r.ComplaintsCount);
  const recallsCount = normalizeOptionalNumber(r.RecallsCount);
  const investigationCount = normalizeOptionalNumber(r.InvestigationCount);

  return {
    vehicleId: r.VehicleId,
    ...omitUndefined({
      vehicleDescription,
      overallRating,
      complaintsCount,
      recallsCount,
      investigationCount,
    }),
    frontalCrash: omitUndefined({
      overall: frontalOverall,
      driverSide: frontalDriverSide,
      passengerSide: frontalPassengerSide,
    }),
    sideCrash: omitUndefined({
      overall: sideOverall,
      driverSide: sideDriverSide,
      passengerSide: sidePassengerSide,
      combinedBarrierPoleFront,
      combinedBarrierPoleRear,
      barrierOverall,
      pole,
    }),
    rollover: omitUndefined({
      rating: rolloverRating,
      probability: rolloverProbability,
      dynamicTipResult,
    }),
    adasFeatures: omitUndefined({
      electronicStabilityControl,
      forwardCollisionWarning,
      laneDepartureWarning,
    }),
  };
}

function normalizeDecodedVin(r: RawVpicDecodedVin, fallbackVin?: string): DecodedVin {
  const vin = normalizeOptionalString(r.VIN) ?? normalizeOptionalString(fallbackVin) ?? '';
  const make = normalizeOptionalString(r.Make);
  const model = normalizeOptionalString(r.Model);
  const modelYear = normalizeOptionalString(r.ModelYear);
  const bodyClass = normalizeOptionalString(r.BodyClass);
  const vehicleType = normalizeOptionalString(r.VehicleType);
  const driveType = normalizeOptionalString(r.DriveType);
  const engineCylinders = normalizeOptionalString(r.EngineCylinders);
  const engineDisplacementL = normalizeDisplacementLiters(normalizeOptionalString(r.DisplacementL));
  const engineHP = normalizeOptionalString(r.EngineHP);
  const fuelType = normalizeOptionalString(r.FuelTypePrimary);
  const trim = normalizeOptionalString(r.Trim);
  const manufacturer = normalizeOptionalString(r.Manufacturer);
  const plantCity = normalizeOptionalString(r.PlantCity);
  const plantState = normalizeOptionalString(r.PlantState);
  const plantCountry = normalizeOptionalString(r.PlantCountry);
  const airBagLocFront = normalizeOptionalString(r.AirBagLocFront);
  const airBagLocSide = normalizeOptionalString(r.AirBagLocSide);
  const airBagLocCurtain = normalizeOptionalString(r.AirBagLocCurtain);
  const airBagLocKnee = normalizeOptionalString(r.AirBagLocKnee);
  const electronicStabilityControl = normalizeOptionalString(r.ESC);
  const abs = normalizeOptionalString(r.ABS);
  const tractionControl = normalizeOptionalString(r.TractionControl);
  const errorCode = normalizeOptionalString(r.ErrorCode);
  const errorText = normalizeOptionalString(r.ErrorText);

  return {
    vin,
    ...omitUndefined({
      make,
      model,
      modelYear,
      bodyClass,
      vehicleType,
      driveType,
      engineCylinders,
      engineDisplacementL,
      engineHP,
      fuelType,
      trim,
      manufacturer,
      plantCity,
      plantState,
      plantCountry,
      airBagLocFront,
      airBagLocSide,
      airBagLocCurtain,
      airBagLocKnee,
      electronicStabilityControl,
      abs,
      tractionControl,
      errorCode,
      errorText,
    }),
  };
}

/** Format a YYYYMMDD date string from the flat file to YYYY-MM-DD. */
function formatFlatDate(raw: string): string | undefined {
  if (!raw || raw.length !== 8) return;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  return `${y}-${m}-${d}`;
}

/**
 * Parse one TAB-delimited FLAT_INV line and merge it into the grouped investigations map.
 * Multiple rows share an NHTSA action number (one row per make/model/year/component
 * association) — they collapse into a single record with distinct value arrays.
 * Layout (0-indexed): 0 NHTSA ID, 1 MAKE, 2 MODEL, 3 YEAR (9999 = unknown), 4 COMPONENT,
 * 5 MFR_NAME, 6 OPEN DATE (YYYYMMDD), 7 CLOSE DATE, 8 CAMPNO, 9 SUBJECT, 10 SUMMARY.
 */
function mergeFlatInvLine(line: string, grouped: Map<string, Investigation>): void {
  const parts = line.split('\t');
  if (parts.length < 6) return;
  const nhtsaId = parts[0]?.trim();
  if (!nhtsaId) return;

  const make = parts[1]?.trim() || undefined;
  const model = parts[2]?.trim() || undefined;
  const yearStr = parts[3]?.trim();
  const component = parts[4]?.trim() || undefined;
  const year = yearStr && yearStr !== '9999' ? Number(yearStr) : undefined;

  const existing = grouped.get(nhtsaId);
  if (existing) {
    // Merge association rows — accumulate unique makes/models/years/components.
    if (make && existing.makes && !existing.makes.includes(make)) existing.makes.push(make);
    if (model && existing.models && !existing.models.includes(model)) existing.models.push(model);
    if (year != null && existing.years && !existing.years.includes(year)) existing.years.push(year);
    if (component && existing.components && !existing.components.includes(component))
      existing.components.push(component);
    return;
  }

  const mfrName = parts[5]?.trim() || undefined;
  const openDate = parts[6]?.trim() ? formatFlatDate(parts[6].trim()) : undefined;
  const closeDate = parts[7]?.trim() ? formatFlatDate(parts[7].trim()) : undefined;
  const campno = parts[8]?.trim() || undefined;
  const subject = parts[9]?.trim() || undefined;
  const summary = parts[10]?.trim() || undefined;
  const status = closeDate ? 'C' : 'O';
  const investigationType = nhtsaId.match(/^([A-Z]+)/)?.[1] ?? undefined;

  grouped.set(nhtsaId, {
    nhtsaId,
    status,
    makes: make ? [make] : [],
    models: model ? [model] : [],
    years: year != null ? [year] : [],
    components: component ? [component] : [],
    ...(investigationType !== undefined ? { investigationType } : {}),
    ...(mfrName !== undefined ? { manufacturer: mfrName } : {}),
    ...(openDate !== undefined ? { openDate } : {}),
    ...(closeDate !== undefined ? { closeDate } : {}),
    ...(campno !== undefined ? { recallCampaign: campno } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(summary !== undefined ? { summary } : {}),
  });
}

// ── Init / Accessor ──────────────────────────────────────────────────

let _service: NhtsaService | undefined;

export function initNhtsaService(): void {
  _service = new NhtsaService();
}

export function getNhtsaService(): NhtsaService {
  if (!_service)
    throw new Error('NhtsaService not initialized — call initNhtsaService() in setup()');
  return _service;
}
