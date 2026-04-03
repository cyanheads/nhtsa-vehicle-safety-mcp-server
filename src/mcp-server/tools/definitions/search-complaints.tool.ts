/**
 * @fileoverview Search consumer safety complaints by vehicle. Summarizes by component
 * and returns the most recent complaints.
 * @module mcp-server/tools/definitions/search-complaints.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Complaint, ComponentBreakdown } from '@/services/nhtsa/types.js';

const MAX_COMPLAINTS_RETURNED = 50;

function buildBreakdown(complaints: Complaint[]): ComponentBreakdown[] {
  const map = new Map<string, ComponentBreakdown>();
  for (const c of complaints) {
    for (const component of c.components
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const entry = map.get(component) ?? {
        component,
        count: 0,
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      };
      entry.count++;
      if (c.crash) entry.crashCount++;
      if (c.fire) entry.fireCount++;
      entry.injuryCount += c.numberOfInjuries;
      entry.deathCount += c.numberOfDeaths;
      map.set(component, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export const searchComplaints = tool('nhtsa_search_complaints', {
  description:
    'Search consumer safety complaints filed with NHTSA for a specific vehicle. Returns a component breakdown and the most recent complaints. Use for common problems, failure patterns, or owner-reported issues.',
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
  }),
  output: z.object({
    totalCount: z.number().describe('Total complaints matching criteria'),
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
          odiNumber: z.number().describe('NHTSA complaint ID'),
          dateOfIncident: z.string().describe('Date the incident occurred'),
          dateComplaintFiled: z.string().describe('Date complaint was filed'),
          components: z.string().describe('Affected components (comma-separated)'),
          summary: z.string().describe('Consumer-reported description'),
          crash: z.boolean().describe('Involved a crash'),
          fire: z.boolean().describe('Involved a fire'),
          numberOfInjuries: z.number().describe('Number of injuries'),
          numberOfDeaths: z.number().describe('Number of deaths'),
          vin: z.string().describe('VIN prefix (partial)'),
        }),
      )
      .describe('Most recent complaints (up to 50)'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    let complaints = await svc.getComplaintsByVehicle(input.make, input.model, input.modelYear);

    // Filter by component (substring match within comma-separated list)
    if (input.component) {
      const filter = input.component.toUpperCase();
      complaints = complaints.filter((c) =>
        c.components.split(',').some((comp) => comp.trim().toUpperCase().includes(filter)),
      );
    }

    const breakdown = buildBreakdown(complaints);

    // Sort by date descending, return most recent
    const sorted = [...complaints].sort(
      (a, b) => new Date(b.dateComplaintFiled).getTime() - new Date(a.dateComplaintFiled).getTime(),
    );
    const recent = sorted.slice(0, MAX_COMPLAINTS_RETURNED);

    ctx.log.info('Complaint search', {
      make: input.make,
      model: input.model,
      modelYear: input.modelYear,
      component: input.component,
      total: complaints.length,
      returned: recent.length,
    });

    return {
      totalCount: complaints.length,
      componentBreakdown: breakdown,
      complaints: recent,
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

    // Recent complaints
    const shown = result.complaints.length;
    lines.push(`\n## Recent Complaints (${shown} of ${result.totalCount})\n`);
    for (const c of result.complaints) {
      const flags: string[] = [];
      if (c.crash) flags.push('CRASH');
      if (c.fire) flags.push('FIRE');
      if (c.numberOfInjuries > 0) flags.push(`${c.numberOfInjuries} injuries`);
      if (c.numberOfDeaths > 0) flags.push(`${c.numberOfDeaths} deaths`);
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

      lines.push(`**#${c.odiNumber}** — ${c.dateOfIncident}${flagStr}`);
      lines.push(`Components: ${c.components}`);
      lines.push(`${c.summary}\n`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
