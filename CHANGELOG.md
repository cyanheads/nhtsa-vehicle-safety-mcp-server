# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.9.5](changelog/0.9.x/0.9.5.md) — 2026-08-21

MCP SDK 2.0 framework adoption and Bun 1.4 maintenance

## [0.9.4](changelog/0.9.x/0.9.4.md) — 2026-07-30

nhtsa_search_complaints flags an incident date its own record contradicts instead of rendering it as fact; nhtsa_lookup_vehicles stops showing a spelling hint for an out-of-range page

## [0.9.3](changelog/0.9.x/0.9.3.md) — 2026-07-30

Recall/complaint output states false, zero, and clean values instead of dropping them; fractional model years rejected at the schema; out-of-range pagination offsets get an explanatory notice; complaint incident dates match NHTSA's actual placeholders

## [0.9.2](changelog/0.9.x/0.9.2.md) — 2026-07-30

nhtsa_search_recalls: full affected-vehicle list and investigation linkage; nhtsa_search_investigations: exact-ID lookup; nhtsa_lookup_vehicles: manufacturer pagination fix; complaint dates normalize to ISO

## [0.9.1](changelog/0.9.x/0.9.1.md) — 2026-07-30

nhtsa_get_vehicle_safety: full recall detail, untruncated component breakdown, correct rollover-probability and no-match handling

## [0.9.0](changelog/0.9.x/0.9.0.md) — 2026-07-30 · ⚠️ Breaking

Breaking: nhtsa_search_investigations status is now an O/C enum; bounded limit/offset, echoed pagination, untruncated summaries; mcp-ts-core ^0.11.0 maintenance

## [0.8.4](changelog/0.8.x/0.8.4.md) — 2026-06-20

@cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9 maintenance — fresh-scaffold devcheck guards, check-dependency-specifiers gate, plugin-manifest packaging checks, synced framework scripts and skills

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-06-12

@cyanheads/mcp-ts-core ^0.9.21 → ^0.10.6; explicit createApp identity; MCPB bundle cleaner (clean-mcpb.ts) + post-bundle agent-doc content check; Dockerfile APP_VERSION label + HEALTHCHECK; z.coerce.boolean() antipattern rule; synced skills

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21; per-request log context fix, fetchWithTimeout secret redaction, withRetry fail-fast; release:github script; 8 skill updates + orchestrations + api-mirror

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-05-31

ODI flat file UTF-8 decode fix, 1-letter investigation type prefixes, AQ type map entry, opened investigationType filter docs

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-05-30

Direct campaign endpoint, investigations flat file, HTTP 400 empty-result handling, VIN empty success, decode-vin enrichment

## [0.7.6](changelog/0.7.x/0.7.6.md) — 2026-05-30

enrichment adoption — recalls, complaints, investigations, and lookup tools surface query echoes and empty-result guidance via ctx.enrich; output.message removed from structured output

## [0.7.5](changelog/0.7.x/0.7.5.md) — 2026-05-28

mcp-ts-core ^0.9.6 → ^0.9.13; HTTP 413 body cap, session-init gate, quieter 401/403/400/404 logs, GET /mcp keywords; biome ^2.4.16

## [0.7.4](changelog/0.7.x/0.7.4.md) — 2026-05-23

mcp-ts-core ^0.9.6; manifest.json for MCPB bundle; lint:packaging + list-skills scripts; README install badges

## [0.7.3](changelog/0.7.x/0.7.3.md) — 2026-05-16

mcp-ts-core ^0.9.1; server instructions on createApp(); Zod-serialization checklist; devcheck parser hardening

## [0.7.2](changelog/0.7.x/0.7.2.md) — 2026-05-08

mcp-ts-core ^0.8.19; typed errors[] + ctx.fail on 4 tools; httpErrorFromResponse; pluralize helper; Node >=24

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-04-24

mcp-ts-core ^0.7.0; recursive describe-on-fields linter adoption; security-pass skill; changelog scripts

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-04-23 · ⚠️ Breaking

Breaking: search_investigations total→totalCount, lookup_vehicles output reshape + full pagination; mcp-ts-core ^0.6.12, landing page

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-04-20

ctx.signal propagation, investigation statusName, lookup IDs in format(), mcp-ts-core ^0.5.3

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-04-19

search_complaints pagination, empty-result message fields, combinedBarrierPole parity, sectionStatus unavailable fix

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-04-15

nhtsa_get_vehicle_safety sectionStatus, lookup pagination, sparse field preservation; mcp-ts-core ^0.3.5

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-08

Sparse NHTSA field handling for parkIt/parkOutSide/overTheAirUpdate; mcp-ts-core ^0.3.2; regression tests

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-04

nhtsa_get_vehicle_safety warnings array, improved no-ratings message, investigations description clarified

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-04-04

Public hosted server at nhtsa.caseyjhand.com/mcp

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-04-03

nhtsa_get_vehicle_safety per-variant failure handling, lookup count fix, recall dateRange NaN validation

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-03

buildComponentBreakdown extraction, bun run scripts, TypeScript ^6.0.2, Bun >=1.3.2

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-04-03

Safe defaults in normalizeDate, README rewrite, package.json fixes

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-04-03

Scoped npm package, server.json registry name, package metadata, LICENSE, bunfig.toml, docs/tree.md

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-04-03

VIN decode empty-filter, side crash ratings, lookup cap, complaint date/VIN, recall campaign validation

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-03

7 MCP tools for NHTSA vehicle safety data — recalls, complaints, crash ratings, VIN decode, investigations, vehicle lookup

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-04-03

Initial project scaffold
