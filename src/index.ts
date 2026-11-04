#!/usr/bin/env node
/**
 * @fileoverview nhtsa-vehicle-safety-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
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
  skills: 'skills',
  instructions: `Use the nhtsa_* tools for U.S. vehicle safety data: recalls, complaints, NCAP crash ratings, defect investigations, and VIN decoding. nhtsa_get_vehicle_safety is the default for general 'is this car safe?' questions. NHTSA's datasets can file one vehicle under different model names (Silverado vs SILVERADO 1500): when a search comes back empty, list the names with nhtsa_lookup_vehicles operation="dataset_models" for the make and model year, then search under each. The nhtsa-vehicle-safety-guide skill (skill://nhtsa-vehicle-safety-guide/SKILL.md) carries the gates for merging results across model names, make versus manufacturer, model year versus received date, campaign number forms, and what an empty or Not Rated result proves.`,
  landing: {
    tagline:
      'Vehicle safety data from NHTSA — recalls, complaints, crash ratings, investigations, VIN decoding.',
    repoRoot: 'https://github.com/cyanheads/nhtsa-vehicle-safety-mcp-server',
    requireAuth: false,
  },
  setup() {
    // Parse server config at startup so an invalid value fails the boot, not the first call.
    getServerConfig();
    initNhtsaService();
  },
});
