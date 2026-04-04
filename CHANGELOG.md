# Changelog

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
