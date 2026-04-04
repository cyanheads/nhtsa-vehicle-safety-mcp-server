<div align="center">
  <h1>@cyanheads/nhtsa-vehicle-safety-mcp-server</h1>
  <p><b>Vehicle safety data from NHTSA — recalls, complaints, crash ratings, investigations, VIN decoding.</b></p>
  <p><b>7 Tools</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/nhtsa-vehicle-safety-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nhtsa-vehicle-safety-mcp-server) [![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://nhtsa.caseyjhand.com/mcp](https://nhtsa.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools for querying NHTSA vehicle safety data:

| Tool Name | Description |
|:----------|:------------|
| `nhtsa_get_vehicle_safety` | Comprehensive safety profile combining crash test ratings, recalls, and complaint summary. |
| `nhtsa_search_recalls` | Search recall campaigns by vehicle or campaign number with optional date filtering. |
| `nhtsa_search_complaints` | Consumer safety complaints with component breakdown and severity stats. |
| `nhtsa_get_safety_ratings` | NCAP crash test ratings and ADAS feature availability. |
| `nhtsa_decode_vin` | Decode VINs for make, model, year, engine, safety equipment (single or batch up to 50). |
| `nhtsa_search_investigations` | Search NHTSA defect investigations (PE, EA, DP, RQ) with cached index. |
| `nhtsa_lookup_vehicles` | Look up valid makes, models, vehicle types, and manufacturer details from VPIC. |

### `nhtsa_get_vehicle_safety`

Composite safety profile — the default tool when asked about vehicle safety, reliability, or purchase decisions.

- Combines NCAP crash test ratings, recall history, and complaint summary in a single response
- Frontal crash, side crash, and rollover ratings per vehicle variant
- Complaint breakdown by component with crash, fire, injury, and death counts

---

### `nhtsa_search_recalls`

Search recall campaigns by vehicle or campaign number.

- Look up by make/model/year or by specific NHTSA campaign number
- Optional date range filtering (ISO 8601)
- Includes do-not-drive advisories, park-outside warnings, and OTA update availability

---

### `nhtsa_decode_vin`

Decode Vehicle Identification Numbers for manufacturing and safety details.

- Single VIN or batch decode up to 50 VINs
- Partial VINs accepted — use `*` for unknown positions
- Returns make, model, year, body type, engine specs, airbag locations, ESC, ABS, and traction control

---

### `nhtsa_search_investigations`

Search NHTSA defect investigations.

- Investigation types: Preliminary Evaluations, Engineering Analyses, Defect Petitions, Recall Queries
- Free-text search across subjects and descriptions
- First query loads the full investigation index (~10s); subsequent queries use a cached index (1h TTL)

---

### `nhtsa_search_complaints`

Search consumer safety complaints filed with NHTSA.

- Component breakdown with crash, fire, injury, and death counts
- Optional component filter (e.g., "ENGINE", "AIR BAGS")
- Returns up to 50 most recent complaints sorted by filing date

---

### `nhtsa_get_safety_ratings`

NCAP crash test ratings and ADAS feature data.

- Frontal crash, side crash (barrier + pole), and rollover ratings
- ADAS features: ESC, forward collision warning, lane departure warning
- Counts of complaints, recalls, and investigations on file

---

### `nhtsa_lookup_vehicles`

Reference lookups against NHTSA's VPIC database.

- Four operations: `makes`, `models`, `vehicle_types`, `manufacturer`
- Use to resolve ambiguous vehicle names or verify correct spelling
- Models can be filtered by year; manufacturers support partial match

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) from the same codebase

NHTSA-specific:

- Type-safe client wrapping five NHTSA public APIs with retry logic and field normalization
- Investigation index caching (1h TTL) for fast repeated queries
- No API key required — all NHTSA APIs are public

## Getting started

### Public Hosted Instance

A public instance is available at `https://nhtsa.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety": {
      "type": "streamable-http",
      "url": "https://nhtsa.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/nhtsa-vehicle-safety-mcp-server@latest"]
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/nhtsa-vehicle-safety-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety": {
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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js >= 22.0.0)

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

## Configuration

No API keys required — all NHTSA APIs are public.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

## Data sources

All data comes from NHTSA's public APIs:

- **Recalls API** — `api.nhtsa.gov/recalls`
- **Complaints API** — `api.nhtsa.gov/complaints`
- **Safety Ratings API** — `api.nhtsa.gov/SafetyRatings`
- **Investigations API** — `api.nhtsa.gov/investigations`
- **VPIC API** — `vpic.nhtsa.dot.gov/api/vehicles`

## Running the server

### Local development

```sh
bun run dev:stdio     # Dev mode with hot reload (stdio)
bun run dev:http      # Dev mode with hot reload (HTTP)
```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Production

```sh
bun run build
bun run start:stdio   # Production stdio
bun run start:http    # Production HTTP
```

### Docker

```sh
docker build -t nhtsa-vehicle-safety-mcp-server .
docker run -p 3010:3010 nhtsa-vehicle-safety-mcp-server
```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | Server entry point — `createApp()` registration. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/nhtsa/` | NHTSA API client with retry logic and field normalization. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging
- One tool per file, `nhtsa_` prefix for all tool names

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
