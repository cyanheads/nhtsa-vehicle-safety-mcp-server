/**
 * @fileoverview NHTSA API response types and normalized domain types.
 * @module services/nhtsa/types
 */

// ── API Response Wrappers ──────────────────────────────────────────

/** Vehicle-scoped endpoints and Safety Ratings API wrapper. */
export interface NhtsaResponse<T> {
  Count: number;
  Message: string;
  Results?: T[];
  results?: T[];
}

/** Base collection endpoints (paginated). */
export interface NhtsaPaginatedResponse<T> {
  meta: {
    pagination: {
      count: number;
      max: number;
      offset: number;
      total: number;
    };
  };
  results: T[];
}

/** VPIC API wrapper. */
export interface VpicResponse<T> {
  Count: number;
  Message: string;
  Results: T[];
  SearchCriteria: string;
}

// ── Raw API Records ────────────────────────────────────────────────

/** /recalls/recallsByVehicle — PascalCase with camelCase booleans. */
export interface RawRecallByVehicle {
  Component: string;
  Consequence: string;
  Make: string;
  Manufacturer: string;
  Model: string;
  ModelYear: string;
  NHTSACampaignNumber: string;
  Notes: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  Remedy: string;
  ReportReceivedDate: string;
  Summary: string;
}

/**
 * /recalls/campaignNumber — PascalCase (same shape as recallsByVehicle +
 * PotentialNumberofUnitsAffected + NHTSAActionNumber). The endpoint returns one row per
 * affected make/model/model-year; every row repeats the same campaign detail.
 */
export interface RawRecallCampaignDirect {
  Component: string;
  Consequence: string;
  Make?: string;
  Manufacturer: string;
  Model?: string;
  ModelYear?: string;
  NHTSAActionNumber?: string;
  NHTSACampaignNumber: string;
  Notes?: string;
  overTheAirUpdate?: boolean;
  PotentialNumberofUnitsAffected?: number;
  parkIt?: boolean;
  parkOutSide?: boolean;
  Remedy: string;
  ReportReceivedDate: string;
  Summary: string;
}

/** /complaints/complaintsByVehicle — camelCase. */
export interface RawComplaint {
  components?: string;
  crash?: boolean;
  dateComplaintFiled?: string;
  dateOfIncident?: string;
  fire?: boolean;
  manufacturer?: string;
  numberOfDeaths?: number;
  numberOfInjuries?: number;
  odiNumber?: number;
  summary?: string;
  vin?: string;
}

/** /SafetyRatings/modelyear/.../make/.../model/... — variant list. */
export interface RawSafetyRatingVariant {
  VehicleDescription?: string;
  VehicleId?: number;
}

/** /SafetyRatings/VehicleId/... — full detail. */
export interface RawSafetyRating {
  ComplaintsCount?: number;
  'combinedSideBarrierAndPoleRating-Front'?: string;
  'combinedSideBarrierAndPoleRating-Rear'?: string;
  dynamicTipResult?: string;
  FrontCrashDriversideRating?: string;
  FrontCrashPassengersideRating?: string;
  InvestigationCount?: number;
  NHTSAElectronicStabilityControl?: string;
  NHTSAForwardCollisionWarning?: string;
  NHTSALaneDepartureWarning?: string;
  OverallFrontCrashRating?: string;
  OverallRating?: string;
  OverallSideCrashRating?: string;
  RecallsCount?: number;
  RolloverPossibility?: number;
  RolloverRating?: string;
  SideCrashDriversideRating?: string;
  SideCrashPassengersideRating?: string;
  SidePoleCrashRating?: string;
  'sideBarrierRating-Overall'?: string;
  VehicleDescription?: string;
  VehicleId?: number;
}

// RawInvestigation removed — investigations now sourced from FLAT_INV.zip flat file.
// The flat file is parsed directly into Investigation records in nhtsa-service.ts.

/** VPIC DecodeVinValues — PascalCase, 157 fields. Indexed for selective extraction. */
export interface RawVpicDecodedVin {
  [key: string]: string;
}

// ── Normalized Domain Types ────────────────────────────────────────

/** Recall from vehicle-scoped endpoint. */
export interface Recall {
  campaignNumber: string;
  component: string;
  consequence: string;
  manufacturer: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  remedy: string;
  reportReceivedDate: string;
  summary: string;
}

/**
 * One make/model entry covered by a recall campaign. Equipment and tire campaigns name the
 * part here — make is the brand, model is the part — and carry no model year. Upstream may
 * omit any of the three.
 */
export interface AffectedVehicle {
  make?: string;
  model?: string;
  modelYear?: number;
}

/**
 * Recall from the direct /recalls/campaignNumber endpoint, collapsed from the endpoint's
 * one-row-per-vehicle response into a single campaign record.
 */
export interface RecallCampaign {
  affectedVehicles: AffectedVehicle[];
  campaignNumber: string;
  component?: string;
  consequence: string;
  investigationId?: string;
  manufacturer: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  potentialUnitsAffected: number;
  receivedDate: string;
  remedy: string;
  summary: string;
}

/**
 * Why a reported incident date could not be used as one. Both reasons are contradictions
 * within the complaint record itself — the date against the complaint's own filing date, or
 * against the model year of the vehicle it describes — never a judgment against a calendar
 * threshold.
 */
export const UNRELIABLE_INCIDENT_DATE_REASONS = [
  'postdates_filing',
  'predates_model_year',
] as const;

export type UnreliableIncidentDateReason = (typeof UNRELIABLE_INCIDENT_DATE_REASONS)[number];

/** An incident date NHTSA reported that the rest of the same complaint record contradicts. */
export interface UnreliableIncidentDate {
  reason: UnreliableIncidentDateReason;
  reported: string;
}

export interface Complaint {
  components?: string;
  crash?: boolean;
  dateComplaintFiled?: string;
  dateOfIncident?: string;
  fire?: boolean;
  manufacturer?: string;
  numberOfDeaths?: number;
  numberOfInjuries?: number;
  odiNumber?: number;
  summary?: string;
  /** Present only when `dateOfIncident` is absent because upstream's value was rejected. */
  unreliableIncidentDate?: UnreliableIncidentDate;
  vin?: string;
}

export interface ComponentBreakdown {
  component: string;
  count: number;
  crashCount: number;
  deathCount: number;
  fireCount: number;
  injuryCount: number;
}

/** Aggregate complaints by component, sorted by frequency descending. */
export function buildComponentBreakdown(complaints: Complaint[]): ComponentBreakdown[] {
  const map = new Map<string, ComponentBreakdown>();
  for (const c of complaints) {
    for (const component of (c.components ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const entry = map.get(component) ?? {
        component,
        count: 0,
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      };
      entry.count++;
      if (c.crash) entry.crashCount++;
      if (c.fire) entry.fireCount++;
      entry.injuryCount += c.numberOfInjuries ?? 0;
      entry.deathCount += c.numberOfDeaths ?? 0;
      map.set(component, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export interface SafetyRatingVariant {
  vehicleDescription?: string;
  vehicleId: number;
}

export interface SafetyRating {
  adasFeatures: {
    electronicStabilityControl?: string;
    forwardCollisionWarning?: string;
    laneDepartureWarning?: string;
  };
  complaintsCount?: number;
  frontalCrash: {
    overall?: string;
    driverSide?: string;
    passengerSide?: string;
  };
  investigationCount?: number;
  overallRating?: string;
  recallsCount?: number;
  rollover: {
    rating?: string;
    probability?: number;
    dynamicTipResult?: string;
  };
  sideCrash: {
    overall?: string;
    driverSide?: string;
    passengerSide?: string;
    combinedBarrierPoleFront?: string;
    combinedBarrierPoleRear?: string;
    barrierOverall?: string;
    pole?: string;
  };
  vehicleDescription?: string;
  vehicleId: number;
}

export interface DecodedVin {
  abs?: string;
  airBagLocCurtain?: string;
  airBagLocFront?: string;
  airBagLocKnee?: string;
  airBagLocSide?: string;
  bodyClass?: string;
  driveType?: string;
  electronicStabilityControl?: string;
  engineCylinders?: string;
  engineDisplacementL?: string;
  engineHP?: string;
  errorCode?: string;
  errorText?: string;
  fuelType?: string;
  make?: string;
  manufacturer?: string;
  model?: string;
  modelYear?: string;
  plantCity?: string;
  plantCountry?: string;
  plantState?: string;
  tractionControl?: string;
  trim?: string;
  vehicleType?: string;
  vin: string;
}

/** Normalized investigation record — sourced from FLAT_INV.zip flat file. */
export interface Investigation {
  closeDate?: string;
  components?: string[]; // distinct components from flat-file association rows
  investigationType?: string;
  makes?: string[]; // distinct makes from flat-file association rows
  manufacturer?: string;
  models?: string[]; // distinct models from flat-file association rows
  nhtsaId?: string;
  openDate?: string;
  recallCampaign?: string; // CAMPNO — links to nhtsa_search_recalls by campaignNumber
  status?: string; // 'O' = Open (no close date), 'C' = Closed
  subject?: string;
  summary?: string;
  years?: number[]; // distinct model years (9999 excluded)
}

export interface VpicMake {
  makeId: number;
  makeName: string;
}

export interface VpicModel {
  makeId: number;
  makeName: string;
  modelId: number;
  modelName: string;
}

export interface VpicVehicleType {
  vehicleTypeId: number;
  vehicleTypeName: string;
}

export interface VpicManufacturer {
  country?: string;
  manufacturerId: number;
  manufacturerName: string;
  vehicleTypes: Array<{ id?: number; name: string }>;
}
