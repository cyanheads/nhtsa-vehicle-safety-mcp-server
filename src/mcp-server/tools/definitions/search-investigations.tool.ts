/**
 * @fileoverview Search NHTSA defect investigations. Sourced from the ODI FLAT_INV.zip
 * bulk file (~5K deduplicated records), cached for 24 hours. Supports structured
 * make/model/component filters and links investigations to recall campaigns via CAMPNO.
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
  AQ: 'Audit Query',
};

const STATUS_MAP: Record<string, string> = {
  O: 'Open',
  C: 'Closed',
};

function matchesText(investigation: Investigation, text: string): boolean {
  const lower = text.toLowerCase();
  return (
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
    "Search NHTSA defect investigations from the ODI flat file — covering Preliminary Evaluations (PE), Engineering Analyses (EA), Defect Petitions (DP), Recall Queries (RQ), Audit Queries (AQ), and additional ODI types. make, model, and component are structured filters against the investigation record's vehicle associations. All filters are ANDed. Investigations may link to a resulting recall campaign via recallCampaign.",
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free-text search across investigation subject and summary.'),
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
    status: z.string().optional().describe('Filter by status: "O" (Open), "C" (Closed).'),
    limit: z.number().optional().describe('Max results to return. Default: 20.'),
    offset: z.number().optional().describe('Pagination offset. Default: 0.'),
  }),
  output: z.object({
    totalCount: z.number().describe('Total matching investigations'),
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

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;

    let investigations = await svc.getInvestigations(ctx.signal);

    // Apply filters
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
      query: input.query,
      make: input.make,
      model: input.model,
      component: input.component,
      totalCount,
      returned: page.length,
    });

    const appliedFilters = [
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
      const notice =
        appliedFilters.length === 0
          ? 'No investigations found. This is unexpected — the investigations dataset should contain thousands of records.'
          : `No investigations matched the applied filters (${appliedFilters.join(', ')}). Filters are ANDed; try broadening by removing a filter. make/model/component match against structured vehicle associations.`;
      ctx.enrich.notice(notice);
    }

    return {
      totalCount,
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
      `**${result.totalCount} investigation(s) found** (showing ${result.investigations.length})\n`,
    ];

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
      if (i.summary) {
        const desc = i.summary.length > 500 ? `${i.summary.slice(0, 500)}...` : i.summary;
        lines.push(`\n${desc}`);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
