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

/** VPIC API wrapper. */
export interface VpicResponse<T> {
  Count: number;
  Message: string;
  Results: T[];
  SearchCriteria: string;
}

// ── Raw API Records ────────────────────────────────────────────────

/**
 * /recalls/recallsByVehicle — PascalCase with camelCase booleans. Older campaigns (the 1960s
 * ones, for example) send `Summary`, `Consequence`, and `Remedy` as null.
 */
export interface RawRecallByVehicle {
  Component: string;
  Consequence: string | null;
  Make: string;
  Manufacturer: string;
  Model: string;
  ModelYear: string;
  NHTSACampaignNumber: string;
  Notes: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  Remedy: string | null;
  ReportReceivedDate: string;
  Summary: string | null;
}

/**
 * /recalls/campaignNumber — PascalCase (same shape as recallsByVehicle +
 * PotentialNumberofUnitsAffected + NHTSAActionNumber). The endpoint returns one row per
 * affected make/model/model-year; every row of a campaign repeats the same campaign detail, null
 * campaign text included. A 6-character campaign number returns the rows of every campaign it
 * prefixes, interleaved.
 */
export interface RawRecallCampaignDirect {
  Component: string;
  Consequence: string | null;
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
  Remedy: string | null;
  ReportReceivedDate: string;
  Summary: string | null;
}

/** /complaints/complaintsByVehicle — camelCase. A complaint with no incident date sends it as null. */
export interface RawComplaint {
  components?: string;
  crash?: boolean;
  dateComplaintFiled?: string;
  dateOfIncident?: string | null;
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

/** /SafetyRatings/modelyear/.../make/... — NCAP's model list for a make; `VehicleId` is 0. */
export interface RawSafetyRatingModel {
  Make?: string;
  Model?: string;
  ModelYear?: number;
}

/** /products/vehicle/models — one row per model and issue type, so names repeat. */
export interface RawProductModel {
  make?: string;
  model?: string;
  modelYear?: string;
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

/** VPIC DecodeVinValues — PascalCase, 157 fields. Indexed for selective extraction. */
export interface RawVpicDecodedVin {
  [key: string]: string;
}

// ── Normalized Domain Types ────────────────────────────────────────

/**
 * Recall from vehicle-scoped endpoint. Older campaigns carry no summary, consequence, or remedy,
 * so those are omitted rather than reported empty.
 */
export interface Recall {
  campaignNumber: string;
  component: string;
  consequence?: string;
  manufacturer: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  remedy?: string;
  reportReceivedDate: string;
  summary?: string;
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
 * One campaign from the direct /recalls/campaignNumber endpoint, collapsed from that campaign's
 * one-row-per-vehicle rows into a single record. Older campaigns carry no summary, consequence,
 * or remedy, so those are omitted rather than reported empty.
 */
export interface RecallCampaign {
  affectedVehicles: AffectedVehicle[];
  campaignNumber: string;
  component?: string;
  consequence?: string;
  investigationId?: string;
  manufacturer: string;
  overTheAirUpdate?: boolean;
  parkIt?: boolean;
  parkOutSide?: boolean;
  potentialUnitsAffected?: number;
  receivedDate: string;
  remedy?: string;
  summary?: string;
}

/**
 * One recall campaign from NHTSA's recall flat files, grouped from the files' rows (one per
 * make/model/model year and component) by campaign number. The files carry no over-the-air
 * flag, and older campaigns leave the summary, consequence, and remedy blank, so those are
 * omitted rather than reported empty.
 */
export interface IndexedRecall {
  campaignNumber: string;
  /** The campaign's distinct component descriptions, joined with " | ". */
  component?: string;
  consequence?: string;
  manufacturer: string;
  parkIt?: boolean;
  parkOutSide?: boolean;
  potentialUnitsAffected?: number;
  remedy?: string;
  /** The Part 573 report's received date, YYYY-MM-DD. */
  reportReceivedDate: string;
  summary?: string;
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

/**
 * The distinct component names a complaint lists. NHTSA joins them with a bare comma
 * (`AIR BAGS,SEAT BELTS`), and some names carry a comma followed by a space of their own
 * (`SERVICE BRAKES, HYDRAULIC`, `Chest Clip, Buckle, Harness`), so only a comma with no
 * whitespace after it separates two names.
 */
export function splitComponentNames(components: string | undefined): string[] {
  const names = (components ?? '').split(/,(?!\s)/).map((name) => name.trim());
  return [...new Set(names.filter(Boolean))];
}

/**
 * Aggregate complaints by component, sorted by frequency descending. A complaint counts once
 * toward each name it lists, so no row's count exceeds the number of complaints.
 */
export function buildComponentBreakdown(complaints: Complaint[]): ComponentBreakdown[] {
  const map = new Map<string, ComponentBreakdown>();
  for (const c of complaints) {
    for (const component of splitComponentNames(c.components)) {
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

/**
 * One VIN as VPIC decodes it; a field VPIC leaves blank is omitted. The driver-assistance
 * features read `Standard`, `Optional`, or `Not Available` for the decoded configuration.
 */
export interface DecodedVin {
  abs?: string;
  adaptiveCruiseControl?: string;
  airBagLocCurtain?: string;
  airBagLocFront?: string;
  airBagLocKnee?: string;
  airBagLocSeatCushion?: string;
  airBagLocSide?: string;
  backupCamera?: string;
  blindSpotIntervention?: string;
  blindSpotWarning?: string;
  bodyClass?: string;
  crashImminentBraking?: string;
  driveType?: string;
  dynamicBrakeSupport?: string;
  electronicStabilityControl?: string;
  engineCylinders?: string;
  engineDisplacementL?: string;
  engineHP?: string;
  errorCode?: string;
  errorText?: string;
  forwardCollisionWarning?: string;
  fuelType?: string;
  laneCenteringAssistance?: string;
  laneDepartureWarning?: string;
  laneKeepingAssistance?: string;
  make?: string;
  manufacturer?: string;
  model?: string;
  modelYear?: string;
  parkingAssist?: string;
  pedestrianAutomaticEmergencyBraking?: string;
  plantCity?: string;
  plantCountry?: string;
  plantState?: string;
  rearAutomaticEmergencyBraking?: string;
  rearCrossTrafficAlert?: string;
  tpmsType?: string;
  tractionControl?: string;
  trim?: string;
  vehicleType?: string;
  vin: string;
}

/** One distinct make/model/model-year association of an investigation, as one flat-file row lists it. */
export interface InvestigationVehicle {
  make?: string;
  model?: string;
  year?: number; // absent when the row's YEAR is blank or 9999
}

/** Normalized investigation record — sourced from FLAT_INV.zip flat file. */
export interface Investigation {
  closeDate?: string;
  components?: string[]; // distinct components from flat-file association rows
  investigationType?: string;
  makes?: string[]; // distinct makes from flat-file association rows
  manufacturers?: string[]; // distinct MFR_NAME values, first-seen row order; absent when no row names one
  models?: string[]; // distinct models from flat-file association rows
  nhtsaId?: string;
  openDate?: string;
  recallCampaigns?: string[]; // distinct CAMPNO values, unpadded as NHTSA lists them — nhtsa_search_recalls campaignNumber
  status?: string; // 'O' = Open (no close date), 'C' = Closed
  subject?: string;
  summary?: string;
  /**
   * Every distinct association row, kept so a make/model/model-year search matches all three on
   * one row rather than across the flattened arrays. Internal: never part of tool output.
   */
  vehicles: InvestigationVehicle[];
  years?: number[]; // distinct model years, ascending (9999 excluded)
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

/**
 * The model-name lists NHTSA keeps per make and model year: the complaint products list, NCAP's
 * model list, and VPIC's catalog. No list enumerates recall names.
 */
export const DATASET_MODEL_LISTS = ['products', 'ncap', 'vpic'] as const;

export type DatasetModelList = (typeof DATASET_MODEL_LISTS)[number];

/** One model name merged across the lists, tagged with every list carrying it. */
export interface DatasetModel {
  listedBy: DatasetModelList[];
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
