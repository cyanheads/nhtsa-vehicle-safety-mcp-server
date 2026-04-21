/**
 * @fileoverview Search NHTSA defect investigations. The investigations API does not
 * filter by make/model — the server caches the full index (~4,200 records) and
 * filters locally.
 * @module mcp-server/tools/definitions/search-investigations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Investigation } from '@/services/nhtsa/types.js';

const INVESTIGATION_TYPE_MAP: Record<string, string> = {
  PE: 'Preliminary Evaluation',
  EA: 'Engineering Analysis',
  DP: 'Defect Petition',
  RQ: 'Recall Query',
};

const STATUS_MAP: Record<string, string> = {
  O: 'Open',
  C: 'Closed',
};

function matchesText(investigation: Investigation, text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (investigation.subject ?? '').toLowerCase().includes(lower) ||
    (investigation.description ?? '').toLowerCase().includes(lower)
  );
}

export const searchInvestigations = tool('nhtsa_search_investigations', {
  description:
    'Search NHTSA defect investigations (Preliminary Evaluations, Engineering Analyses, Defect Petitions, Recall Queries). All filters are ANDed — each additional filter narrows results. The make, model, and query filters all search investigation subject/description text (there are no structured make/model fields in the investigations dataset). First query may be slow (~10s) while the investigation index loads; subsequent queries use a cached index.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free-text search across investigation subjects and descriptions.'),
    make: z
      .string()
      .optional()
      .describe(
        'Free-text filter — matches manufacturer name against subject/description text. ANDed with other filters.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Free-text filter — matches model name against subject/description text. ANDed with other filters.',
      ),
    investigationType: z
      .string()
      .optional()
      .describe(
        'Filter by type: "PE" (Preliminary Evaluation), "EA" (Engineering Analysis), "DP" (Defect Petition), "RQ" (Recall Query).',
      ),
    status: z.string().optional().describe('Filter by status: "O" (Open), "C" (Closed).'),
    limit: z.number().optional().describe('Max results to return. Default: 20.'),
    offset: z.number().optional().describe('Pagination offset. Default: 0.'),
  }),
  output: z.object({
    total: z.number().describe('Total matching investigations'),
    message: z
      .string()
      .optional()
      .describe('Contextual guidance populated when no investigations match the filters'),
    investigations: z
      .array(
        z.object({
          nhtsaId: z.string().optional().describe('NHTSA investigation ID'),
          investigationType: z.string().optional().describe('Investigation type code'),
          investigationTypeName: z.string().optional().describe('Investigation type name'),
          status: z.string().optional().describe('Status code (O=Open, C=Closed)'),
          statusName: z.string().optional().describe('Status name'),
          subject: z.string().optional().describe('Investigation subject'),
          description: z.string().optional().describe('Investigation description (HTML stripped)'),
          openDate: z.string().optional().describe('Date investigation opened'),
          latestActivityDate: z.string().optional().describe('Date of latest activity'),
        }),
      )
      .describe('Matching investigations'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;

    let investigations = await svc.getInvestigations(ctx.signal);

    // Apply filters locally
    if (input.investigationType) {
      const type = input.investigationType.toUpperCase();
      investigations = investigations.filter((i) => i.investigationType === type);
    }
    if (input.status) {
      const status = input.status.toUpperCase();
      investigations = investigations.filter((i) => i.status === status);
    }
    if (input.make) {
      const make = input.make;
      investigations = investigations.filter((i) => matchesText(i, make));
    }
    if (input.model) {
      const model = input.model;
      investigations = investigations.filter((i) => matchesText(i, model));
    }
    if (input.query) {
      const query = input.query;
      investigations = investigations.filter((i) => matchesText(i, query));
    }

    const total = investigations.length;
    const page = investigations.slice(offset, offset + limit);

    ctx.log.info('Investigation search', {
      query: input.query,
      make: input.make,
      model: input.model,
      total,
      returned: page.length,
    });

    const appliedFilters = [
      input.query ? `query="${input.query}"` : null,
      input.make ? `make="${input.make}"` : null,
      input.model ? `model="${input.model}"` : null,
      input.investigationType ? `investigationType="${input.investigationType}"` : null,
      input.status ? `status="${input.status}"` : null,
    ].filter((f): f is string => f !== null);
    const message =
      total === 0
        ? appliedFilters.length === 0
          ? 'No investigations found. This is unexpected — the investigations dataset should contain thousands of records.'
          : `No investigations matched the applied filters (${appliedFilters.join(', ')}). Filters are ANDed; try broadening by removing a filter or searching make-only. make/model/query all search subject+description text — try a shorter term.`
        : undefined;

    return {
      total,
      ...(message ? { message } : {}),
      investigations: page.map((i) => ({
        nhtsaId: i.nhtsaId,
        investigationType: i.investigationType,
        investigationTypeName: i.investigationType
          ? (INVESTIGATION_TYPE_MAP[i.investigationType] ?? i.investigationType)
          : undefined,
        status: i.status,
        statusName: i.status ? (STATUS_MAP[i.status] ?? i.status) : undefined,
        subject: i.subject,
        description: i.description,
        openDate: i.openDate,
        latestActivityDate: i.latestActivityDate,
      })),
    };
  },

  format: (result) => {
    if (result.total === 0) {
      return [
        {
          type: 'text' as const,
          text:
            result.message ??
            'No investigations found matching the search criteria. Try broadening the search — use fewer filters, or search by make only.',
        },
      ];
    }

    const lines = [
      `**${result.total} investigation(s) found** (showing ${result.investigations.length})\n`,
    ];
    if (result.message) lines.push(`*${result.message}*\n`);

    for (const i of result.investigations) {
      const statusLabel = i.statusName || 'Unknown';
      lines.push(`### ${i.nhtsaId || 'Unknown ID'} [${i.status ?? 'N/A'}: ${statusLabel}]`);
      lines.push(
        `**Type:** ${i.investigationType ?? 'N/A'} — ${i.investigationTypeName || 'Not available'}`,
      );
      lines.push(`**Subject:** ${i.subject || 'Not available'}`);
      lines.push(
        `**Opened:** ${i.openDate || 'Not available'} | **Latest Activity:** ${i.latestActivityDate || 'Not available'}`,
      );
      if (i.description) {
        const desc =
          i.description.length > 500 ? `${i.description.slice(0, 500)}...` : i.description;
        lines.push(`\n${desc}`);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
