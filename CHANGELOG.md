# Changelog

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
