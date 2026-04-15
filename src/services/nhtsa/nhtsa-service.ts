/**
 * @fileoverview NHTSA API client service. Wraps five public APIs (Recalls, Complaints,
 * Safety Ratings, Investigations, VPIC) with field normalization and caching.
 * @module services/nhtsa/nhtsa-service
 */

import type {
  Complaint,
  DecodedVin,
  Investigation,
  NhtsaPaginatedResponse,
  NhtsaResponse,
  RawComplaint,
  RawInvestigation,
  RawRecallBase,
  RawRecallByVehicle,
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

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const INVESTIGATION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVESTIGATION_PAGE_SIZE = 100;

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

export class NhtsaService {
  private investigationCache: { data: Investigation[]; fetchedAt: number } | null = null;

  // ── HTTP ─────────────────────────────────────────────────────────

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    let lastError: Error | undefined;
    const endpoint = new URL(url).pathname;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
      }
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
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
        lastError = new Error(`NHTSA API returned ${res.status} for ${endpoint}`);
        continue;
      }
      if (res.status === 400) {
        throw new Error(
          `NHTSA API returned no data for this request (HTTP 400). The vehicle may not exist in NHTSA's database — verify make/model spelling with nhtsa_lookup_vehicles.`,
        );
      }
      throw new Error(`NHTSA API returned ${res.status} for ${endpoint}`);
    }
    throw lastError ?? new Error(`NHTSA API request failed after ${MAX_RETRIES} retries`);
  }

  // ── Recalls ──────────────────────────────────────────────────────

  /** Fetch all recalls for a specific vehicle (no pagination). */
  async getRecallsByVehicle(make: string, model: string, modelYear: number): Promise<Recall[]> {
    const params = new URLSearchParams({ make, model, modelYear: String(modelYear) });
    const data = await this.fetchJson<NhtsaResponse<RawRecallByVehicle>>(
      `${NHTSA_API}/recalls/recallsByVehicle?${params}`,
    );
    return (data.results ?? []).map(normalizeRecallByVehicle);
  }

  /**
   * Look up a recall campaign by campaignId using binary search on the sorted base endpoint.
   * Returns null if the campaign is not found.
   */
  async getRecallCampaign(campaignId: string): Promise<RecallCampaign | null> {
    // Get total count
    const initial = await this.fetchJson<NhtsaPaginatedResponse<RawRecallBase>>(
      `${NHTSA_API}/recalls?offset=0&max=1&sort=campaignId&order=asc`,
    );
    const total = initial.meta.pagination.total;
    if (total === 0) return null;

    let lo = 0;
    let hi = total - 1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const page = await this.fetchJson<NhtsaPaginatedResponse<RawRecallBase>>(
        `${NHTSA_API}/recalls?offset=${mid}&max=1&sort=campaignId&order=asc`,
      );
      const first = page.results[0];
      if (!first) break;
      if (first.campaignId < campaignId) lo = mid + 1;
      else if (first.campaignId > campaignId) hi = mid - 1;
      else return normalizeBaseRecall(first);
    }

    // Check neighborhood in case of off-by-one
    const nearOffset = Math.max(0, lo - 2);
    const nearby = await this.fetchJson<NhtsaPaginatedResponse<RawRecallBase>>(
      `${NHTSA_API}/recalls?offset=${nearOffset}&max=10&sort=campaignId&order=asc`,
    );
    const match = nearby.results.find((r) => r.campaignId === campaignId);
    return match ? normalizeBaseRecall(match) : null;
  }

  /** Fetch paginated recalls from the base endpoint, sorted by date descending. */
  async getRecallsPaginated(
    offset: number,
    max: number,
  ): Promise<{ results: RecallCampaign[]; total: number }> {
    const data = await this.fetchJson<NhtsaPaginatedResponse<RawRecallBase>>(
      `${NHTSA_API}/recalls?offset=${offset}&max=${max}&sort=recall573ReceivedDate&order=desc`,
    );
    return {
      results: data.results.map(normalizeBaseRecall),
      total: data.meta.pagination.total,
    };
  }

  // ── Complaints ───────────────────────────────────────────────────

  /** Fetch all complaints for a specific vehicle (no pagination). */
  async getComplaintsByVehicle(
    make: string,
    model: string,
    modelYear: number,
  ): Promise<Complaint[]> {
    const params = new URLSearchParams({ make, model, modelYear: String(modelYear) });
    const data = await this.fetchJson<NhtsaResponse<RawComplaint>>(
      `${NHTSA_API}/complaints/complaintsByVehicle?${params}`,
    );
    return (data.results ?? []).map(normalizeComplaint);
  }

  // ── Safety Ratings ───────────────────────────────────────────────

  /** Get NCAP vehicle variants for a make/model/year. */
  async getSafetyRatingVariants(
    modelYear: number,
    make: string,
    model: string,
  ): Promise<SafetyRatingVariant[]> {
    const data = await this.fetchJson<NhtsaResponse<RawSafetyRatingVariant>>(
      `${NHTSA_API}/SafetyRatings/modelyear/${modelYear}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}`,
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
  async getSafetyRating(vehicleId: number): Promise<SafetyRating | null> {
    const data = await this.fetchJson<NhtsaResponse<RawSafetyRating>>(
      `${NHTSA_API}/SafetyRatings/VehicleId/${vehicleId}`,
    );
    const raw = (data.Results ?? [])[0];
    return raw?.VehicleId != null ? normalizeSafetyRating(raw) : null;
  }

  // ── VIN Decode ───────────────────────────────────────────────────

  /** Decode a single VIN via VPIC. */
  async decodeVin(vin: string, modelYear?: number): Promise<DecodedVin> {
    const yearParam = modelYear ? `&modelyear=${modelYear}` : '';
    const data = await this.fetchJson<VpicResponse<RawVpicDecodedVin>>(
      `${VPIC_API}/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json${yearParam}`,
    );
    const raw = data.Results[0];
    if (!raw) throw new Error(`No decode results for VIN: ${vin}`);
    return normalizeDecodedVin(raw, vin);
  }

  /** Batch decode up to 50 VINs via VPIC POST endpoint. */
  async decodeVinBatch(entries: Array<{ vin: string; modelYear?: number }>): Promise<DecodedVin[]> {
    const dataStr = entries.map((e) => (e.modelYear ? `${e.vin},${e.modelYear}` : e.vin)).join(';');
    const body = `DATA=${dataStr}&format=json`;
    const data = await this.fetchJson<VpicResponse<RawVpicDecodedVin>>(
      `${VPIC_API}/vehicles/DecodeVINValuesBatch/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    return data.Results.map((result, index) => normalizeDecodedVin(result, entries[index]?.vin));
  }

  // ── Investigations ───────────────────────────────────────────────

  /** Get all investigations from cache, refreshing if stale. */
  async getInvestigations(): Promise<Investigation[]> {
    if (
      this.investigationCache &&
      Date.now() - this.investigationCache.fetchedAt < INVESTIGATION_CACHE_TTL_MS
    ) {
      return this.investigationCache.data;
    }
    const data = await this.fetchAllInvestigations();
    this.investigationCache = { data, fetchedAt: Date.now() };
    return data;
  }

  private async fetchAllInvestigations(): Promise<Investigation[]> {
    const all: Investigation[] = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const page = await this.fetchJson<NhtsaPaginatedResponse<RawInvestigation>>(
        `${NHTSA_API}/investigations?offset=${offset}&max=${INVESTIGATION_PAGE_SIZE}&sort=openDate&order=desc`,
      );
      total = page.meta.pagination.total;
      all.push(...page.results.map(normalizeInvestigation));
      offset += INVESTIGATION_PAGE_SIZE;
    }
    return all;
  }

  // ── VPIC Lookups ─────────────────────────────────────────────────

  /** Get all makes from VPIC (warning: ~12K results, ~700KB). */
  async getAllMakes(): Promise<VpicMake[]> {
    const data = await this.fetchJson<VpicResponse<{ Make_ID: number; Make_Name: string }>>(
      `${VPIC_API}/vehicles/GetAllMakes?format=json`,
    );
    return data.Results.map((r) => ({ makeId: r.Make_ID, makeName: r.Make_Name }));
  }

  /** Get models for a make, optionally filtered by year. */
  async getModels(make: string, modelYear?: number): Promise<VpicModel[]> {
    const url = modelYear
      ? `${VPIC_API}/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${modelYear}?format=json`
      : `${VPIC_API}/vehicles/GetModelsForMake/${encodeURIComponent(make)}?format=json`;
    const data =
      await this.fetchJson<
        VpicResponse<{ Make_ID: number; Make_Name: string; Model_ID: number; Model_Name: string }>
      >(url);
    return data.Results.map((r) => ({
      modelId: r.Model_ID,
      modelName: r.Model_Name,
      makeId: r.Make_ID,
      makeName: r.Make_Name,
    }));
  }

  /** Get vehicle types for a make (deduplicated by ID). */
  async getVehicleTypes(make: string): Promise<VpicVehicleType[]> {
    const data = await this.fetchJson<
      VpicResponse<{ VehicleTypeId: number; VehicleTypeName: string }>
    >(`${VPIC_API}/vehicles/GetVehicleTypesForMake/${encodeURIComponent(make)}?format=json`);
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
  async getManufacturer(nameOrId: string): Promise<VpicManufacturer[]> {
    const data = await this.fetchJson<
      VpicResponse<{
        Mfr_ID: number;
        Mfr_Name: string;
        Country: string;
        VehicleTypes: Array<{ IsPrimary: boolean; Name: string; Id?: number }>;
      }>
    >(`${VPIC_API}/vehicles/GetManufacturerDetails/${encodeURIComponent(nameOrId)}?format=json`);
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

function normalizeBaseRecall(r: RawRecallBase): RecallCampaign {
  return {
    campaignNumber: r.campaignId,
    manufacturer: r.manufacturerName,
    subject: r.subject,
    summary: r.description,
    consequence: r.consequence,
    remedy: r.correctiveAction,
    receivedDate: normalizeDate(r.recall573ReceivedDate),
    potentialUnitsAffected: r.potaff,
    ...(r.parkVehicleYn !== undefined ? { parkIt: r.parkVehicleYn } : {}),
    ...(r.parkOutsideYn !== undefined ? { parkOutSide: r.parkOutsideYn } : {}),
    ...(r.overTheAirUpdateYn !== undefined ? { overTheAirUpdate: r.overTheAirUpdateYn } : {}),
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
    dateOfIncident: normalizeOptionalString(r.dateOfIncident),
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

function normalizeInvestigation(r: RawInvestigation): Investigation {
  return omitUndefined({
    nhtsaId: normalizeOptionalString(r.nhtsaId),
    investigationType: normalizeOptionalString(r.investigationType),
    status: normalizeOptionalString(r.status),
    subject: normalizeOptionalString(r.subject),
    description: r.description ? normalizeOptionalString(stripHtml(r.description)) : undefined,
    openDate: normalizeOptionalString(r.openDate),
    latestActivityDate: normalizeOptionalString(r.latestActivityDate),
    issueYear: normalizeOptionalString(r.issueYear),
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
