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

/** Products API (lowercase keys, no pagination). */
export interface NhtsaProductsResponse<T> {
  count: number;
  message: string;
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
  overTheAirUpdate: boolean;
  parkIt: boolean;
  parkOutSide: boolean;
  Remedy: string;
  ReportReceivedDate: string;
  Summary: string;
}

/** /recalls (base paginated endpoint) — camelCase throughout. */
export interface RawRecallBase {
  campaignId: string;
  consequence: string;
  correctiveAction: string;
  description: string;
  id: number;
  manufacturerName: string;
  nhtsaCampaignNumber: string;
  overTheAirUpdateYn: boolean;
  parkOutsideYn: boolean;
  parkVehicleYn: boolean;
  potaff: number;
  recall573ReceivedDate: string;
  recallType: string;
  subject: string;
}

/** /complaints/complaintsByVehicle — camelCase. */
export interface RawComplaint {
  components: string;
  crash: boolean;
  dateComplaintFiled: string;
  dateOfIncident: string;
  fire: boolean;
  manufacturer: string;
  numberOfDeaths: number;
  numberOfInjuries: number;
  odiNumber: number;
  summary: string;
  vin: string;
}

/** /SafetyRatings/modelyear/.../make/.../model/... — variant list. */
export interface RawSafetyRatingVariant {
  VehicleDescription: string;
  VehicleId: number;
}

/** /SafetyRatings/VehicleId/... — full detail. */
export interface RawSafetyRating {
  ComplaintsCount: number;
  'combinedSideBarrierAndPoleRating-Front': string;
  'combinedSideBarrierAndPoleRating-Rear': string;
  dynamicTipResult: string;
  FrontCrashDriversideRating: string;
  FrontCrashPassengersideRating: string;
  InvestigationCount: number;
  NHTSAElectronicStabilityControl: string;
  NHTSAForwardCollisionWarning: string;
  NHTSALaneDepartureWarning: string;
  OverallFrontCrashRating: string;
  OverallRating: string;
  OverallSideCrashRating: string;
  RecallsCount: number;
  RolloverPossibility: number;
  RolloverRating: string;
  SideCrashDriversideRating: string;
  SideCrashPassengersideRating: string;
  SidePoleCrashRating: string;
  'sideBarrierRating-Overall': string;
  VehicleDescription: string;
  VehicleId: number;
}

/** /investigations — camelCase. */
export interface RawInvestigation {
  description: string;
  id: number;
  investigationType: string;
  issueYear: string;
  latestActivityDate: string;
  nhtsaId: string;
  openDate: string;
  status: string;
  subject: string;
}

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
  overTheAirUpdate: boolean;
  parkIt: boolean;
  parkOutSide: boolean;
  remedy: string;
  reportReceivedDate: string;
  summary: string;
}

/** Recall from base endpoint (campaign-level, includes units affected). */
export interface RecallCampaign {
  campaignNumber: string;
  consequence: string;
  manufacturer: string;
  overTheAirUpdate: boolean;
  parkIt: boolean;
  parkOutSide: boolean;
  potentialUnitsAffected: number;
  receivedDate: string;
  remedy: string;
  subject: string;
  summary: string;
}

export interface Complaint {
  components: string;
  crash: boolean;
  dateComplaintFiled: string;
  dateOfIncident: string;
  fire: boolean;
  manufacturer: string;
  numberOfDeaths: number;
  numberOfInjuries: number;
  odiNumber: number;
  summary: string;
  vin: string;
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
    for (const component of c.components
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
      entry.injuryCount += c.numberOfInjuries;
      entry.deathCount += c.numberOfDeaths;
      map.set(component, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export interface SafetyRatingVariant {
  vehicleDescription: string;
  vehicleId: number;
}

export interface SafetyRating {
  adasFeatures: {
    electronicStabilityControl: string;
    forwardCollisionWarning: string;
    laneDepartureWarning: string;
  };
  complaintsCount: number;
  frontalCrash: {
    overall: string;
    driverSide: string;
    passengerSide: string;
  };
  investigationCount: number;
  overallRating: string;
  recallsCount: number;
  rollover: {
    rating: string;
    probability: number;
    dynamicTipResult: string;
  };
  sideCrash: {
    overall: string;
    driverSide: string;
    passengerSide: string;
    combinedBarrierPoleFront: string;
    combinedBarrierPoleRear: string;
    barrierOverall: string;
    pole: string;
  };
  vehicleDescription: string;
  vehicleId: number;
}

export interface DecodedVin {
  abs: string;
  airBagLocCurtain: string;
  airBagLocFront: string;
  airBagLocKnee: string;
  airBagLocSide: string;
  bodyClass: string;
  driveType: string;
  electronicStabilityControl: string;
  engineCylinders: string;
  engineDisplacementL: string;
  engineHP: string;
  errorCode: string;
  errorText: string;
  fuelType: string;
  make: string;
  manufacturer: string;
  model: string;
  modelYear: string;
  plantCity: string;
  plantCountry: string;
  plantState: string;
  tractionControl: string;
  trim: string;
  vehicleType: string;
  vin: string;
}

export interface Investigation {
  description: string;
  investigationType: string;
  issueYear: string;
  latestActivityDate: string;
  nhtsaId: string;
  openDate: string;
  status: string;
  subject: string;
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
  country: string;
  manufacturerId: number;
  manufacturerName: string;
  vehicleTypes: Array<{ id?: number; name: string }>;
}
