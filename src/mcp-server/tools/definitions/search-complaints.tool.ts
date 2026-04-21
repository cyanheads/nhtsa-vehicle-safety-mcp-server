/**
 * @fileoverview Search consumer safety complaints by vehicle. Summarizes by component
 * and returns the most recent complaints.
 * @module mcp-server/tools/definitions/search-complaints.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { buildComponentBreakdown } from '@/services/nhtsa/types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function formatText(value?: string): string {
  return value || 'Not available';
}

export const searchComplaints = tool('nhtsa_search_complaints', {
  description:
    'Search consumer safety complaints filed with NHTSA for a specific vehicle. Returns a component breakdown over all matching complaints plus a paginated slice of the most recent complaints. Use for common problems, failure patterns, or owner-reported issues.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z.string().describe('Vehicle manufacturer.'),
    model: z.string().describe('Vehicle model.'),
    modelYear: z.number().describe('Model year.'),
    component: z
      .string()
      .optional()
      .describe(
        'Filter to a specific component (uppercase, e.g., "ENGINE", "AIR BAGS", "ELECTRICAL SYSTEM"). Matches within comma-separated component lists. Omit to see all.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max complaint narratives to return. Defaults to ${DEFAULT_LIMIT}; max ${MAX_LIMIT}. componentBreakdown always reflects all matching complaints.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Pagination offset into the date-descending complaint list. Defaults to 0. componentBreakdown is unaffected by pagination.',
      ),
  }),
  output: z.object({
    totalCount: z.number().describe('Total complaints matching criteria'),
    returned: z.number().describe('Number of complaints in this page'),
    offset: z.number().describe('Pagination offset used for this page'),
    limit: z.number().describe('Pagination limit used for this page'),
    componentBreakdown: z
      .array(
        z.object({
          component: z.string().describe('Component name'),
          count: z.number().describe('Number of complaints'),
          crashCount: z.number().describe('Complaints involving crashes'),
          fireCount: z.number().describe('Complaints involving fires'),
          injuryCount: z.number().describe('Total injuries reported'),
          deathCount: z.number().describe('Total deaths reported'),
        }),
      )
      .describe('Complaints grouped by component, sorted by frequency'),
    complaints: z
      .array(
        z.object({
          odiNumber: z.number().optional().describe('NHTSA complaint ID'),
          dateOfIncident: z.string().optional().describe('Date the incident occurred'),
          dateComplaintFiled: z.string().optional().describe('Date complaint was filed'),
          components: z.string().optional().describe('Affected components (comma-separated)'),
          summary: z.string().optional().describe('Consumer-reported description'),
          crash: z.boolean().optional().describe('Involved a crash'),
          fire: z.boolean().optional().describe('Involved a fire'),
          numberOfInjuries: z.number().optional().describe('Number of injuries'),
          numberOfDeaths: z.number().optional().describe('Number of deaths'),
          vin: z.string().optional().describe('VIN prefix (partial)'),
        }),
      )
      .describe('Paginated slice of the most recent complaints, date-descending'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    let complaints = await svc.getComplaintsByVehicle(
      input.make,
      input.model,
      input.modelYear,
      ctx.signal,
    );

    if (input.component) {
      const filter = input.component.toUpperCase();
      complaints = complaints.filter((c) =>
        (c.components ?? '').split(',').some((comp) => comp.trim().toUpperCase().includes(filter)),
      );
    }

    const breakdown = buildComponentBreakdown(complaints);

    const sorted = [...complaints].sort(
      (a, b) =>
        new Date(b.dateComplaintFiled ?? 0).getTime() -
        new Date(a.dateComplaintFiled ?? 0).getTime(),
    );
    const page = sorted.slice(offset, offset + limit);

    ctx.log.info('Complaint search', {
      make: input.make,
      model: input.model,
      modelYear: input.modelYear,
      component: input.component,
      total: complaints.length,
      returned: page.length,
      offset,
      limit,
    });

    return {
      totalCount: complaints.length,
      returned: page.length,
      offset,
      limit,
      componentBreakdown: breakdown,
      complaints: page,
    };
  },

  format: (result) => {
    if (result.totalCount === 0) {
      return [
        {
          type: 'text' as const,
          text: 'No complaints found for this vehicle. This may mean no complaints have been filed, or the make/model/year may not match NHTSA records. Use nhtsa_lookup_vehicles to verify.',
        },
      ];
    }

    const lines = [`**${result.totalCount} complaint(s)**\n`];

    // Component breakdown
    lines.push('## Component Breakdown\n');
    for (const b of result.componentBreakdown) {
      const flags = [
        b.crashCount > 0 ? `${b.crashCount} crashes` : '',
        b.fireCount > 0 ? `${b.fireCount} fires` : '',
        b.injuryCount > 0 ? `${b.injuryCount} injuries` : '',
        b.deathCount > 0 ? `${b.deathCount} deaths` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- **${b.component}:** ${b.count} complaints${flags ? ` (${flags})` : ''}`);
    }

    lines.push(
      `\n## Recent Complaints (returned ${result.returned} of ${result.totalCount}, offset ${result.offset}, limit ${result.limit}, date-descending)\n`,
    );
    if (result.offset + result.returned < result.totalCount) {
      lines.push(`*Use offset=${result.offset + result.returned} to retrieve the next page.*\n`);
    }
    for (const c of result.complaints) {
      const flags: string[] = [];
      if (c.crash) flags.push('CRASH');
      if (c.fire) flags.push('FIRE');
      if ((c.numberOfInjuries ?? 0) > 0) flags.push(`${c.numberOfInjuries} injuries`);
      if ((c.numberOfDeaths ?? 0) > 0) flags.push(`${c.numberOfDeaths} deaths`);
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

      lines.push(
        `**#${c.odiNumber ?? 'Unknown'}** — ${formatText(c.dateOfIncident)} (filed ${formatText(c.dateComplaintFiled)})${flagStr}`,
      );
      if (c.vin) lines.push(`VIN: ${c.vin}`);
      lines.push(`Components: ${formatText(c.components)}`);
      lines.push(`${formatText(c.summary)}\n`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
