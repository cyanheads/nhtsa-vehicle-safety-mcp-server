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

await createApp({
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
  setup() {
    initNhtsaService();
  },
});
