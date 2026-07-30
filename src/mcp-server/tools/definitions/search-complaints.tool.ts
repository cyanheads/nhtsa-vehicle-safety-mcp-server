/**
 * @fileoverview Search consumer safety complaints by vehicle. Summarizes by component
 * and returns the most recent complaints.
 * @module mcp-server/tools/definitions/search-complaints.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { outOfBoundsMessage, pluralize } from '@/services/nhtsa/format.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { UnreliableIncidentDateReason } from '@/services/nhtsa/types.js';
import {
  buildComponentBreakdown,
  UNRELIABLE_INCIDENT_DATE_REASONS,
} from '@/services/nhtsa/types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function formatText(value?: string): string {
  return value || 'Not available';
}

/** What each rejection reason contradicts, in the words a reader of the rendered line needs. */
const INCIDENT_DATE_REJECTIONS: Record<UnreliableIncidentDateReason, string> = {
  postdates_filing: 'falls after the complaint was filed',
  predates_model_year: 'predates the vehicle model year',
};

/**
 * Render the incident date. A date NHTSA reported but the record contradicts is disclosed
 * rather than shown as the incident date or hidden entirely — "Not available" would claim
 * NHTSA holds no date, which is a different fact. The raw reason token rides along so a client
 * reading only `content[]` gets the same machine-readable verdict `structuredContent` carries.
 *
 * Both fields render independently: the service sets one or the other, but format() owes every
 * declared output field a rendering rather than a rendering conditional on a sibling.
 */
function formatIncidentDate(complaint: {
  dateOfIncident?: string | undefined;
  unreliableIncidentDate?: { reported: string; reason: UnreliableIncidentDateReason } | undefined;
}): string {
  const parts: string[] = [];
  if (complaint.dateOfIncident) parts.push(complaint.dateOfIncident);
  const unreliable = complaint.unreliableIncidentDate;
  if (unreliable) {
    parts.push(
      `Unreliable (${unreliable.reason}) — NHTSA reported ${unreliable.reported}, which ${INCIDENT_DATE_REJECTIONS[unreliable.reason]}`,
    );
  }
  return parts.join(' · ') || 'Not available';
}

/**
 * Render the severity fields NHTSA recorded on a complaint, false and zero included, so an
 * explicitly clean report is distinguishable from one the complainant left blank. Returns
 * undefined when NHTSA reported none of them.
 */
function formatComplaintSeverity(complaint: {
  crash?: boolean | undefined;
  fire?: boolean | undefined;
  numberOfInjuries?: number | undefined;
  numberOfDeaths?: number | undefined;
}): string | undefined {
  const yesNo = (value: boolean) => (value ? 'yes' : 'no');
  const reported: string[] = [];
  if (complaint.crash !== undefined) reported.push(`Crash: ${yesNo(complaint.crash)}`);
  if (complaint.fire !== undefined) reported.push(`Fire: ${yesNo(complaint.fire)}`);
  if (complaint.numberOfInjuries !== undefined) {
    reported.push(`Injuries: ${complaint.numberOfInjuries}`);
  }
  if (complaint.numberOfDeaths !== undefined) {
    reported.push(`Deaths: ${complaint.numberOfDeaths}`);
  }

  return reported.length > 0 ? reported.join(' | ') : undefined;
}

export const searchComplaints = tool('nhtsa_search_complaints', {
  description:
    'Search consumer safety complaints filed with NHTSA for a specific vehicle. Returns a component breakdown over all matching complaints plus a paginated slice of the most recent complaints. Use for common problems, failure patterns, or owner-reported issues.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z.string().describe('Vehicle manufacturer.'),
    model: z.string().describe('Vehicle model.'),
    modelYear: z.number().int().describe('Model year, a whole number.'),
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
        'Pagination offset into the filing-date-descending complaint list. Defaults to 0. componentBreakdown is unaffected by pagination.',
      ),
  }),
  output: z.object({
    totalCount: z.number().describe('Total complaints matching criteria'),
    returned: z.number().describe('Number of complaints in this page'),
    offset: z.number().describe('Pagination offset used for this page'),
    limit: z.number().describe('Pagination limit used for this page'),
    componentBreakdown: z
      .array(
        z
          .object({
            component: z.string().describe('Component name'),
            count: z.number().describe('Number of complaints'),
            crashCount: z.number().describe('Complaints involving crashes'),
            fireCount: z.number().describe('Complaints involving fires'),
            injuryCount: z.number().describe('Total injuries reported'),
            deathCount: z.number().describe('Total deaths reported'),
          })
          .describe('Complaint counts for a single component'),
      )
      .describe('Complaints grouped by component, sorted by frequency'),
    complaints: z
      .array(
        z
          .object({
            odiNumber: z.number().optional().describe('NHTSA complaint ID'),
            dateOfIncident: z
              .string()
              .optional()
              .describe('Date the incident occurred (ISO YYYY-MM-DD)'),
            unreliableIncidentDate: z
              .object({
                reported: z.string().describe('The incident date NHTSA reported, ISO YYYY-MM-DD'),
                reason: z
                  .enum(UNRELIABLE_INCIDENT_DATE_REASONS)
                  .describe(
                    'What the reported date contradicts: "postdates_filing" — it falls after this complaint was filed; "predates_model_year" — it falls before a vehicle of this model year existed.',
                  ),
              })
              .optional()
              .describe(
                "An incident date NHTSA reported that this complaint's own filing date or model year rules out — report it as contradicted, never as when the incident happened. Appears in place of dateOfIncident, never alongside it; both absent means NHTSA reported no incident date at all.",
              ),
            dateComplaintFiled: z
              .string()
              .optional()
              .describe('Date complaint was filed (ISO YYYY-MM-DD)'),
            components: z.string().optional().describe('Affected components (comma-separated)'),
            summary: z.string().optional().describe('Consumer-reported description'),
            crash: z.boolean().optional().describe('Involved a crash'),
            fire: z.boolean().optional().describe('Involved a fire'),
            numberOfInjuries: z.number().optional().describe('Number of injuries'),
            numberOfDeaths: z.number().optional().describe('Number of deaths'),
            vin: z.string().optional().describe('VIN prefix (partial)'),
          })
          .describe('A single consumer complaint'),
      )
      .describe('Paginated slice of the most recent complaints, date-descending'),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        '"make model modelYear" with optional component filter applied, as the server used it.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no complaints match the vehicle, or when the requested page overshoots the result set.',
      ),
  },

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

    const effectiveQuery = input.component
      ? `${input.make} ${input.model} ${input.modelYear} component=${input.component}`
      : `${input.make} ${input.model} ${input.modelYear}`;
    ctx.enrich({ effectiveQuery });
    if (complaints.length === 0) {
      ctx.enrich.notice(
        'No complaints found. This may mean no complaints have been filed, or the make/model/year may not match NHTSA records. Use nhtsa_lookup_vehicles to verify.',
      );
    } else if (page.length === 0) {
      ctx.enrich.notice(outOfBoundsMessage({ offset, limit, totalCount: complaints.length }));
    }

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
      return [{ type: 'text' as const, text: 'No complaints found for this vehicle.' }];
    }

    const lines = [`**${result.totalCount} complaint(s)**\n`];

    // Component breakdown
    lines.push('## Component Breakdown\n');
    for (const b of result.componentBreakdown) {
      const flags = [
        b.crashCount > 0 ? `${b.crashCount} ${pluralize(b.crashCount, 'crash', 'crashes')}` : '',
        b.fireCount > 0 ? `${b.fireCount} ${pluralize(b.fireCount, 'fire')}` : '',
        b.injuryCount > 0
          ? `${b.injuryCount} ${pluralize(b.injuryCount, 'injury', 'injuries')}`
          : '',
        b.deathCount > 0 ? `${b.deathCount} ${pluralize(b.deathCount, 'death')}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `- **${b.component}:** ${b.count} ${pluralize(b.count, 'complaint')}${flags ? ` (${flags})` : ''}`,
      );
    }

    lines.push(
      `\n## Recent Complaints (returned ${result.returned} of ${result.totalCount}, offset ${result.offset}, limit ${result.limit}, date-descending)\n`,
    );
    if (result.returned === 0) {
      lines.push(`*${outOfBoundsMessage(result)}*\n`);
    } else if (result.offset + result.returned < result.totalCount) {
      lines.push(`*Use offset=${result.offset + result.returned} to retrieve the next page.*\n`);
    }
    for (const c of result.complaints) {
      const flags: string[] = [];
      if (c.crash) flags.push('CRASH');
      if (c.fire) flags.push('FIRE');
      const injuries = c.numberOfInjuries ?? 0;
      const deaths = c.numberOfDeaths ?? 0;
      if (injuries > 0) flags.push(`${injuries} ${pluralize(injuries, 'injury', 'injuries')}`);
      if (deaths > 0) flags.push(`${deaths} ${pluralize(deaths, 'death')}`);
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

      lines.push(
        `**#${c.odiNumber ?? 'Unknown'}** — ${formatIncidentDate(c)} (filed ${formatText(c.dateComplaintFiled)})${flagStr}`,
      );
      const severity = formatComplaintSeverity(c);
      if (severity) lines.push(`Reported: ${severity}`);
      if (c.vin) lines.push(`VIN: ${c.vin}`);
      lines.push(`Components: ${formatText(c.components)}`);
      lines.push(`${formatText(c.summary)}\n`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
