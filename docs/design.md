---
name: nhtsa-vehicle-safety-mcp-server
status: researched
priority: high
difficulty: low
category: transportation
api_docs: https://www.nhtsa.gov/nhtsa-datasets-and-apis
---

# nhtsa-vehicle-safety-mcp-server

## Overview

Vehicle safety data from the National Highway Traffic Safety Administration. Wraps four public JSON APIs -- [Recalls](https://api.nhtsa.gov/recalls/), [Complaints](https://api.nhtsa.gov/complaints/), [Safety Ratings (NCAP)](https://api.nhtsa.gov/SafetyRatings/), and [VPIC](https://vpic.nhtsa.dot.gov/api/) (VIN decoding / vehicle info) -- plus NHTSA's ODI bulk files -- investigations ([`FLAT_INV.zip`](https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip)) and recalls ([`FLAT_RCL_POST_2010.zip`](https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip), [`FLAT_RCL_PRE_2010.zip`](https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip)) -- to provide searchable access to ~30K recall campaigns (received since 1966, for model years back to 1949), 1.6M+ consumer complaints, crash test ratings, ~5,300 defect investigations, and vehicle identification (12K+ makes). No auth required; all public.

NHTSA exposes two API layers: **vehicle-scoped endpoints** (`/recallsByVehicle`, `/complaintsByVehicle`) that return the complete result set for a make/model/year with no pagination, and **base collection endpoints** (`/recalls`, `/complaints`, `/investigations`) that are paginated and sortable but do not reliably filter by make/model. A newer **`/products/`** API provides valid make/model/year discovery for each issue type. The server uses the vehicle-scoped endpoints for per-vehicle queries; for investigations, and for recall searches that are not scoped to one vehicle or campaign, it bypasses the API layer entirely in favor of the ODI bulk files, which carry the full corpus with make/model/component associations in one download each.

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

Get a comprehensive safety profile for a vehicle. Combines recalls, complaint summary, and NCAP crash test ratings into a single response. Use this as the default when a user asks about vehicle safety, reliability, or "should I buy this car?"

Internally calls the Safety Ratings, Recalls, and Complaints APIs and merges the results. For a vehicle NCAP never rated, `safetyRatings` comes back as an empty array beside the recalls and complaints.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Yes | Vehicle manufacturer (e.g., "Toyota", "Ford"). Case-insensitive. |
| `model` | string | Yes | Vehicle model (e.g., "Camry", "F-150"). Case-insensitive. |
| `modelYear` | integer | Yes | Model year (e.g., 2020). |

**Returns:** `safetyRatings` (overall, frontal, side, rollover stars; rollover probability, omitted for vehicles NHTSA never rollover-tested; ADAS features), `recalls[]` (campaign number, manufacturer, component, report date, the do-not-drive, park-outside, and over-the-air-update advisories, and `summary`, `consequence`, and `remedy`, each omitted for older campaigns whose record leaves it blank), `complaintSummary` (total count, every component by frequency, crash/fire/injury/death counts), and `sectionStatus` plus warnings so an upstream outage is not read as a clean record. Includes `vehicleId` for follow-up Safety Ratings queries. Enrichment carries `effectiveQuery` and a `notice` when every section matched nothing, or when recalls or complaints matched nothing while another section had records; it points at `nhtsa_lookup_vehicles` with `operation="dataset_models"`, since NHTSA's datasets can file one vehicle under different model names. Empty NCAP ratings alone raise no notice, because NCAP rates only some vehicles.

### `nhtsa_search_recalls`

Search recall campaigns by campaign number, by vehicle, or across every campaign. Use for questions about specific recalls, recall history for a vehicle, a known campaign number, or "which campaigns did this make issue since a date".

Three modes, chosen by which inputs are present:

- **Campaign:** `campaignNumber` returns the campaign with every vehicle it covers. A 6-character number (e.g., "00V419") returns every campaign it covers, grouped by full campaign number and sorted.
- **Vehicle:** `make`, `model`, and `modelYear` together return that vehicle's recalls from the Recalls API.
- **Broad:** any other combination of `make`, `model`, `modelYear`, and `dateRange` searches NHTSA's recall flat files, newest received date first, paged with `limit` and `offset`. A campaign matches when one of its vehicle records carries every vehicle filter; make and model compare against the whole name as the recall record spells it, ignoring case, so a series name and a base name are separate searches.

Supports inclusive `dateRange` filtering in every mode. The NHTSA API does not natively support date-range queries, so the server filters normalized received dates locally. Bounds must be calendar-valid `YYYY-MM-DD`, with `after` on or before `before`; blank bounds are unset. Active bounds exclude records without a usable received date. An existing result filtered to zero carries date-bound recovery, distinct from a genuine upstream miss.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `campaignNumber` | string | No | NHTSA campaign number (e.g., "20V682000"). When provided, returns the campaign detail plus every vehicle it covers; a 6-character number returns every campaign it covers. Mutually exclusive with `make`/`model`/`modelYear`. |
| `make` | string | No | Vehicle make. With `model` and `modelYear`, a vehicle lookup; otherwise a broad-search filter on the whole make name. |
| `model` | string | No | Vehicle model. With `make` and `modelYear`, a vehicle lookup; otherwise a broad-search filter on the whole model name. |
| `modelYear` | integer | No | Model year. With `make` and `model`, a vehicle lookup; otherwise a broad-search filter. |
| `dateRange` | object | No | Inclusive received-date bounds in every mode: `{ after?: string, before?: string }`, calendar-valid `YYYY-MM-DD`. A bound alone is a broad search. Blank bounds are unset; inverted ranges are rejected before upstream work. |
| `limit` | number | No | Campaigns per page of a broad search. Default 20, at most 50. Rejected with `campaignNumber` or a full vehicle lookup, which return every match. |
| `offset` | integer | No | Pagination offset into a broad search's newest-first results. Default 0. Same restriction as `limit`. |

**Returns:** Array of recalls, each with: `campaignNumber`, `manufacturer`, `component`, `reportReceivedDate` (ISO 8601), `parkIt`, `parkOutSide` (do-not-drive advisories), `overTheAirUpdate`, and `summary`, `consequence`, `remedy`, each omitted for older campaigns whose record leaves it blank. Campaign number queries return one collapsed record per campaign and additionally carry `potentialUnitsAffected` (omitted when NHTSA sends none), `affectedVehicles[]` (every distinct make/model/model-year the campaign covers; equipment and tire campaigns name the part here -- make is the brand, model is the part -- with no model year), and `investigationId` (the ODI action number, when NHTSA links one; feed it to `nhtsa_search_investigations` as `nhtsaId`). Broad rows carry `potentialUnitsAffected` and a `component` joining the campaign's components with " | "; `overTheAirUpdate` is never set, because the flat files carry no such flag. `totalCount` is exact in every mode; a broad search adds `returned`, `offset`, and `limit`.

**Error modes:** `campaignNumber` combined with a vehicle param, or `limit`/`offset` sent with `campaignNumber` or a full vehicle lookup -- `mode_conflict`. No `campaignNumber`, vehicle param, or `dateRange` bound -- `missing_required_combo`. A `limit` over 50 is lowered to 50 with a `notice` naming the next `offset`; with `NHTSA_CLAMP_LIMITS=false` it is `limit_too_large`. A campaign number NHTSA has no record of is a `campaign_not_found` error; a vehicle or broad search with no recalls is an empty success with a `notice` (the vehicle notice names `nhtsa_lookup_vehicles` `operation="dataset_models"`; the broad notice names the filters to relax).

### `nhtsa_search_complaints`

Search consumer safety complaints filed with NHTSA. Use for questions about common problems, failure patterns, or issues reported by owners for a specific vehicle.

Returns can be large (200+ complaints for a popular vehicle year). The server summarizes by component and returns the most recent complaints, with a count of total results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Yes | Vehicle manufacturer. |
| `model` | string | Yes | Vehicle model. |
| `modelYear` | integer | Yes | Model year. |
| `component` | string | No | Filter to complaints naming a component. Values are uppercase from NHTSA's taxonomy. Common values: `AIR BAGS`, `BACK OVER PREVENTION`, `ELECTRICAL SYSTEM`, `ENGINE`, `ENGINE AND ENGINE COOLING`, `EQUIPMENT`, `FORWARD COLLISION AVOIDANCE`, `FUEL/PROPULSION SYSTEM`, `LANE DEPARTURE`, `LATCHES/LOCKS/LINKAGES`, `POWER TRAIN`, `SEATS`, `SEAT BELTS`, `SERVICE BRAKES`, `STEERING`, `STRUCTURE`, `VEHICLE SPEED CONTROL`, `VISIBILITY`, `VISIBILITY/WIPER`, `UNKNOWN OR OTHER`. A single complaint lists its components joined by a bare comma (e.g., "ELECTRICAL SYSTEM,ENGINE"), and a name can itself contain ", " (e.g., "SERVICE BRAKES, HYDRAULIC"). The filter matches case-insensitively within each individual name, so "BRAKES" matches "SERVICE BRAKES, HYDRAULIC". Omit to see all. |
| `limit` | number | No | Complaint narratives per page. Default 20, at most 50; a larger value is lowered to 50 with a `notice` (`limit_too_large` with `NHTSA_CLAMP_LIMITS=false`). |
| `offset` | integer | No | Pagination offset into the filing-date-descending complaint list. Default 0. |

**Returns:** `totalCount`, `returned`, `offset`, `limit`, `componentBreakdown[]` (component name, complaint count, crash/fire/injury/death totals, including zeros in text), `complaints[]` (the requested page, newest filed first: odiNumber, dateOfIncident and dateComplaintFiled as ISO 8601, components, summary, reported severity, VIN prefix). Component aggregates cover all matching complaints independently of narrative pagination. A vehicle with complaints where none match `component` is an empty success with a `notice` to omit `component`. A complaint whose reported incident date its own record rules out carries `unreliableIncidentDate` in place of `dateOfIncident`.

### `nhtsa_get_safety_ratings`

Get NCAP crash test ratings and ADAS feature availability for a vehicle. Use when the user specifically wants crash test stars, rollover risk, or wants to compare safety features across vehicles.

Requires a two-step lookup internally: year/make/model resolves to one or more vehicle variants (e.g., FWD vs AWD), then each variant's full ratings are fetched.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `make` | string | Unless `vehicleId` | Vehicle manufacturer. |
| `model` | string | Unless `vehicleId` | Vehicle model. |
| `modelYear` | integer | Unless `vehicleId` | Model year. NCAP data available from 1990+, but coverage and detail increase significantly for 2011+. Pre-2011 vehicles may lack ADAS fields and have fewer test categories. |
| `vehicleId` | number | No | Specific NCAP vehicle ID (from prior results). Mutually exclusive with active make/model/modelYear criteria; optional blank strings are unset. |

**Returns:** Per variant: `vehicleDescription`, `vehicleId`, `overallRating` (1-5 stars), `frontalCrash` (overall, driver, passenger), `sideCrash` (overall, driver, passenger, barrier, pole), `rollover` (rating, probability as a 0-1 fraction, tip test result), `adasFeatures` (ESC, forward collision warning, lane departure -- each "Standard", "Optional", or "No"), `complaintsCount`, `recallsCount`, `investigationCount`.

### `nhtsa_decode_vin`

Decode a Vehicle Identification Number to extract make, model, year, body type, engine, safety equipment, and manufacturing details. Use when the user has a VIN and needs to identify the vehicle or look up its specifications. Supports partial VINs (use `*` for unknown characters).

Accepts one VIN or several, as an array or joined in one string. Each entry is NFKC-normalized and trimmed, then split on whitespace and `;`, and each piece on `,` -- except a `VIN,YYYY` piece, which is one VIN with its own model year. A VIN is 1-17 letters, digits, or `*`. A string naming several VINs takes only full 17-character VINs, since a separator inside a single VIN would otherwise split it into partials that each decode as something else; send a partial VIN as its own entry. A call takes at most 500 VINs after splitting and decodes the first 50; the rest come back in `deferredVins`, each carrying its year as `VIN,YYYY`, to pass back as `vin`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vin` | string \| string[] | Yes | One VIN (e.g., "1HGCM82633A004352"), or several separated by spaces, semicolons, or commas, or listed in an array of at most 500 entries. Partial VINs accepted -- use `*` for unknown positions. `,YYYY` after a VIN gives it its own model year. |
| `modelYear` | integer | No | Model year for every VIN without its own `,YYYY`. Helps resolve ambiguity for pre-1980 VINs or partial VINs. |

**API endpoints:** Single: `GET /vehicles/DecodeVinValues/{vin}?format=json`. Batch: `POST /vehicles/DecodeVINValuesBatch/` (form-encoded body: semicolon-delimited `vin,year` pairs).

**Returns:** `vehicles[]`, per VIN: `make`, `model`, `modelYear`, `bodyClass`, `vehicleType`, `driveType`, `engineCylinders`, `engineDisplacementL`, `engineHP`, `fuelType`, `trim`, `manufacturer`, `plantCity`, `plantState`, `plantCountry`, safety equipment (airbag locations including seat cushion, ESC, ABS, traction control, TPMS type), 14 driver-assistance features named for VPIC's variables (crash imminent braking, dynamic brake support, pedestrian automatic emergency braking, forward collision warning, lane departure warning, lane keeping and centering assistance, blind spot warning and intervention, rear cross traffic alert, backup camera, rear automatic emergency braking, parking assist, adaptive cruise control) each "Standard", "Optional", or "Not Available" and omitted when VPIC leaves it blank, `errorCode`, `errorText`. "Optional" means the VIN's configuration offers the feature; the VIN does not record whether this vehicle has it. `deferredVins` is present when the call named more than 50. Every upstream value is markdown-escaped in `content[]`.

**Error modes:** `empty_vin_list` for an empty list or an entry that is blank or only separators; `invalid_vin` for a character outside letters, digits, and `*`, a VIN over 17 characters, or a partial VIN inside a multi-VIN string, with a message naming the entry and position; `batch_too_large` over 500 VINs, or over 50 with `NHTSA_CLAMP_LIMITS=false`.

### `nhtsa_search_investigations`

Search NHTSA defect investigations (Preliminary Evaluations, Engineering Analyses, Defect Petitions, Recall Queries, Audit Queries, and the other ODI action codes). Use for questions about ongoing or past NHTSA investigations into vehicle defects.

Source is the ODI bulk file `FLAT_INV.zip`, not `api.nhtsa.gov/investigations` — the API returns all investigations regardless of make/model params, so filtering there is impossible without a full paginated scan. The bulk file carries the whole corpus in one TAB-delimited download, including the make/model/year/component associations the API omits. The server streams and inflates it, parsing lines as they arrive so the ~371 MB decompressed file is never held whole in memory, and groups the association rows by NHTSA action number into ~5,300 deduplicated records, keeping only the fields the tool serves. Each service instance shares one pending load, independent of caller cancellation, with a two-minute deadline that covers the wait for the load slot, the download, and the parse. A body that is not a readable ZIP archive, or whose entries hold no rows, fails `ServiceUnavailable` and caches nothing. Failed or timed-out loads clear pending work for retry; successful loads cache for 24 hours from completion, matching the file's daily refresh cadence. The investigation and recall files load one at a time through a process-wide slot (see Design Decisions).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nhtsaId` | string | No | Exact NHTSA investigation ID (e.g. "EA23003"), case-insensitive. Mutually exclusive with every other filter. |
| `query` | string | No | Free-text search across investigation IDs, subjects, and summaries. |
| `make` | string | No | Vehicle make on one of the investigation's vehicle associations, matched case-insensitively within the name. |
| `model` | string | No | Vehicle model on one of the investigation's vehicle associations, matched case-insensitively within the name. |
| `modelYear` | integer | No | Model year. Matches when one vehicle association carries this year together with every supplied `make` and `model`; an investigation with no model year on any association never matches. |
| `component` | string | No | Structured filter against the affected components (e.g., "STEERING"). |
| `investigationType` | string | No | Filter by ODI action code: "PE" (Preliminary Evaluation), "EA" (Engineering Analysis), "DP" (Defect Petition), "RQ" (Recall Query), "AQ" (Audit Query), and other codes present in the dataset (SQ, EQ, RP, ID, TA, C). |
| `status` | string | No | Filter by status: "O" (Open) or "C" (Closed). Derived from close-date presence in the flat file, so these are the only two values. |
| `openDateRange` | object | No | Inclusive opened-date bounds: `{ after?: string, before?: string }`, calendar-valid `YYYY-MM-DD`. |
| `closeDateRange` | object | No | Inclusive closed-date bounds with the same contract; active bounds exclude records without a usable close date, including open investigations. |
| `includeSummary` | boolean | No | Include each investigation's full summary in search rows. Default false; `nhtsaId` mode always returns it. A summary can run several thousand characters, so pair this with a small `limit`. |
| `limit` | number | No | Investigations per page. Default 20, at most 50; a larger value is lowered to 50 with a `notice` (`limit_too_large` with `NHTSA_CLAMP_LIMITS=false`). |
| `offset` | integer | No | Pagination offset into the matching investigations, ordered newest-opened first: open date descending, then ID descending, undated last. Default 0. |

All filters are ANDed before counting and pagination. `make`, `model`, and `modelYear` must all match on the same vehicle association, so `make` "Toyota" with `model` "Camry" does not match an investigation that lists Toyota on one association and Camry under another make. Blank date bounds are unset; inverted ranges fail before loading. Active date ranges conflict with exact `nhtsaId`, but empty or blank ranges do not. One shared date contract keeps recall and investigation boundaries identical.

**Returns:** `totalCount`, `returned`, `offset`, `limit`, and `investigations[]` each with: `nhtsaId`, `investigationType`, `investigationTypeName`, `status`, `statusName`, `makes[]`, `models[]`, `years[]` (ascending, across every make and model the investigation covers), `components[]`, `manufacturers[]` (every manufacturer named on the vehicle associations), `subject`, `summary` (plain text as published in the flat file; present in `nhtsaId` mode, and in search rows only with `includeSummary`), `openDate`, `closeDate`, `recallCampaigns[]` (every linked campaign number, usable with `nhtsa_search_recalls`). A search page whose rows dropped their summaries carries a `notice` naming `nhtsaId` and `includeSummary`. An `nhtsaId` filter fetches a single investigation by its exact ID -- the reverse of that link, and the consumer of the `investigationId` `nhtsa_search_recalls` returns for a campaign. It is mutually exclusive with the other filters, matching the `campaignNumber` precedent in `nhtsa_search_recalls`.

### `nhtsa_lookup_vehicles`

Look up valid makes, models, and vehicle types in NHTSA's database. Use to resolve ambiguous vehicle names, find the correct make/model spelling, or discover what models a manufacturer produces. Consolidates several VPIC reference endpoints.

VPIC names often differ from the names the complaint and NCAP datasets use (Silverado vs SILVERADO 1500), and a vehicle's recalls can be split between a series name and a base name. The `dataset_models` operation lists the names the complaint, NCAP, and VPIC lists carry for a make and model year, so a search that comes back empty or partial can be repeated under each. No list enumerates recall names; search recalls under both the series name and the base name.

Identifiers are trimmed. Optional blank strings are unset; required make/model names in complaints and composite vehicle safety must be nonblank. Lookup operations reject arguments unused by the selected operation: `makes` accepts no filters, `models` and `dataset_models` accept `make`/`modelYear`, `vehicle_types` accepts `make`, and `manufacturer` accepts `manufacturer`. Limit and offset work for every operation; `limit` defaults to 100 and is at most 200, and a larger value is lowered to 200 with a `notice` (`limit_too_large` with `NHTSA_CLAMP_LIMITS=false`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `operation` | string | Yes | "makes" (all makes -- **warning: 12,199 makes, ~700KB response**; prefer "models" with a `make` filter or use the `/products/` API for recall/complaint-scoped make lists), "models" (VPIC models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details), "dataset_models" (model names the complaint, NCAP, and VPIC lists carry for a make and model year). |
| `make` | string | No | Make name (required for "models", "vehicle_types", and "dataset_models"). VPIC matches partial names in "models" and "vehicle_types"; "dataset_models" takes the full make name (e.g., "Chevrolet"). |
| `modelYear` | integer | No | Filters "models" to a year; required for "dataset_models". Not accepted by other operations. |
| `manufacturer` | string | No | Manufacturer name or ID (for "manufacturer" operation). Partial match supported; broad matches are capped -- see below. |

**Returns:** Varies by operation. `makes`: array of `{makeId, makeName}` -- **caution: 12,199 results from VPIC's `GetAllMakes`**. The server should suggest using "models" with a specific `make` instead. Alternatively, use the `/products/vehicle/makes?modelYear={year}&issueType=r` endpoint for a scoped list (e.g., 237 makes with 2024 recalls). `models`: array of `{modelId, modelName, makeId, makeName}`. `vehicle_types`: array of `{vehicleTypeId, vehicleTypeName}`. `manufacturer`: array of `{manufacturerId, manufacturerName, country, vehicleTypes[]}` -- VPIC paginates this endpoint and publishes no match total, so the lookup walks pages up to a fixed record cap and discloses the cap through the `truncated`/`shown`/`cap` enrichment fields when it is reached. `dataset_models`: array of `{modelName, listedBy[]}`, one entry per uppercase name sorted by name, where `listedBy` holds `products` (the names complaint searches match), `ncap` (the names NCAP rating searches match), and `vpic` (VPIC base names, which some recall campaigns are filed under). If any of the three lists fails to load, the call fails rather than return a name set with a missing tag that would read as "not listed".

---

## Implementation Notes

### API Quirks

- **Two API layers.** Vehicle-scoped endpoints (`/recalls/recallsByVehicle`, `/complaints/complaintsByVehicle`) return the complete result set for a make/model/year -- no pagination, no date filtering. Base collection endpoints (`/recalls`, `/complaints`, `/investigations`) are paginated (`offset`/`max` params, default 10 per page) and sortable but **do not filter by make/model** (params are accepted but ignored). A newer `/products/` API (`/products/vehicle/makes?modelYear={year}&issueType=r|c|i`) returns valid makes/models/years scoped to an issue type.
- **No date-range query params on any endpoint.** The base `/recalls` endpoint supports `sort=recall573ReceivedDate&order=desc` for chronological browsing, but there are no `after`/`before` filter params. Date filtering must be implemented locally.
- **Investigations ignore make/model filters, so the server uses the bulk file instead.** Confirmed: the `api.nhtsa.gov/investigations` endpoint returns all investigations regardless of make/model query params, and its records omit vehicle associations. `FLAT_INV.zip` carries the full corpus with one row per make/model/year/component association, which the server groups by NHTSA action number and caches for 24 hours.
- **No pagination on vehicle-scoped endpoints.** `/recallsByVehicle` and `/complaintsByVehicle` return the complete set in one response. Complaints for popular vehicles can be 200KB+ (255 complaints for 2020 Camry). Summarize server-side.
- **Inconsistent field naming everywhere.** The base `/recalls` endpoint uses camelCase with richer fields (`campaignId`, `recall573ReceivedDate`, `potaff`, `createDate`). The vehicle-scoped `/recallsByVehicle` uses PascalCase (`NHTSACampaignNumber`, `ReportReceivedDate`, `Component`) with camelCase booleans (`parkIt`, `overTheAirUpdate`). The base `/complaints` uses `odiId`, `incidentDate`, `receivedDate`; the vehicle-scoped `/complaintsByVehicle` uses `odiNumber`, `dateOfIncident`, `dateComplaintFiled`. Safety Ratings uses PascalCase (`OverallRating`, `VehicleId`) with mixed-case anomalies (`combinedSideBarrierAndPoleRating-Front`, `dynamicTipResult`). VPIC uses PascalCase with a `Results` wrapper. Normalize everything to consistent camelCase in the service layer.
- **Safety Ratings two-step.** `/SafetyRatings/modelyear/{year}/make/{make}/model/{model}` returns variant IDs, then `/SafetyRatings/VehicleId/{id}` returns the actual ratings. A single make/model/year may have multiple variants (FWD vs AWD, different body styles).
- **Campaign number responses include all affected vehicles.** Looking up a campaign returns one record per affected make/model/year (65 for 20V682000, 28 for 24V744000), all sharing the same summary/remedy text, in a single response -- there is no second page to fetch. The service collapses the row set into one campaign record and lifts the distinct vehicles into `affectedVehicles[]`.
- **`ModelYear` is `"9999"` where no model year applies.** Every equipment (`…E…`) and tire (`…T…`) row carries it, and such a row can also appear inside a vehicle campaign (25V200000 covers two Great Dane trailer years plus one Bridgestone tire at `9999`). Those rows still name a make and model -- the brand and the part -- so they belong in `affectedVehicles[]`; only the placeholder year is dropped.
- **Opposite slash-date conventions between recalls and complaints.** `/recallsByVehicle` and `/recalls/campaignNumber` emit `DD/MM/YYYY`; `/complaintsByVehicle` emits `MM/DD/YYYY`. Neither is self-describing, so each path needs its own parser. Both normalize to ISO `YYYY-MM-DD` before leaving the service layer -- every date the server emits uses one format.
- **VPIC paginates `GetManufacturerDetails` at 100 per page, and its `Count` is that page's size, not a match total.** A partial name like `hon` spans three pages (100/100/55) and nothing in the response reports 255; the only way to learn a total is to page until a short page arrives, and a one-letter query already fills page 1. The service walks pages up to a fixed record cap and the tool discloses when the cap was hit, rather than presenting page 1 as the complete set.
- **VPIC has 12,199 makes.** The `GetAllMakes` endpoint returns ~700KB of JSON. For `nhtsa_lookup_vehicles`, prefer the filtered endpoints (`GetModelsForMakeYear`, `GetMakesForVehicleType`) or the `/products/` API (237 makes for 2024 recalls) over fetching everything.
- **VPIC batch VIN decode** is a POST with a form-encoded body whose data is a string of `vin,year;vin,year;...` -- not JSON. The server decodes 50 VINs per call.
- **Complaint components are comma-separated, and names can contain commas.** A single complaint lists its components joined by a bare comma (e.g., `"ELECTRICAL SYSTEM,ENGINE,FUEL/PROPULSION SYSTEM"`), while a name can itself hold ", " (`"SERVICE BRAKES, HYDRAULIC"`). The server splits on a comma not followed by a space, so each name stays whole; the component breakdown and the `component` filter share that split, and the filter matches within each name rather than the joined string.
- **The three model-name lists use different names for one vehicle.** The products list (`/products/vehicle/models`, which the complaint search matches) and the NCAP list (`/SafetyRatings/modelyear/{year}/make/{make}`) spell models as NHTSA files them (`SILVERADO 1500`), while VPIC carries base names (`Silverado`); recall campaigns may be filed under either a series name or a base name. The products route returns the same rows for every `issueType`, needs a large `max` because its own `offset` paging skips and repeats rows, reports a `count` equal to the rows returned, returns nothing without a `modelYear`, and matches only a full make name, where VPIC matches partial names.
- **Recall flat files differ from the Recalls API.** `FLAT_RCL_POST_2010.zip` and `FLAT_RCL_PRE_2010.zip` carry one row per campaign, vehicle, and component (about 30,000 campaigns together), and the received date a campaign reports there can fall one day before the date the Recalls API reports for it. Campaigns with a blank description in the files have no `summary`.
- **Older campaigns carry null recall text.** The Recalls API returns `Summary`, `Consequence`, and `Remedy` as null for some 1960s campaigns (66V008001, a 1967 Dodge Dart), with the description in `Notes`; the server omits the three fields rather than filling placeholders. Complaints from the same era can have a null `dateOfIncident`.
- **`dateOfIncident` carries both missing-value placeholders and raw typos.** Measured over the 2,230,037-row ODI complaint file (`FLAT_CMPL.zip`, 2026-07-30): 110,144 rows blank, 5,659 in 1901 spread across 8 distinct days, 684 at `12/31/1969`, none at `01/01/1970`. Those are what the endpoint writes where the complainant gave no date, and they are the only values safe to match on — the earliest incident date the corpus corroborates is 1965-12-01 (ODI 565559, a 1965 Beetle), so any date floor set to catch placeholders destroys real records. A separate 169 rows carry transcription errors (`1016` for `2016`, a 1900–1947 cluster, `0201`, `1527`, `2203`). Those are not identifiable by value at all; they are identifiable only against the record's own fields — an incident cannot postdate the complaint filed about it (582 rows), and cannot predate the vehicle it describes (1,954 rows, using `modelYear - 1` since a model year opens in the preceding calendar year). Together those bounds reach 159 of the 169. The remaining 10 carry the `9999` no-model-year placeholder, which leaves no vehicle to date against — and `complaintsByVehicle` does not serve them either, since it takes a model year and returns nothing for `9999`. A value the bounds reject is reported as `unreliableIncidentDate` rather than dropped, so a caller can tell "NHTSA holds no incident date" from "NHTSA holds one its own record contradicts."

### Design Decisions

- **Bulk files load one at a time through a process-wide slot.** The investigation and recall files inflate to hundreds of megabytes, and loading them together multiplies peak memory; taking turns bounds it at one file's working set, and each load's deadline covers the wait for the slot.
- **Investigations and broad recall searches match on one vehicle association.** Make, model, and model year must all hold on the same association row. Matching each filter against the pooled makes, models, and years of an investigation or campaign returns vehicles it never covered.
- **Investigation summaries are opt-in.** A summary can run several thousand characters, enough to make a 50-row page hundreds of kilobytes. Search rows carry the subject, dates, and vehicle associations; `includeSummary` and `nhtsaId` return the text.
- **Over-cap requests are clamped by default, with a strict switch.** A `limit` over its maximum is lowered to the cap and disclosed in a `notice` with the next `offset`, and a VIN batch over 50 decodes the first 50 and returns the rest in `deferredVins`, so an agent that asks for too much still gets a usable answer. `NHTSA_CLAMP_LIMITS=false` rejects instead (`limit_too_large`, `batch_too_large`) for deployments that prefer an explicit failure. The advertised `limit` schemas carry no maximum and the `vin` array keeps its 500-entry ceiling in both modes, so `tools/list` is identical in both.
- **`dataset_models` merges three upstream lists.** The products, NCAP, and VPIC lists each hold some of the names NHTSA files a vehicle under, and no one of them is complete. One merged, tagged list lets an agent search each dataset under the names that dataset uses, and a failed list fails the call so a missing tag never reads as "not listed".

### Rate Limits

NHTSA uses "automated traffic rate control" but does not publish specific limits. The APIs are public and free. Be respectful -- no need for aggressive retry, but implement basic backoff on 429/5xx.

---

## Use Cases

- **Pre-purchase vehicle research** -- "Is the 2020 Camry safe? Any recalls I should know about?"
- **VIN lookup** -- "Decode this VIN and tell me what vehicle it is, then check for recalls"
- **Recall monitoring** -- "What recalls have been issued for the 2020 Camry in the last year?" (uses `dateRange` param with local filtering) or "which Toyota campaigns were received since January?" (broad search by make and `dateRange`)
- **Complaint analysis** -- "What are the most common complaints about the 2019 Honda CR-V? Any crash-related issues?"
- **Fleet safety audit** -- batch-decode VINs, cross-reference against active recalls
- **Comparative safety** -- "Compare crash test ratings for the 2024 RAV4 vs CR-V vs Tucson"

---

## References

- [NHTSA Datasets and APIs](https://www.nhtsa.gov/nhtsa-datasets-and-apis)
- [VPIC API Documentation](https://vpic.nhtsa.dot.gov/api/)
- [Recalls API](https://api.nhtsa.gov/recalls/) -- vehicle-scoped: `/recallsByVehicle?make=X&model=Y&modelYear=Z`; base: `/recalls?offset=0&max=10&sort=recall573ReceivedDate&order=desc`
- [Complaints API](https://api.nhtsa.gov/complaints/) -- vehicle-scoped: `/complaintsByVehicle?make=X&model=Y&modelYear=Z`; base: `/complaints?offset=0&max=10`
- [Investigations bulk file](https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip) -- TAB-delimited ODI flat file, refreshed daily; the source this server uses
- [Recall bulk files](https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip) -- `FLAT_RCL_POST_2010.zip` and `FLAT_RCL_PRE_2010.zip`, TAB-delimited ODI flat files (layout `RCL.txt`), refreshed daily; the source for broad recall searches
- [Investigations API](https://api.nhtsa.gov/investigations) -- paginated only: `?offset=0&max=10&sort=openDate&order=desc`; unused, no make/model filtering or vehicle associations
- [Products API](https://api.nhtsa.gov/products/vehicle/modelYears?issueType=r) -- discovery endpoint for valid makes/models/years by issue type (`r`=recalls, `c`=complaints, `i`=investigations)
- [Safety Ratings (NCAP) API](https://api.nhtsa.gov/SafetyRatings/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
