# Changelog

## [0.7.1] - 2026-04-24

### Changed

- Bumped `@cyanheads/mcp-ts-core` to `^0.7.0` (from `^0.6.12`) — adopts flattened ZodError messages, structured `issues` on `McpError.data`, locale-aware `format-parity` numeric matching, directory-based changelog convention, and the recursive `describe-on-fields` linter
- Added `.describe()` on array-element objects and `z.union()` variants across all 7 tool definitions to satisfy the new recursive `describe-on-fields` linter — no behavioral change, tighter JSON Schema for LLM consumption
- `CLAUDE.md` / `AGENTS.md` now reference `security-pass` in the "What's Next?" sequence and skills table; added three external-API checklist items covering upstream sparsity, uncertainty preservation in `format()`, and sparse-payload test coverage

### Added

- `skills/security-pass` v1.1 — MCP-flavored security audit skill covering output injection, scope blast radius, destructive ops, upstream auth, input sinks, tenant isolation, leakage, resource bounds, and HTTP deployment surface
- `scripts/build-changelog.ts`, `scripts/check-docs-sync.ts`, `scripts/check-skills-sync.ts` — framework scripts synced from the package; devcheck now enforces `CLAUDE.md` / `AGENTS.md` byte-parity and `skills/` ↔ agent-mirror parity
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` synced to framework template — scoped package name, auto-assign to `cyanheads`, secondary-labels guidance (`regression`, `performance`, `security`, `breaking-change`)

### Framework skill refresh

- `api-linter` v1.0 → v1.1 (recursion rules, union asymmetry callout)
- `maintenance` v1.4 → v1.5 (default-adopt tier for framework changes, "Open decisions" rename)
- `release-and-publish` v2.0 → v2.1 (retry transient network failures, `docker builder prune -f` before retry)
- `report-issue-framework` v1.2 → v1.3, `report-issue-local` v1.2 → v1.3 (primary/secondary label split, `--assignee @me`)

## [0.7.0] - 2026-04-23

### Changed

- **Breaking:** `nhtsa_search_investigations` output field `total` renamed to `totalCount` for naming parity with sibling tools
- **Breaking:** `nhtsa_lookup_vehicles` output reshaped — `count` and `totalAvailable` dropped in favor of unified `totalCount` + `returned` + `offset` + `limit` across every operation
- **Breaking:** `nhtsa_lookup_vehicles` `limit`/`offset` now apply to all operations (`makes`, `models`, `vehicle_types`, `manufacturer`) via client-side slicing; previously ignored for operations other than `makes`. Out-of-bounds offsets now return a recovery message uniformly across operations
- `nhtsa_decode_vin` description clarified — explicit "pass a single VIN string, or an array of up to 50 VINs for batch decode" (was ambiguous about the batch form)
- Bumped `@cyanheads/mcp-ts-core` to `^0.6.12` (from `^0.5.3`) — adds landing page at `/`, SEP-1649 Server Card at `/.well-known/mcp.json`, new format-parity linter rule, `HtmlExtractor` utility
- Bumped `@biomejs/biome` to `^2.4.13`, `vitest` to `^4.1.5`
- `createApp()` now configures `landing.tagline` + `landing.repoRoot` for per-tool view-source links on the hosted deployment
- Documented `MCP_PUBLIC_URL` env var in `.env.example` for the TLS-proxied hosted deployment

### Added

- `skills/api-linter` and `skills/release-and-publish` — new skills from the framework
- Refreshed 13 skills from the framework: `add-app-tool` v1.3, `add-prompt` v1.2, `add-resource` v1.3, `add-service` v1.3, `add-tool` v1.8, `api-context` v1.1, `api-services` v1.3, `api-utils` v2.1, `design-mcp-server` v2.7, `field-test` v2.0, `maintenance` v1.4, `polish-docs-meta` v1.7, `setup` v1.5, `report-issue-framework` v1.2, `report-issue-local` v1.2

## [0.6.1] - 2026-04-20

### Added

- All tool handlers now propagate `ctx.signal` through the NHTSA service layer so in-flight requests (and exponential-backoff retry delays) cancel cleanly when the client aborts
- `nhtsa_search_investigations` now returns `statusName` alongside `status` and renders both in `format()` (e.g. `[O: Open]`) so the status code is no longer opaque
- `nhtsa_lookup_vehicles` now surfaces `Make ID`, `Manufacturer ID`, and per-type `Vehicle Type ID` in its rendered output, matching the IDs already present in `structuredContent`
- `nhtsa_get_safety_ratings` now renders `combinedBarrierPoleFront` / `combinedBarrierPoleRear` star ratings (previously only present in `structuredContent`)
- `nhtsa_get_vehicle_safety` complaint component breakdown now shows injury and death counts per component (not just crashes/fires)

### Changed

- Bumped `@cyanheads/mcp-ts-core` to `^0.5.3` (from `^0.3.8`) — brings new framework error factories and refreshed scaffolding
- `NhtsaService.fetchJson` now composes the caller's `AbortSignal` with the per-request timeout via `AbortSignal.any` and uses `node:timers/promises` for retry delay — no more manual abort listener wiring, no listener leak
- `nhtsa_decode_vin` warning line now includes the VPIC `errorCode` (e.g. `Warning (errorCode: 6): ...`) so partial-decode callers can distinguish warning classes
- `nhtsa_get_vehicle_safety` do-not-drive advisory renders as `PARK IT — DO NOT DRIVE` to match NHTSA's own label
- Refreshed `add-tool` (v1.6), `api-config` (v1.2), `design-mcp-server` (v2.4), `field-test` (v1.2), `maintenance` (v1.3), `polish-docs-meta` (v1.4), and `setup` (v1.3) skills from the framework

### Removed

- Unused `NhtsaService.getRecallsPaginated` method (also had a typo'd `sort=recall573ReceivedDate` URL parameter)

## [0.6.0] - 2026-04-19

### Added

- `nhtsa_search_complaints` now supports `limit` (default 20, max 50) and `offset` pagination; `componentBreakdown` continues to reflect all matching complaints regardless of pagination ([#4](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/4))
- `nhtsa_lookup_vehicles`, `nhtsa_get_safety_ratings`, and `nhtsa_search_investigations` now surface an optional `message` field when the result set is empty, echoing applied filters and pointing at recovery actions ([#7](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/7))
- `combinedBarrierPoleFront` and `combinedBarrierPoleRear` on `nhtsa_get_vehicle_safety`'s `sideCrash` — now at parity with `nhtsa_get_safety_ratings` ([#3](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/3))

### Fixed

- `nhtsa_get_vehicle_safety` now marks `sectionStatus.safetyRatings` as `unavailable` (with a coverage-gap warning) when NCAP returns no variants for the vehicle, instead of reporting `available` alongside an empty array ([#2](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/2))
- `nhtsa_search_complaints` no longer passes Unix-epoch `dateOfIncident` values (`12/31/1969`) through to consumers — any pre-1990 date is dropped as missing data ([#5](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/5))

### Changed

- Bumped `@cyanheads/mcp-ts-core` to `^0.3.8` and `typescript` to `^6.0.3`
- Removed stale transitive-dependency overrides (`hono`, `@hono/node-server`, `vite`, `picomatch`, etc.) — upstream has caught up and the audit remains clean without them
- Refreshed `add-tool` (v1.4) and `design-mcp-server` (v2.3) skills from the framework

### Won't Fix

- [#6](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/6) — adding `subject`/`potentialUnitsAffected` to `nhtsa_search_recalls` vehicle lookups. NHTSA's API doesn't expose `subject` on either per-vehicle or per-campaign endpoints; the binary-searched base endpoint would cost ~15 requests per recall. `potentialUnitsAffected` alone wasn't worth the extra network call.

## [0.5.0] - 2026-04-15

### Added

- `nhtsa_get_vehicle_safety` now returns `sectionStatus` so clients can distinguish unavailable NCAP, recall, or complaint sections from genuine zero-result responses
- `nhtsa_lookup_vehicles` now supports `limit` and `offset` pagination for the `makes` operation

### Changed

- `nhtsa_get_safety_ratings` now accepts either a direct `vehicleId` or the `make` + `model` + `modelYear` lookup path with explicit validation when inputs are incomplete
- `nhtsa_decode_vin`, `nhtsa_get_vehicle_safety`, and VPIC manufacturer lookups now preserve sparse upstream fields instead of fabricating empty-string placeholders
- Bumped `@cyanheads/mcp-ts-core` to `^0.3.5`, `@biomejs/biome` to `^2.4.12`, `@types/node` to `^25.6.0`, and `vitest` to `^4.1.4`
- Added the `add-app-tool` skill and refreshed scaffold skills to match the current `createApp()` registration pattern and repo test layout
- Refreshed release metadata and badges for the `0.5.0` release

### Fixed

- NHTSA service retries now cover network failures and invalid JSON bodies from otherwise successful upstream responses
- `nhtsa_get_vehicle_safety` now reports unavailable sections without implying that no recalls or ratings exist
- `nhtsa_decode_vin` now formats sparse decode results without blank summary or warning lines

## [0.4.1] - 2026-04-08

### Fixed

- `nhtsa_search_recalls` and `nhtsa_get_vehicle_safety` now accept recall records when NHTSA omits `parkIt`, `parkOutSide`, or `overTheAirUpdate`, resolving [issue #1](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/issues/1)
- `nhtsa_search_complaints`, `nhtsa_get_safety_ratings`, `nhtsa_search_investigations`, and `nhtsa_get_vehicle_safety` now preserve sparse upstream NHTSA fields instead of fabricating default values in tool outputs

### Changed

- Bumped `@cyanheads/mcp-ts-core` to `^0.3.2` and `vitest` to `^4.1.3`
- Pinned patched transitive versions for `@hono/node-server`, `hono`, and `vite` to clear `bun audit` warnings
- Added regression coverage for sparse recall, complaint, safety-rating, and investigation payloads
- Updated package metadata and badges for the `0.4.1` release

## [0.4.0] - 2026-04-04

### Added

- `nhtsa_get_vehicle_safety` — `warnings` array in output surfaces partial failures (e.g. when recalls or complaints API is unreachable) instead of silently returning empty sections

### Changed

- `nhtsa_get_vehicle_safety` — improved "no ratings" message with actionable guidance (suggests `nhtsa_get_safety_ratings` for specific variants or adjacent years)
- `nhtsa_search_investigations` — clarified tool description: all filters are ANDed, make/model are free-text searches against subject/description (not structured fields)

### Removed

- Unused `NhtsaProductsResponse` type from `services/nhtsa/types.ts`

## [0.3.2] - 2026-04-04

### Added

- Public hosted server at `https://nhtsa.caseyjhand.com/mcp` — added to README and `server.json` remotes

## [0.3.1] - 2026-04-03

### Fixed

- `nhtsa_get_vehicle_safety` — per-variant `getSafetyRating` failures are now caught and logged as warnings; other variants are still returned instead of failing the entire request
- `nhtsa_lookup_vehicles` — `count` in makes response now reflects the sliced length (≤200) rather than the full API total; truncation warning condition corrected to match
- `nhtsa_search_recalls` — added `NaN` validation for `dateRange` dates with a descriptive error message directing users to ISO 8601 format

### Changed

- `nhtsa_get_vehicle_safety` — corrected rollover `probability` description from "percentage" to "(0-1 scale)"

## [0.3.0] - 2026-04-03

### Changed

- Extracted shared `buildComponentBreakdown` into `services/nhtsa/types.ts`, removing duplicate implementations from `get-vehicle-safety` and `search-complaints` tools
- Added warning-level logging when parallel API fetches fail in `nhtsa_get_vehicle_safety`
- Standardized all package.json scripts to use `bun run` prefix; production start now uses `bun` instead of `node`
- Upgraded TypeScript from ^5.9.3 to ^6.0.2
- Updated Bun engine requirement from >=1.2.0 to >=1.3.2
- README: added npx and Docker installation methods, reorganized sections, added Bun version badge
- Added author details, funding links, and security dependency overrides to package.json

## [0.2.3] - 2026-04-03

### Fixed

- Replaced non-null assertions with safe defaults in `normalizeDate` date parsing

### Changed

- Rewrote README with expanded per-tool descriptions, Features, Getting Started, Docker, Project Structure, and Contributing sections
- Updated CLAUDE.md agent protocol: removed unused `ctx.elicit`/`ctx.sample` from context table, added `lint:mcp` command
- Fixed package.json repository URL to `git+https` format
- Added `mcpName` field for MCP registry identification
- Added Bun engine requirement (`>=1.2.0`) to package.json
- Switched server.json `runtimeHint` from `node` to `bun`

## [0.2.2] - 2026-04-03

### Changed

- Scoped npm package to `@cyanheads/nhtsa-vehicle-safety-mcp-server`
- Updated server.json registry name to `io.github.cyanheads/nhtsa-vehicle-safety-mcp-server`
- Expanded package.json metadata (keywords, author, homepage, bugs, packageManager)
- Updated Dockerfile OCI labels with description and source URL

### Added

- Apache 2.0 LICENSE file
- `bunfig.toml` for Bun runtime configuration
- `docs/tree.md` directory structure reference

### Fixed

- Formatted test fixture for readability (sideCrash object in get-vehicle-safety test)

## [0.2.1] - 2026-04-03

### Changed

- `nhtsa_decode_vin` — filter empty VINs before processing, validate at least one non-empty VIN
- `nhtsa_get_vehicle_safety` — added side crash ratings (overall, driver, passenger, barrier, pole) to output and format
- `nhtsa_lookup_vehicles` — capped makes response to 200 entries to reduce payload size
- `nhtsa_search_complaints` — added complaint filing date and VIN to formatted output
- `nhtsa_search_recalls` — throw `notFound` for missing campaign instead of empty result; improved validation message

### Fixed

- Engine displacement rounding in VIN decoder (now 1 decimal place)

### Tests

- Updated test fixtures for side crash ratings and recall not-found error behavior

## [0.2.0] - 2026-04-03

### Added

- **7 MCP tools** for querying NHTSA vehicle safety data:
  - `nhtsa_get_vehicle_safety` — composite safety profile (ratings + recalls + complaints)
  - `nhtsa_search_recalls` — recall campaigns by vehicle or campaign number, with date filtering
  - `nhtsa_search_complaints` — consumer complaints with component breakdown
  - `nhtsa_get_safety_ratings` — NCAP crash test ratings and ADAS features
  - `nhtsa_decode_vin` — single and batch VIN decoding (up to 50)
  - `nhtsa_search_investigations` — defect investigations with cached index
  - `nhtsa_lookup_vehicles` — VPIC reference lookups (makes, models, types, manufacturers)
- **NHTSA service layer** (`NhtsaService`) wrapping five public APIs with retry logic, field normalization, and investigation caching
- **Domain types** for all API responses and normalized models
- **Test suites** for all 7 tools using `createMockContext` from `@cyanheads/mcp-ts-core/testing`
- Vitest configuration with fork isolation and Zod SSR compatibility

## [0.1.0] - 2026-04-03

### Added

- Initial project scaffold from `@cyanheads/mcp-ts-core`
- Project structure, build scripts, and configuration
