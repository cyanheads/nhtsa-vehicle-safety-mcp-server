# NHTSA Vehicle Safety MCP Server

[![Version](https://img.shields.io/badge/version-0.2.1-blue.svg)](https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

An MCP server providing access to NHTSA (National Highway Traffic Safety Administration) vehicle safety data — recalls, consumer complaints, NCAP crash test ratings, defect investigations, and VIN decoding.

## Tools (7)

| Tool | Description |
|:-----|:------------|
| `nhtsa_get_vehicle_safety` | Composite safety profile combining crash test ratings, recalls, and complaint summary |
| `nhtsa_search_recalls` | Search recall campaigns by vehicle or campaign number with optional date filtering |
| `nhtsa_search_complaints` | Consumer safety complaints with component breakdown and severity stats |
| `nhtsa_get_safety_ratings` | NCAP crash test ratings and ADAS feature availability |
| `nhtsa_decode_vin` | Decode VINs for make, model, year, engine, safety equipment (single or batch up to 50) |
| `nhtsa_search_investigations` | Search NHTSA defect investigations (PE, EA, DP, RQ) with cached index |
| `nhtsa_lookup_vehicles` | Look up valid makes, models, vehicle types, and manufacturer details from VPIC |

## Quick Start

### Claude Desktop / Claude Code

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "nhtsa-vehicle-safety": {
      "command": "npx",
      "args": ["-y", "@cyanheads/nhtsa-vehicle-safety-mcp-server", "run", "start:stdio"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server.git
cd nhtsa-vehicle-safety-mcp-server
bun install
bun run build
bun run start:stdio
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` | HTTP server host | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `info` |

## Data Sources

All data comes from NHTSA's public APIs — no API key required:

- **Recalls API** — `api.nhtsa.gov/recalls`
- **Complaints API** — `api.nhtsa.gov/complaints`
- **Safety Ratings API** — `api.nhtsa.gov/SafetyRatings`
- **Investigations API** — `api.nhtsa.gov/investigations`
- **VPIC API** — `vpic.nhtsa.dot.gov/api/vehicles`

## Development

```bash
bun run dev:stdio     # Dev mode with hot reload
bun run test          # Run tests
bun run devcheck      # Lint + format + typecheck
```

## License

[Apache-2.0](LICENSE)
