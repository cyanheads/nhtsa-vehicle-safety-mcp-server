<div align="center">
  <h1>@cyanheads/nhtsa-vehicle-safety-mcp-server</h1>
  <p><b>Decode VINs, search recalls, complaints, crash ratings, and investigations via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/nhtsa-vehicle-safety-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/nhtsa-vehicle-safety-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nhtsa-vehicle-safety-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server/releases/latest/download/nhtsa-vehicle-safety-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=nhtsa-vehicle-safety-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbmh0c2EtdmVoaWNsZS1zYWZldHktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22nhtsa-vehicle-safety-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnhtsa-vehicle-safety-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://nhtsa.caseyjhand.com/mcp](https://nhtsa.caseyjhand.com/mcp)

</div>

---

## Overview

Vehicle safety data from NHTSA: recalls, consumer complaints, NCAP crash ratings, defect investigations, and VIN decoding. Get a full safety picture for any make, model, and year in one call, or decode a VIN.

### Tools

| Tool | Description |
|:---|:---|
| `nhtsa_get_vehicle_safety` | Comprehensive safety profile combining crash test ratings, recalls, and complaint summary with per-section availability status. |
| `nhtsa_search_recalls` | Search recall campaigns by campaign number, by vehicle, or across all campaigns by make, model, model year, and received date. |
| `nhtsa_search_complaints` | Consumer safety complaints with component breakdown and severity stats. |
| `nhtsa_get_safety_ratings` | NCAP crash test ratings and ADAS feature availability. |
| `nhtsa_decode_vin` | Decode VINs for make, model, year, engine, safety equipment, and driver-assistance features (50 decoded per call). |
| `nhtsa_search_investigations` | Search NHTSA defect investigations (PE, EA, DP, RQ, AQ, and more), newest opened first. |
| `nhtsa_lookup_vehicles` | Look up makes, models, vehicle types, and manufacturer details from VPIC, and the model names NHTSA's datasets file a vehicle under. |

## Capability reference

### `nhtsa_get_vehicle_safety` <sub>tool</sub>

- Combines NCAP crash test ratings, recall history, and complaint summary in a single response
- Frontal crash, side crash, and rollover ratings per vehicle variant
- Recall consequence text plus the do-not-drive, park-outside, and over-the-air-update advisories; `summary`, `consequence`, and `remedy` are omitted for older campaigns whose record leaves them blank
- Complaint breakdown by component with crash, fire, injury, and death counts
- Returns `sectionStatus` (available/partial/unavailable per section) plus `warnings` so a partial NHTSA outage is not mistaken for a clean record
- When recalls or complaints come back empty, a `notice` points at `nhtsa_lookup_vehicles` with `operation="dataset_models"`, because NHTSA can file one vehicle under different model names in each dataset

---

### `nhtsa_search_recalls` <sub>tool</sub>

- Three modes: `campaignNumber`; `make` + `model` + `modelYear` together; or a broad search with any other combination of `make`, `model`, `modelYear`, and `dateRange`. `campaignNumber` is mutually exclusive with the vehicle fields
- Campaign lookups return every make/model the campaign covers, plus the ODI investigation that preceded it; a 6-character number (e.g., `00V419`) returns every campaign it covers
- Broad search returns campaigns newest received date first with an exact `totalCount`, up to 50 per page (default 20) with `limit` and `offset`, and a larger `limit` is lowered to 50 with a `notice`; both are rejected with the other two modes. A campaign matches when one of its vehicle records carries every vehicle filter, compared against whole make and model names, ignoring case
- NHTSA may file a vehicle's recalls under a series name or a base name; search both. A broad search's received date can fall one day before the date the other modes report for the same campaign
- Optional inclusive `dateRange` bounds (`after`/`before`, calendar-valid `YYYY-MM-DD`) apply in every mode; blank bounds are unset
- Includes do-not-drive advisories, park-outside warnings, and OTA update availability (never set by a broad search)

---

### `nhtsa_search_complaints` <sub>tool</sub>

- Component breakdown covers every matching complaint regardless of pagination; up to 50 complaint narratives per page (default 20), offset pagination, sorted by filing date descending. A larger `limit` is lowered to 50 with a `notice` naming the next `offset` (see `NHTSA_CLAMP_LIMITS`)
- Optional `component` filter matches case-insensitively within each component name a complaint lists (e.g., "ENGINE", "AIR BAGS"); component names can themselves contain ", " (e.g., "SERVICE BRAKES, HYDRAULIC")
- Every component line includes crash, fire, injury, and death totals, including zeros; individual complaints preserve fields NHTSA actually reported
- An incident date NHTSA reported that the complaint's own filing date or model year rules out is disclosed as `unreliableIncidentDate` rather than served as the incident date

---

### `nhtsa_get_safety_ratings` <sub>tool</sub>

- Accepts either make + model + modelYear, or a follow-up `vehicleId` from an earlier result; combining the modes is rejected
- Frontal crash, side crash (barrier + pole), and rollover ratings, plus ESC/forward-collision/lane-departure ADAS availability
- Per-record complaint, recall, and investigation counts are variant-scoped — not vehicle-level totals
- NCAP coverage starts at 1990, most complete for 2011+ model years

---

### `nhtsa_decode_vin` <sub>tool</sub>

- One VIN, or several in an array or in one string separated by spaces, semicolons, or commas; partial VINs accepted using `*` for unknown positions, each as its own entry
- A call decodes up to 50 VINs and accepts up to 500; the rest come back in `deferredVins` to pass back as `vin`. `VIN,YYYY` gives one VIN its own model year; optional `modelYear` covers the others
- A blank entry, a character other than a letter, digit, or `*`, or a VIN over 17 characters is rejected before decoding (`empty_vin_list`, `invalid_vin`)
- Safety equipment includes VPIC's driver-assistance features (automatic emergency braking, lane keeping, blind spot warning, backup camera, adaptive cruise control, and others); `Optional` means the configuration offers the feature, not that this vehicle has it
- Preserves sparse VPIC fields instead of filling missing data with placeholders; every result carries VPIC's own `errorCode`/`errorText` decode-quality signal, including the clean "0" case

---

### `nhtsa_search_investigations` <sub>tool</sub>

- Investigation types: Preliminary Evaluations (PE), Engineering Analyses (EA), Defect Petitions (DP), Recall Queries (RQ), Audit Queries (AQ), and additional ODI codes (SQ, EQ, RP, and others)
- Free-text search across investigation IDs, subjects, and summaries, plus structured `make`, `model`, `modelYear`, and `component` filters — all ANDed. `make`, `model`, and `modelYear` must all match the same vehicle association; an investigation with no model year never matches a `modelYear`
- Results are ordered newest-opened first. Rows list every linked `manufacturers` and `recallCampaigns` entry
- Search rows omit `summary`; set `includeSummary: true` to include it, or fetch one record with `nhtsaId`, which always returns it
- Inclusive `openDateRange` and `closeDateRange` bounds (`after`/`before`, calendar-valid `YYYY-MM-DD`) filter before counting and pagination; active bounds exclude records without the corresponding usable date
- `nhtsaId` fetches one investigation by its exact ID, mutually exclusive with the other filters — the reverse of the recall link, closing the campaign-to-investigation round trip
- Sourced from NHTSA's ODI bulk file (`FLAT_INV.zip`), loaded on first use and cached for 24 hours
- Up to 50 investigations per page (default 20), offset pagination; a larger `limit` is lowered to 50 with a `notice`

---

### `nhtsa_lookup_vehicles` <sub>tool</sub>

- Five operations: `makes`, `models`, `vehicle_types`, `manufacturer`, `dataset_models` — `models`, `vehicle_types`, and `manufacturer` match partial names
- `dataset_models` (requires `make` and `modelYear`) lists the model names NHTSA's complaint, NCAP, and VPIC lists carry, each tagged `listedBy` `products`, `ncap`, or `vpic`. It takes the full make name (e.g., "Chevrolet"). Use it when a recall, complaint, or rating search comes back empty, then search under each name
- `models` can be filtered by year; `models` and `vehicle_types` both require `make`
- Each operation rejects inactive filters: `makes` accepts none, `models` and `dataset_models` accept `make`/`modelYear`, `vehicle_types` accepts `make`, and `manufacturer` accepts `manufacturer`. Optional blank strings are unset; operation-required make/manufacturer names must be nonblank
- Up to 200 results per page (default 100), offset pagination; a larger `limit` is lowered to 200 with a `notice`
- `manufacturer` lookups stop at a 500-record ceiling and disclose `truncated` when more may exist — VPIC publishes no match total

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NHTSA-specific:

- Type-safe client wrapping four NHTSA JSON APIs with retry logic and sparse-field normalization, plus a streaming parser for NHTSA's investigation and recall bulk files
- Investigation and recall indexes cached for 24 hours; the bulk files load one at a time, and each load (waiting its turn, downloading, and parsing; both recall files count as one load) must finish within 120 s
- Published `nhtsa-vehicle-safety-guide` skill (`skill://nhtsa-vehicle-safety-guide/SKILL.md`) with the identifier chains and gates for merging results across model names, make versus manufacturer, model year versus received date, and what an empty or Not Rated result proves
- No API key required — all NHTSA APIs are public

Agent-friendly output:

- Provenance: every tool echoes `effectiveQuery` in its enrichment block, so callers can verify exactly what was searched
- Graceful partial failure: `nhtsa_get_vehicle_safety` returns `sectionStatus` per section plus `warnings`, so a partial NHTSA outage isn't mistaken for a clean safety record
- Discriminated outputs: `unreliableIncidentDate` (complaints), VIN decode `errorCode`/`errorText`, and manufacturer-lookup `truncated` disclose data-quality limits rather than silently omitting or fabricating values

## Getting started

### Public Hosted Instance

A public instance is available at `https://nhtsa.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety-mcp-server": {
      "type": "streamable-http",
      "url": "https://nhtsa.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/nhtsa-vehicle-safety-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/nhtsa-vehicle-safety-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/nhtsa-vehicle-safety-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js >= 24.0.0)

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd nhtsa-vehicle-safety-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override transport, auth, or storage defaults — no API key required
```

## Configuration

No API keys required — all NHTSA APIs are public.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless`. The server declares `stateless` in code — it keeps no per-session state — and this variable overrides that. | `stateless` |
| `NHTSA_CLAMP_LIMITS` | Lower an over-maximum `limit` to its maximum, and decode the first 50 VINs of a larger `nhtsa_decode_vin` batch with the rest returned in `deferredVins`, disclosing either in a `notice`. `false` rejects the request instead (`limit_too_large`, `batch_too_large`). An invalid value fails startup. | `true` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t nhtsa-vehicle-safety-mcp-server .
docker run --rm -p 3010:3010 nhtsa-vehicle-safety-mcp-server
```

The Dockerfile defaults to HTTP transport and logs to `/var/log/nhtsa-vehicle-safety-mcp-server`; it restates the stateless session mode the server already declares. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the NHTSA service. |
| `src/config/` | Server configuration parsed from the environment (`NHTSA_CLAMP_LIMITS`). |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/tools/request-cap.ts` | Page-size and VIN-batch caps shared by the tools. |
| `src/services/nhtsa/` | NHTSA API client, bulk-file loader, investigation and recall indexes, and field normalization. |
| `skills/` | Published `nhtsa-vehicle-safety-guide` skill, served over MCP and shipped in the npm package and Docker image. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- One tool per file, `nhtsa_` prefix for every tool name, registered in `createApp()`
- Validate raw NHTSA responses → normalize to domain types → return the output schema; never fabricate a field NHTSA didn't provide

## Data sources

All data comes from NHTSA's public APIs and bulk files:

- **Recalls API** — `api.nhtsa.gov/recalls`
- **Complaints API** — `api.nhtsa.gov/complaints`; `dataset_models` also reads its model-name list at `api.nhtsa.gov/products/vehicle/models`
- **Safety Ratings API** — `api.nhtsa.gov/SafetyRatings`
- **Investigations bulk file** — `static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip`
- **Recall bulk files** — `static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip` and `FLAT_RCL_PRE_2010.zip`, used by broad `nhtsa_search_recalls` searches
- **VPIC API** — `vpic.nhtsa.dot.gov/api/vehicles`

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
