/**
 * @fileoverview Search NHTSA defect investigations. Sourced from the ODI FLAT_INV.zip
 * bulk file (~5K deduplicated records), cached for 24 hours. Supports structured
 * make/model/component filters and links investigations to recall campaigns via CAMPNO.
 * @module mcp-server/tools/definitions/search-investigations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Investigation } from '@/services/nhtsa/types.js';

const DEFAULT_LIMIT = 20;
/**
 * Lower than the 50 used by the other paginated tools: an investigation summary is an
 * order of magnitude larger than a complaint narrative (p95 ≈ 3,000 characters, longest
 * ≈ 5,900), and format() renders each one in full.
 */
const MAX_LIMIT = 25;

const INVESTIGATION_TYPE_MAP: Record<string, string> = {
  PE: 'Preliminary Evaluation',
  EA: 'Engineering Analysis',
  DP: 'Defect Petition',
  RQ: 'Recall Query',
  AQ: 'Audit Query',
};

const STATUS_MAP: Record<string, string> = {
  O: 'Open',
  C: 'Closed',
};

function matchesText(investigation: Investigation, text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (investigation.nhtsaId ?? '').toLowerCase().includes(lower) ||
    (investigation.subject ?? '').toLowerCase().includes(lower) ||
    (investigation.summary ?? '').toLowerCase().includes(lower)
  );
}

function matchesMake(investigation: Investigation, make: string): boolean {
  const lower = make.toLowerCase();
  return (investigation.makes ?? []).some((m) => m.toLowerCase().includes(lower));
}

function matchesModel(investigation: Investigation, model: string): boolean {
  const lower = model.toLowerCase();
  return (investigation.models ?? []).some((m) => m.toLowerCase().includes(lower));
}

function matchesComponent(investigation: Investigation, component: string): boolean {
  const lower = component.toLowerCase();
  return (investigation.components ?? []).some((c) => c.toLowerCase().includes(lower));
}

export const searchInvestigations = tool('nhtsa_search_investigations', {
  description:
    "Search NHTSA defect investigations from the ODI flat file — covering Preliminary Evaluations (PE), Engineering Analyses (EA), Defect Petitions (DP), Recall Queries (RQ), Audit Queries (AQ), and additional ODI types. make, model, and component are structured filters against the investigation record's vehicle associations. All filters are ANDed. Use nhtsaId to fetch one investigation by its exact ID — including the investigationId nhtsa_search_recalls returns for a campaign. Investigations may link to a resulting recall campaign via recallCampaign.",
  annotations: { readOnlyHint: true },
  input: z.object({
    nhtsaId: z
      .string()
      .optional()
      .describe(
        'Exact NHTSA investigation ID (e.g. "EA23003"), case-insensitive. Fetches that one record — mutually exclusive with every other filter.',
      ),
    query: z
      .string()
      .optional()
      .describe('Free-text search across investigation ID, subject, and summary.'),
    make: z
      .string()
      .optional()
      .describe(
        'Structured filter — matches against the investigation\'s associated vehicle makes (e.g., "TOYOTA"). ANDed with other filters.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Structured filter — matches against the investigation's associated vehicle models. ANDed with other filters.",
      ),
    component: z
      .string()
      .optional()
      .describe(
        'Structured filter — matches against the investigation\'s affected components (e.g., "STEERING"). ANDed with other filters.',
      ),
    investigationType: z
      .string()
      .optional()
      .describe(
        'Filter by ODI investigation type code (the leading letters of the NHTSA ID). Named types: "PE" (Preliminary Evaluation), "EA" (Engineering Analysis), "DP" (Defect Petition), "RQ" (Recall Query), "AQ" (Audit Query). Additional valid codes present in the dataset: "SQ", "EQ", "RP", "ID", "TA", "C". Pass any code exactly as it appears in the investigation ID prefix.',
      ),
    status: z
      .enum(['O', 'C'])
      .optional()
      .describe('Filter by status: "O" (Open) or "C" (Closed). Omit to include both.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max investigations to return. Defaults to ${DEFAULT_LIMIT}; max ${MAX_LIMIT}. The cap is lower than the other paginated tools because a single investigation summary can run several thousand characters and is rendered in full.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Pagination offset into the matching investigations. Defaults to 0.'),
  }),
  output: z.object({
    totalCount: z.number().describe('Total matching investigations'),
    returned: z.number().describe('Number of investigations in this page'),
    offset: z.number().describe('Pagination offset used for this page'),
    limit: z.number().describe('Pagination limit used for this page'),
    investigations: z
      .array(
        z
          .object({
            nhtsaId: z.string().optional().describe('NHTSA investigation ID'),
            investigationType: z.string().optional().describe('Investigation type code'),
            investigationTypeName: z.string().optional().describe('Investigation type name'),
            status: z.string().optional().describe('Status code (O=Open, C=Closed)'),
            statusName: z.string().optional().describe('Status name'),
            makes: z.array(z.string()).optional().describe('Associated vehicle makes'),
            models: z.array(z.string()).optional().describe('Associated vehicle models'),
            years: z.array(z.number()).optional().describe('Associated model years'),
            components: z.array(z.string()).optional().describe('Affected components'),
            manufacturer: z.string().optional().describe('Manufacturer name'),
            subject: z.string().optional().describe('Investigation subject'),
            summary: z.string().optional().describe('Investigation summary'),
            openDate: z.string().optional().describe('Date investigation opened (YYYY-MM-DD)'),
            closeDate: z
              .string()
              .optional()
              .describe('Date investigation closed (YYYY-MM-DD), if closed'),
            recallCampaign: z
              .string()
              .optional()
              .describe('Linked recall campaign number (if any) — use with nhtsa_search_recalls'),
          })
          .describe('A single NHTSA investigation'),
      )
      .describe('Matching investigations'),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Applied filters as a readable string, e.g. make="Ford" status="O".'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no investigations match — e.g. suggestions for broadening the search.',
      ),
  },
  errors: [
    {
      reason: 'mode_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'nhtsaId was combined with another filter.',
      recovery:
        'Use nhtsaId alone, or the query/make/model/component/investigationType/status filters. limit and offset work with either.',
    },
  ],

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;

    if (
      input.nhtsaId &&
      (input.query ||
        input.make ||
        input.model ||
        input.component ||
        input.investigationType ||
        input.status)
    ) {
      throw ctx.fail(
        'mode_conflict',
        'Provide either nhtsaId for one investigation, or the query/make/model/component/investigationType/status filters — not both.',
        { ...ctx.recoveryFor('mode_conflict') },
      );
    }

    let investigations = await svc.getInvestigations(ctx.signal);

    if (input.nhtsaId) {
      const nhtsaId = input.nhtsaId.trim().toUpperCase();
      investigations = investigations.filter((i) => i.nhtsaId?.toUpperCase() === nhtsaId);
    }

    // Apply filters
    if (input.investigationType) {
      const type = input.investigationType.toUpperCase();
      investigations = investigations.filter((i) => i.investigationType === type);
    }
    if (input.status) {
      const status = input.status;
      investigations = investigations.filter((i) => i.status === status);
    }
    if (input.make) {
      const make = input.make;
      investigations = investigations.filter((i) => matchesMake(i, make));
    }
    if (input.model) {
      const model = input.model;
      investigations = investigations.filter((i) => matchesModel(i, model));
    }
    if (input.component) {
      const component = input.component;
      investigations = investigations.filter((i) => matchesComponent(i, component));
    }
    if (input.query) {
      const query = input.query;
      investigations = investigations.filter((i) => matchesText(i, query));
    }

    const totalCount = investigations.length;
    const page = investigations.slice(offset, offset + limit);

    ctx.log.info('Investigation search', {
      nhtsaId: input.nhtsaId,
      query: input.query,
      make: input.make,
      model: input.model,
      component: input.component,
      totalCount,
      returned: page.length,
      offset,
      limit,
    });

    const appliedFilters = [
      input.nhtsaId ? `nhtsaId="${input.nhtsaId}"` : null,
      input.query ? `query="${input.query}"` : null,
      input.make ? `make="${input.make}"` : null,
      input.model ? `model="${input.model}"` : null,
      input.component ? `component="${input.component}"` : null,
      input.investigationType ? `investigationType="${input.investigationType}"` : null,
      input.status ? `status="${input.status}"` : null,
    ].filter((f): f is string => f !== null);

    const effectiveQuery = appliedFilters.length > 0 ? appliedFilters.join(', ') : '(all)';
    ctx.enrich({ effectiveQuery });

    if (totalCount === 0) {
      let notice: string;
      if (input.nhtsaId) {
        notice = `No investigation has the ID "${input.nhtsaId}". IDs are a type prefix plus digits, e.g. "EA23003" or "PE24010"; nhtsa_search_recalls returns one as investigationId for campaigns NHTSA links to an investigation.`;
      } else if (appliedFilters.length === 0) {
        notice =
          'No investigations found. This is unexpected — the investigations dataset should contain thousands of records.';
      } else {
        notice = `No investigations matched the applied filters (${appliedFilters.join(', ')}). Filters are ANDed; try broadening by removing a filter. make/model/component match against structured vehicle associations.`;
      }
      ctx.enrich.notice(notice);
    }

    return {
      totalCount,
      returned: page.length,
      offset,
      limit,
      investigations: page.map((i) => ({
        nhtsaId: i.nhtsaId,
        investigationType: i.investigationType,
        investigationTypeName: i.investigationType
          ? (INVESTIGATION_TYPE_MAP[i.investigationType] ?? i.investigationType)
          : undefined,
        status: i.status,
        statusName: i.status ? (STATUS_MAP[i.status] ?? i.status) : undefined,
        makes: i.makes && i.makes.length > 0 ? i.makes : undefined,
        models: i.models && i.models.length > 0 ? i.models : undefined,
        years: i.years && i.years.length > 0 ? i.years : undefined,
        components: i.components && i.components.length > 0 ? i.components : undefined,
        manufacturer: i.manufacturer,
        subject: i.subject,
        summary: i.summary,
        openDate: i.openDate,
        closeDate: i.closeDate,
        recallCampaign: i.recallCampaign,
      })),
    };
  },

  format: (result) => {
    if (result.totalCount === 0) {
      return [
        {
          type: 'text' as const,
          text: 'No investigations found matching the search criteria. Try broadening the search — use fewer filters, or search by make only.',
        },
      ];
    }

    const lines = [
      `**${result.totalCount} investigation(s) found** (showing ${result.returned}, offset ${result.offset}, limit ${result.limit})\n`,
    ];
    if (result.offset + result.returned < result.totalCount) {
      lines.push(`*Use offset=${result.offset + result.returned} to retrieve the next page.*\n`);
    }

    for (const i of result.investigations) {
      const statusLabel = i.statusName || 'Unknown';
      lines.push(`### ${i.nhtsaId || 'Unknown ID'} [${i.status ?? 'N/A'}: ${statusLabel}]`);
      lines.push(
        `**Type:** ${i.investigationType ?? 'N/A'} — ${i.investigationTypeName || 'Not available'}`,
      );
      if (i.makes && i.makes.length > 0) lines.push(`**Makes:** ${i.makes.join(', ')}`);
      if (i.models && i.models.length > 0) lines.push(`**Models:** ${i.models.join(', ')}`);
      if (i.years && i.years.length > 0) lines.push(`**Years:** ${i.years.join(', ')}`);
      if (i.components && i.components.length > 0)
        lines.push(`**Components:** ${i.components.join(', ')}`);
      if (i.manufacturer) lines.push(`**Manufacturer:** ${i.manufacturer}`);
      if (i.subject) lines.push(`**Subject:** ${i.subject}`);
      lines.push(
        `**Opened:** ${i.openDate || 'Not available'}${i.closeDate ? ` | **Closed:** ${i.closeDate}` : ''}`,
      );
      if (i.recallCampaign) lines.push(`**Recall Campaign:** ${i.recallCampaign}`);
      if (i.summary) lines.push(`\n${i.summary}`);
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
