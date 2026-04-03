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
    investigation.subject.toLowerCase().includes(lower) ||
    investigation.description.toLowerCase().includes(lower)
  );
}

export const searchInvestigations = tool('nhtsa_search_investigations', {
  description:
    'Search NHTSA defect investigations (Preliminary Evaluations, Engineering Analyses, Defect Petitions, Recall Queries). First query may be slow (~10s) while the investigation index loads; subsequent queries use a cached index.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free-text search across investigation subjects and descriptions.'),
    make: z
      .string()
      .optional()
      .describe('Filter by manufacturer (matched against subject/description).'),
    model: z.string().optional().describe('Filter by model (matched against subject/description).'),
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
    investigations: z
      .array(
        z.object({
          nhtsaId: z.string().describe('NHTSA investigation ID'),
          investigationType: z.string().describe('Investigation type code'),
          investigationTypeName: z.string().describe('Investigation type name'),
          status: z.string().describe('Status code (O=Open, C=Closed)'),
          statusName: z.string().describe('Status name'),
          subject: z.string().describe('Investigation subject'),
          description: z.string().describe('Investigation description (HTML stripped)'),
          openDate: z.string().describe('Date investigation opened'),
          latestActivityDate: z.string().describe('Date of latest activity'),
        }),
      )
      .describe('Matching investigations'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;

    let investigations = await svc.getInvestigations();

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

    return {
      total,
      investigations: page.map((i) => ({
        nhtsaId: i.nhtsaId,
        investigationType: i.investigationType,
        investigationTypeName: INVESTIGATION_TYPE_MAP[i.investigationType] ?? i.investigationType,
        status: i.status,
        statusName: STATUS_MAP[i.status] ?? i.status,
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
          text: 'No investigations found matching the search criteria. Try broadening the search — use fewer filters, or search by make only.',
        },
      ];
    }

    const lines = [
      `**${result.total} investigation(s) found** (showing ${result.investigations.length})\n`,
    ];

    for (const i of result.investigations) {
      const statusBadge = i.status === 'O' ? 'OPEN' : 'CLOSED';
      lines.push(`### ${i.nhtsaId} [${statusBadge}]`);
      lines.push(`**Type:** ${i.investigationTypeName}`);
      lines.push(`**Subject:** ${i.subject}`);
      lines.push(`**Opened:** ${i.openDate} | **Latest Activity:** ${i.latestActivityDate}`);
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
