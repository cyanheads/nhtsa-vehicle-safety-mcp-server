#!/usr/bin/env node
/**
 * @fileoverview nhtsa-vehicle-safety-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  decodeVin,
  getSafetyRatings,
  getVehicleSafety,
  lookupVehicles,
  searchComplaints,
  searchInvestigations,
  searchRecalls,
} from '@/mcp-server/tools/definitions/index.js';
import { initNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

/** Lifecycle handle for embedders and integration tests; running as a CLI ignores it. */
export const app = await createApp({
  name: 'nhtsa-vehicle-safety-mcp-server',
  title: 'nhtsa-vehicle-safety-mcp-server',
  /**
   * Every tool here is a read-only NHTSA query — no handler suspends on
   * `ctx.requestInput`, and nothing is kept per session. Declaring the posture in
   * code rather than leaving it to `MCP_SESSION_MODE` keeps a `bunx` or
   * from-source run on the same footing as the container and the hosted
   * deployment, which have run stateless all along.
   */
  sessionMode: 'stateless',
  tools: [
    getVehicleSafety,
    searchRecalls,
    searchComplaints,
    getSafetyRatings,
    decodeVin,
    searchInvestigations,
    lookupVehicles,
  ],
  resources: [],
  prompts: [],
  instructions:
    "Use the nhtsa_* tools for U.S. vehicle safety data: recalls, complaints, NCAP crash ratings, defect investigations, and VIN decoding. nhtsa_get_vehicle_safety is the default for general 'is this car safe?' questions; nhtsa_lookup_vehicles confirms make/model spelling first.",
  landing: {
    tagline:
      'Vehicle safety data from NHTSA — recalls, complaints, crash ratings, investigations, VIN decoding.',
    repoRoot: 'https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server',
    requireAuth: false,
  },
  setup() {
    initNhtsaService();
  },
});
