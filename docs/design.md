---
name: nhtsa-vehicle-safety-mcp-server
status: researched
priority: high
difficulty: low
category: transportation
api_docs: https://www.nhtsa.gov/nhtsa-datasets-and-apis
---

# NHTSA Vehicle Safety MCP Server

## Overview

Vehicle safety data from the National Highway Traffic Safety Administration. Wraps five public APIs -- [Recalls](https://api.nhtsa.gov/recalls/), [Complaints](https://api.nhtsa.gov/complaints/), [Investigations](https://api.nhtsa.gov/investigations), [Safety Ratings (NCAP)](https://api.nhtsa.gov/SafetyRatings/), and [VPIC](https://vpic.nhtsa.dot.gov/api/) (VIN decoding / vehicle info) -- to provide searchable access to ~30K recall campaigns (since 1949), 1.6M+ consumer complaints, crash test ratings, ~4,200 defect investigations, and vehicle identification (12K+ makes). No auth required; all public.

NHTSA exposes two API layers: **vehicle-scoped endpoints** (`/recallsByVehicle`, `/complaintsByVehicle`) that return the complete result set for a make/model/year with no pagination, and **base collection endpoints** (`/recalls`, `/complaints`, `/investigations`) that are paginated and sortable but do not reliably filter by make/model. A newer **`/products/`** API provides valid make/model/year discovery for each issue type. The server should use the vehicle-scoped endpoints for per-vehicle queries and the base endpoints for broad searches (e.g., recent recalls across all vehicles).

**Dependencies**: `zod`, native fetch

---

## General Workflow

1. **Identify** the vehicle -- by make/model/year, VIN, or campaign number
2. **Assess safety** with `nhtsa_get_vehicle_safety` for the combined picture (recalls, complaint trends, crash ratings) or drill into a specific domain
3. **Investigate** specific recalls via `nhtsa_search_recalls`, complaints via `nhtsa_search_complaints`, or decode a VIN with `nhtsa_decode_vin`
4. **Compare** vehicles using safety ratings or recall history

`nhtsa_get_vehicle_safety` is the primary entry point -- it combines data from multiple APIs into a single safety profile. The other tools are for focused queries or when the combined view is too broad.

---

## Tools

### `nhtsa_get_vehicle_safety`

Get a comprehensive safety profile for a vehicle. Combines recalls, complaint summary, NCAP crash test ratings, and investigation counts into a single response. Use this as the default when a user asks about vehicle safety, reliability, or "should I buy this car?"

Internally calls the Safety Ratings, Recalls, and Complaints APIs and merges the results. For vehicles without NCAP ratings (pre-2011, some vehicle types), returns recalls and complaints only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Yes | Vehicle manufacturer (e.g., "Toyota", "Ford"). Case-insensitive. |
| `model` | string | Yes | Vehicle model (e.g., "Camry", "F-150"). Case-insensitive. |
| `modelYear` | number | Yes | Model year (e.g., 2020). |

**Returns:** `safetyRatings` (overall, frontal, side, rollover stars; rollover probability; ADAS features), `recalls[]` (campaign number, component, summary, remedy, units affected), `complaintSummary` (total count, top components by frequency, crash/fire/injury counts), `investigationCount`. Includes `vehicleId` for follow-up Safety Ratings queries.

### `nhtsa_search_recalls`

Search recall campaigns by vehicle or campaign number. Use for questions about specific recalls, recall history for a vehicle, or looking up a known campaign number.

Supports time-based filtering via `dateRange`. The NHTSA API does not natively support date-range queries -- the vehicle-scoped endpoint returns all recalls for a make/model/year, and the base `/recalls` endpoint supports sorting by `recall573ReceivedDate` but not filtering. The server implements date filtering locally: for vehicle queries, filter the complete response by `ReportReceivedDate`; for broad queries ("recalls in the last year"), use the paginated base endpoint sorted by date descending and scan pages until outside the range.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `campaignNumber` | string | No | NHTSA campaign number (e.g., "20V682000"). When provided, returns all vehicles/equipment in that campaign with full detail including units affected. Other params ignored. |
| `make` | string | No | Vehicle manufacturer. Required with `model` and `modelYear` when not using `campaignNumber`. |
| `model` | string | No | Vehicle model. Required with `make` and `modelYear`. |
| `modelYear` | number | No | Model year. Required with `make` and `model`. |
| `dateRange` | object | No | Filter recalls by received date. `{ after?: string, before?: string }` -- ISO 8601 dates (e.g., "2025-01-01"). Applied locally by the server since the API lacks native date filtering. |

**Returns:** Array of recalls, each with: `NHTSACampaignNumber`, `manufacturer`, `component`, `summary`, `consequence`, `remedy`, `reportReceivedDate`, `parkIt`, `parkOutSide` (do-not-drive advisories), `overTheAirUpdate`. Campaign number queries additionally return `potentialNumberOfUnitsAffected`.

**Error modes:** Both `campaignNumber` and vehicle params provided -- reject with guidance. All three vehicle params required together. Invalid campaign number format returns empty results, not an error.

### `nhtsa_search_complaints`

Search consumer safety complaints filed with NHTSA. Use for questions about common problems, failure patterns, or issues reported by owners for a specific vehicle.

Returns can be large (200+ complaints for a popular vehicle year). The server summarizes by component and returns the most recent complaints, with a count of total results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Yes | Vehicle manufacturer. |
| `model` | string | Yes | Vehicle model. |
| `modelYear` | number | Yes | Model year. |
| `component` | string | No | Filter to a specific component. Values are uppercase from NHTSA's taxonomy. Common values: `AIR BAGS`, `BACK OVER PREVENTION`, `ELECTRICAL SYSTEM`, `ENGINE`, `ENGINE AND ENGINE COOLING`, `EQUIPMENT`, `FORWARD COLLISION AVOIDANCE`, `FUEL/PROPULSION SYSTEM`, `LANE DEPARTURE`, `LATCHES/LOCKS/LINKAGES`, `POWER TRAIN`, `SEATS`, `SEAT BELTS`, `SERVICE BRAKES`, `STEERING`, `STRUCTURE`, `VEHICLE SPEED CONTROL`, `VISIBILITY`, `VISIBILITY/WIPER`, `UNKNOWN OR OTHER`. Note: a single complaint can list multiple components comma-separated (e.g., "ELECTRICAL SYSTEM,ENGINE"). The server should match if the filter value appears anywhere in the component string. Omit to see all. |

**Returns:** `totalCount`, `componentBreakdown[]` (component name, count, crash/fire/injury totals), `complaints[]` (top N most recent: odiNumber, dateOfIncident, dateComplaintFiled, components, summary, crash/fire/injury flags, VIN prefix). When filtered by component, returns all matching complaints up to a limit.

### `nhtsa_get_safety_ratings`

Get NCAP crash test ratings and ADAS feature availability for a vehicle. Use when the user specifically wants crash test stars, rollover risk, or wants to compare safety features across vehicles.

Requires a two-step lookup internally: year/make/model resolves to one or more vehicle variants (e.g., FWD vs AWD), then each variant's full ratings are fetched.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Yes | Vehicle manufacturer. |
| `model` | string | Yes | Vehicle model. |
| `modelYear` | number | Yes | Model year. NCAP data available from 1990+, but coverage and detail increase significantly for 2011+. Pre-2011 vehicles may lack ADAS fields and have fewer test categories. |
| `vehicleId` | number | No | Specific NCAP vehicle ID (from prior results). Skips the year/make/model lookup. Use when you already have the ID from `nhtsa_get_vehicle_safety`. |

**Returns:** Per variant: `vehicleDescription`, `vehicleId`, `overallRating` (1-5 stars), `frontalCrash` (overall, driver, passenger), `sideCrash` (overall, driver, passenger, barrier, pole), `rollover` (rating, probability percentage, tip test result), `adasFeatures` (ESC, forward collision warning, lane departure -- each "Standard", "Optional", or "Not Available"), `complaintsCount`, `recallsCount`, `investigationCount`.

### `nhtsa_decode_vin`

Decode a Vehicle Identification Number to extract make, model, year, body type, engine, safety equipment, and manufacturing details. Use when the user has a VIN and needs to identify the vehicle or look up its specifications. Supports partial VINs (use `*` for unknown characters).

Accepts a single VIN or a batch of up to 50 VINs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vin` | string \| string[] | Yes | A single 17-character VIN (e.g., "1HGCM82633A004352") or an array of up to 50 VINs for batch decode. Partial VINs accepted -- use `*` for unknown positions. |
| `modelYear` | number | No | Helps resolve ambiguity for pre-1980 VINs or partial VINs. |

**API endpoints:** Single: `GET /vehicles/DecodeVinValues/{vin}?format=json`. Batch: `POST /vehicles/DecodeVINValuesBatch/` (body: semicolon-delimited `vin,year` pairs).

**Returns:** Per VIN: `make`, `model`, `modelYear`, `bodyClass`, `vehicleType`, `driveType`, `engineCylinders`, `engineDisplacementL`, `engineHP`, `fuelType`, `trim`, `manufacturer`, `plantCity`, `plantState`, `plantCountry`, safety equipment (airbag locations, ESC, ABS, traction control), `errorCode`, `errorText`. Batch results include per-VIN success/failure.

### `nhtsa_search_investigations`

Search NHTSA defect investigations (Preliminary Evaluations, Engineering Analyses, Defect Petitions, Recalls Queries). Use for questions about ongoing or past NHTSA investigations into vehicle defects.

Note: The NHTSA investigations API does not filter by make/model -- it returns all investigations regardless of query params (confirmed via testing). The full dataset is ~4,200 investigations with pagination (default 10 per page). The server must fetch and locally filter against `subject` and `description` fields. At ~4,200 records this is manageable -- a full scan requires ~420 paginated requests, so the server should cache the investigation index (refreshed periodically) rather than scanning on every query.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Free-text search across investigation subjects and descriptions. |
| `make` | string | No | Filter by manufacturer (applied locally). |
| `model` | string | No | Filter by model (applied locally). |
| `investigationType` | string | No | Filter by type: "PE" (Preliminary Evaluation), "EA" (Engineering Analysis), "DP" (Defect Petition), "RQ" (Recall Query). |
| `status` | string | No | Filter by status: "O" (Open), "C" (Closed). |
| `limit` | number | No | Max results to return. Default: 20. |
| `offset` | number | No | Pagination offset. Default: 0. |

**Returns:** `total` count, `investigations[]` each with: `nhtsaId`, `investigationType`, `status`, `subject`, `description` (HTML content stripped to text), `openDate`, `latestActivityDate`, `issueYear`.

### `nhtsa_lookup_vehicles`

Look up valid makes, models, and vehicle types in NHTSA's database. Use to resolve ambiguous vehicle names, find the correct make/model spelling, or discover what models a manufacturer produces. Consolidates several VPIC reference endpoints.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `operation` | string | Yes | "makes" (all makes -- **warning: 12,199 makes, ~700KB response**; prefer "models" with a `make` filter or use the `/products/` API for recall/complaint-scoped make lists), "models" (models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details). |
| `make` | string | No | Make name (required for "models" and "vehicle_types" operations). Partial match supported. |
| `modelYear` | number | No | Filter models to a specific year. Only for "models" operation. |
| `manufacturer` | string | No | Manufacturer name or ID (for "manufacturer" operation). Partial match supported. |

**Returns:** Varies by operation. `makes`: array of `{makeId, makeName}` -- **caution: 12,199 results from VPIC's `GetAllMakes`**. The server should suggest using "models" with a specific `make` instead. Alternatively, use the `/products/vehicle/makes?modelYear={year}&issueType=r` endpoint for a scoped list (e.g., 237 makes with 2024 recalls). `models`: array of `{modelId, modelName, makeId, makeName}`. `vehicle_types`: array of `{vehicleTypeId, vehicleTypeName}`. `manufacturer`: array of `{manufacturerId, manufacturerName, country, vehicleTypes[]}`.

---

## Implementation Notes

### API Quirks

- **Two API layers.** Vehicle-scoped endpoints (`/recalls/recallsByVehicle`, `/complaints/complaintsByVehicle`) return the complete result set for a make/model/year -- no pagination, no date filtering. Base collection endpoints (`/recalls`, `/complaints`, `/investigations`) are paginated (`offset`/`max` params, default 10 per page) and sortable but **do not filter by make/model** (params are accepted but ignored). A newer `/products/` API (`/products/vehicle/makes?modelYear={year}&issueType=r|c|i`) returns valid makes/models/years scoped to an issue type.
- **No date-range query params on any endpoint.** The base `/recalls` endpoint supports `sort=recall573ReceivedDate&order=desc` for chronological browsing, but there are no `after`/`before` filter params. Date filtering must be implemented locally.
- **Investigations ignore make/model filters.** Confirmed: the `api.nhtsa.gov/investigations` endpoint returns all ~4,200 investigations regardless of make/model query params. The server must fetch paginated results and apply local text matching against the `subject` and `description` fields. Consider caching the investigation index (refreshed hourly or daily) to avoid scanning ~420 pages per query.
- **No pagination on vehicle-scoped endpoints.** `/recallsByVehicle` and `/complaintsByVehicle` return the complete set in one response. Complaints for popular vehicles can be 200KB+ (255 complaints for 2020 Camry). Summarize server-side.
- **Inconsistent field naming everywhere.** The base `/recalls` endpoint uses camelCase with richer fields (`campaignId`, `recall573ReceivedDate`, `potaff`, `createDate`). The vehicle-scoped `/recallsByVehicle` uses PascalCase (`NHTSACampaignNumber`, `ReportReceivedDate`, `Component`) with camelCase booleans (`parkIt`, `overTheAirUpdate`). The base `/complaints` uses `odiId`, `incidentDate`, `receivedDate`; the vehicle-scoped `/complaintsByVehicle` uses `odiNumber`, `dateOfIncident`, `dateComplaintFiled`. Safety Ratings uses PascalCase (`OverallRating`, `VehicleId`) with mixed-case anomalies (`combinedSideBarrierAndPoleRating-Front`, `dynamicTipResult`). VPIC uses PascalCase with a `Results` wrapper. Normalize everything to consistent camelCase in the service layer.
- **Safety Ratings two-step.** `/SafetyRatings/modelyear/{year}/make/{make}/model/{model}` returns variant IDs, then `/SafetyRatings/VehicleId/{id}` returns the actual ratings. A single make/model/year may have multiple variants (FWD vs AWD, different body styles).
- **Campaign number responses include all affected vehicles.** Looking up campaign 20V682000 returns 65 records (one per affected make/model/year), all sharing the same summary/remedy text. Deduplicate in the response.
- **VPIC has 12,199 makes.** The `GetAllMakes` endpoint returns ~700KB of JSON. For `nhtsa_lookup_vehicles`, prefer the filtered endpoints (`GetModelsForMakeYear`, `GetMakesForVehicleType`) or the `/products/` API (237 makes for 2024 recalls) over fetching everything.
- **VPIC batch VIN decode** is a POST with a body string of `vin,year;vin,year;...` -- not JSON. Max 50 VINs per batch.
- **Complaint components are comma-separated.** A single complaint can list multiple components in one string (e.g., `"ELECTRICAL SYSTEM,ENGINE,FUEL/PROPULSION SYSTEM"`). Component filtering must match within the string, not as exact equality.

### Rate Limits

NHTSA uses "automated traffic rate control" but does not publish specific limits. The APIs are public and free. Be respectful -- no need for aggressive retry, but implement basic backoff on 429/5xx.

---

## Use Cases

- **Pre-purchase vehicle research** -- "Is the 2020 Camry safe? Any recalls I should know about?"
- **VIN lookup** -- "Decode this VIN and tell me what vehicle it is, then check for recalls"
- **Recall monitoring** -- "What recalls have been issued for Toyota vehicles in the last year?" (uses `dateRange` param with local filtering)
- **Complaint analysis** -- "What are the most common complaints about the 2019 Honda CR-V? Any crash-related issues?"
- **Fleet safety audit** -- batch-decode VINs, cross-reference against active recalls
- **Comparative safety** -- "Compare crash test ratings for the 2024 RAV4 vs CR-V vs Tucson"

---

## References

- [NHTSA Datasets and APIs](https://www.nhtsa.gov/nhtsa-datasets-and-apis)
- [VPIC API Documentation](https://vpic.nhtsa.dot.gov/api/)
- [Recalls API](https://api.nhtsa.gov/recalls/) -- vehicle-scoped: `/recallsByVehicle?make=X&model=Y&modelYear=Z`; base: `/recalls?offset=0&max=10&sort=recall573ReceivedDate&order=desc`
- [Complaints API](https://api.nhtsa.gov/complaints/) -- vehicle-scoped: `/complaintsByVehicle?make=X&model=Y&modelYear=Z`; base: `/complaints?offset=0&max=10`
- [Investigations API](https://api.nhtsa.gov/investigations) -- paginated only: `?offset=0&max=10&sort=openDate&order=desc`
- [Products API](https://api.nhtsa.gov/products/vehicle/modelYears?issueType=r) -- discovery endpoint for valid makes/models/years by issue type (`r`=recalls, `c`=complaints, `i`=investigations)
- [Safety Ratings (NCAP) API](https://api.nhtsa.gov/SafetyRatings/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
