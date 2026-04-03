/**
 * @fileoverview Search recall campaigns by vehicle or campaign number.
 * Supports date-range filtering applied locally.
 * @module mcp-server/tools/definitions/search-recalls.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

export const searchRecalls = tool('nhtsa_search_recalls', {
  description:
    'Search recall campaigns by vehicle or campaign number. Use for specific recall lookups, recall history for a vehicle, or looking up a known campaign number.',
  annotations: { readOnlyHint: true },
  input: z.object({
    campaignNumber: z
      .string()
      .optional()
      .describe(
        'NHTSA campaign number (e.g., "20V682000"). When provided, returns campaign details. Other params ignored.',
      ),
    make: z
      .string()
      .optional()
      .describe(
        'Vehicle manufacturer. Required with model and modelYear when not using campaignNumber.',
      ),
    model: z.string().optional().describe('Vehicle model. Required with make and modelYear.'),
    modelYear: z.number().optional().describe('Model year. Required with make and model.'),
    dateRange: z
      .object({
        after: z
          .string()
          .optional()
          .describe('Only recalls received after this date (ISO 8601, e.g., "2025-01-01").'),
        before: z
          .string()
          .optional()
          .describe('Only recalls received before this date (ISO 8601, e.g., "2026-01-01").'),
      })
      .optional()
      .describe(
        'Filter recalls by received date. Applied locally since the API lacks native date filtering.',
      ),
  }),
  output: z.object({
    recalls: z
      .array(
        z.object({
          campaignNumber: z.string().describe('NHTSA campaign number'),
          manufacturer: z.string().describe('Vehicle/equipment manufacturer'),
          component: z.string().optional().describe('Affected component (vehicle-scoped queries)'),
          subject: z.string().optional().describe('Recall subject (campaign queries)'),
          summary: z.string().describe('Recall summary'),
          consequence: z.string().describe('Safety consequence'),
          remedy: z.string().describe('Corrective action'),
          reportReceivedDate: z.string().describe('Date received by NHTSA'),
          potentialUnitsAffected: z
            .number()
            .optional()
            .describe('Units affected (campaign queries)'),
          parkIt: z.boolean().describe('Do-not-drive advisory'),
          parkOutSide: z.boolean().describe('Park-outside advisory'),
          overTheAirUpdate: z.boolean().describe('OTA update available'),
        }),
      )
      .describe('Matching recall campaigns'),
    totalCount: z.number().describe('Total recalls matching criteria'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();

    if (input.campaignNumber && (input.make || input.model || input.modelYear)) {
      throw validationError('Provide either campaignNumber OR make/model/modelYear, not both.');
    }

    // Campaign number lookup
    if (input.campaignNumber) {
      const campaign = await svc.getRecallCampaign(input.campaignNumber);
      ctx.log.info('Campaign lookup', { campaignNumber: input.campaignNumber, found: !!campaign });

      if (!campaign) return { recalls: [], totalCount: 0 };

      return {
        recalls: [
          {
            campaignNumber: campaign.campaignNumber,
            manufacturer: campaign.manufacturer,
            subject: campaign.subject,
            summary: campaign.summary,
            consequence: campaign.consequence,
            remedy: campaign.remedy,
            reportReceivedDate: campaign.receivedDate,
            potentialUnitsAffected: campaign.potentialUnitsAffected,
            parkIt: campaign.parkIt,
            parkOutSide: campaign.parkOutSide,
            overTheAirUpdate: campaign.overTheAirUpdate,
          },
        ],
        totalCount: 1,
      };
    }

    // Vehicle-scoped lookup
    if (!input.make || !input.model || input.modelYear == null) {
      throw validationError(
        'make, model, and modelYear are all required for vehicle-scoped recall search.',
      );
    }

    let recalls = (await svc.getRecallsByVehicle(input.make, input.model, input.modelYear)).map(
      (r) => ({
        campaignNumber: r.campaignNumber,
        manufacturer: r.manufacturer,
        component: r.component,
        summary: r.summary,
        consequence: r.consequence,
        remedy: r.remedy,
        reportReceivedDate: r.reportReceivedDate,
        parkIt: r.parkIt,
        parkOutSide: r.parkOutSide,
        overTheAirUpdate: r.overTheAirUpdate,
      }),
    );

    // Apply date filtering locally
    if (input.dateRange?.after || input.dateRange?.before) {
      const after = input.dateRange.after ? new Date(input.dateRange.after).getTime() : 0;
      const before = input.dateRange.before ? new Date(input.dateRange.before).getTime() : Infinity;
      recalls = recalls.filter((r) => {
        const d = new Date(r.reportReceivedDate).getTime();
        return d >= after && d <= before;
      });
    }

    ctx.log.info('Vehicle recall search', {
      make: input.make,
      model: input.model,
      modelYear: input.modelYear,
      count: recalls.length,
    });

    return { recalls, totalCount: recalls.length };
  },

  format: (result) => {
    if (result.totalCount === 0) {
      return [
        {
          type: 'text' as const,
          text: 'No recalls found matching the search criteria. This vehicle may have no recalls on file, or the make/model/year may not match NHTSA records. Use nhtsa_lookup_vehicles to verify.',
        },
      ];
    }

    const lines = [`**${result.totalCount} recall(s) found**\n`];
    for (const r of result.recalls) {
      const alerts: string[] = [];
      if (r.parkIt) alerts.push('DO NOT DRIVE');
      if (r.parkOutSide) alerts.push('PARK OUTSIDE');
      if (r.overTheAirUpdate) alerts.push('OTA update available');
      const alertStr = alerts.length > 0 ? ` [${alerts.join(', ')}]` : '';

      lines.push(`### ${r.campaignNumber}${alertStr}`);
      if (r.component) lines.push(`**Component:** ${r.component}`);
      if (r.subject) lines.push(`**Subject:** ${r.subject}`);
      if (r.potentialUnitsAffected != null) {
        lines.push(`**Units Affected:** ${r.potentialUnitsAffected.toLocaleString()}`);
      }
      lines.push(`**Date:** ${r.reportReceivedDate}`);
      lines.push(`**Manufacturer:** ${r.manufacturer}`);
      lines.push(`\n${r.summary}`);
      lines.push(`\n**Consequence:** ${r.consequence}`);
      lines.push(`**Remedy:** ${r.remedy}\n`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
