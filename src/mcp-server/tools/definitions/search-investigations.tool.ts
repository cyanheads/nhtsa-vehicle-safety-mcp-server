/**
 * @fileoverview Search NHTSA defect investigations. Sourced from the ODI FLAT_INV.zip
 * bulk file (~5K deduplicated records), cached for 24 hours and ordered newest-opened first.
 * Make, model, and model year match on one vehicle association; every linked manufacturer and
 * recall campaign is listed; search rows carry full summaries only on request.
 * @module mcp-server/tools/definitions/search-investigations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  limitClampNotice,
  limitSchema,
  limitTooLargeMessage,
  type PageLimit,
  resolveLimit,
} from '@/mcp-server/tools/request-cap.js';
import {
  dateRangeSchema,
  describeDateRange,
  matchesDateRange,
  normalizeDateRange,
} from '@/services/nhtsa/date-range.js';
import { nextPageHint, outOfBoundsMessage } from '@/services/nhtsa/format.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Investigation } from '@/services/nhtsa/types.js';

const PAGE = {
  tool: 'nhtsa_search_investigations',
  defaultLimit: 20,
  maxLimit: 50,
} as const satisfies PageLimit;

/** The way back to the summaries a search page leaves out of its rows. */
const SUMMARIES_OMITTED =
  'Search rows omit summaries: fetch one investigation by nhtsaId for its full summary, or repeat this search with includeSummary: true.';

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

/**
 * Whether one vehicle association of the investigation carries every supplied value: `make` and
 * `model`, already lowercased, within its make and model case-insensitively, and `modelYear` as
 * its exact year.
 */
function matchesVehicle(
  investigation: Investigation,
  filter: { make: string | undefined; model: string | undefined; modelYear: number | undefined },
): boolean {
  const { make, model, modelYear } = filter;
  return investigation.vehicles.some(
    (vehicle) =>
      (make === undefined || (vehicle.make?.toLowerCase().includes(make) ?? false)) &&
      (model === undefined || (vehicle.model?.toLowerCase().includes(model) ?? false)) &&
      (modelYear === undefined || vehicle.year === modelYear),
  );
}

function matchesComponent(investigation: Investigation, component: string): boolean {
  const lower = component.toLowerCase();
  return (investigation.components ?? []).some((c) => c.toLowerCase().includes(lower));
}

export const searchInvestigations = tool('nhtsa_search_investigations', {
  description:
    "Search NHTSA defect investigations — Preliminary Evaluations (PE), Engineering Analyses (EA), Defect Petitions (DP), Recall Queries (RQ), Audit Queries (AQ), and additional ODI types — newest-opened first. make, model, and modelYear match the investigation's vehicle associations, all on the same association; component matches its affected components. All filters are ANDed. Search rows leave out the full summary unless includeSummary is true. Use nhtsaId to fetch one investigation by its exact ID with its full summary — including the investigationId nhtsa_search_recalls returns for a campaign. recallCampaigns lists the recall campaigns NHTSA links to an investigation; pass any to nhtsa_search_recalls as campaignNumber.",
  annotations: { readOnlyHint: true },
  input: z.object({
    nhtsaId: z
      .string()
      .optional()
      .describe(
        'Exact NHTSA investigation ID (e.g. "EA23003"), case-insensitive. Fetches that one record with its full summary — mutually exclusive with every other filter.',
      ),
    query: z
      .string()
      .optional()
      .describe('Free-text search across investigation ID, subject, and summary.'),
    make: z
      .string()
      .optional()
      .describe(
        'Vehicle make on one of the investigation\'s vehicle associations (e.g., "TOYOTA"), matched case-insensitively within the name. With model or modelYear, all must match the same association.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Vehicle model on one of the investigation's vehicle associations, matched case-insensitively within the name. With make or modelYear, all must match the same association.",
      ),
    modelYear: z
      .number()
      .int()
      .optional()
      .describe(
        'Model year, a whole number. Matches when one vehicle association carries this year together with every supplied make and model; an investigation with no model year on any association never matches.',
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
    openDateRange: dateRangeSchema
      .optional()
      .describe(
        'Inclusive opened-date bounds in calendar-valid YYYY-MM-DD. ANDed with other filters; blank bounds are unset.',
      ),
    closeDateRange: dateRangeSchema
      .optional()
      .describe(
        'Inclusive closed-date bounds in calendar-valid YYYY-MM-DD. Active bounds exclude investigations without a usable close date, including open investigations.',
      ),
    includeSummary: z
      .boolean()
      .default(false)
      .describe(
        "Include each investigation's full summary in search rows. Off by default: rows carry the subject, dates, vehicle associations, and campaign links, and nhtsaId mode always returns the summary. A summary can run several thousand characters, so pair this with a small limit.",
      ),
    limit: limitSchema()
      .optional()
      .describe(
        `Investigations per page. Defaults to ${PAGE.defaultLimit}; at most ${PAGE.maxLimit} per page.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Pagination offset into the matching investigations, ordered newest-opened first: open date descending, then ID descending, undated last. Defaults to 0.',
      ),
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
            years: z
              .array(z.number())
              .optional()
              .describe(
                "Model years across all of the investigation's vehicle associations, every make and model, ascending",
              ),
            components: z.array(z.string()).optional().describe('Affected components'),
            manufacturers: z
              .array(z.string())
              .optional()
              .describe("Manufacturers named on the investigation's vehicle associations"),
            subject: z.string().optional().describe('Investigation subject'),
            summary: z
              .string()
              .optional()
              .describe(
                'Investigation summary. Present in nhtsaId mode, and in search rows only with includeSummary: true.',
              ),
            openDate: z.string().optional().describe('Date investigation opened (YYYY-MM-DD)'),
            closeDate: z
              .string()
              .optional()
              .describe('Date investigation closed (YYYY-MM-DD), if closed'),
            recallCampaigns: z
              .array(z.string())
              .optional()
              .describe(
                'Recall campaigns linked to the investigation, as NHTSA lists them — pass any to nhtsa_search_recalls as campaignNumber',
              ),
          })
          .describe('A single NHTSA investigation'),
      )
      .describe('Matching investigations'),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Applied filters as a readable string, e.g. make="Ford", status="O".'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no investigations match the filters, when the requested page overshoots the result set, when limit was lowered to the page maximum, or when search rows omit summaries.',
      ),
  },
  errors: [
    {
      reason: 'mode_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'nhtsaId was combined with another filter.',
      recovery:
        'Use nhtsaId alone, or search filters including modelYear and openDateRange/closeDateRange. limit, offset, and includeSummary work with either.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A date bound is not a calendar-valid YYYY-MM-DD date.',
      recovery: 'Use calendar-valid YYYY-MM-DD dates such as 2025-01-01.',
      thrownBy: 'service',
    },
    {
      reason: 'inverted_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A range has after later than before.',
      recovery: 'Set after on or before before, or omit a bound.',
      thrownBy: 'service',
    },
    {
      reason: 'limit_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `limit exceeds the ${PAGE.maxLimit}-row page maximum on a server set to reject an over-maximum limit rather than lower it.`,
      recovery: `Request a limit of ${PAGE.maxLimit} or less and page through the rest with offset.`,
    },
  ],

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const offset = input.offset ?? 0;
    input = {
      ...input,
      nhtsaId: input.nhtsaId?.trim() || undefined,
      query: input.query?.trim() || undefined,
      make: input.make?.trim() || undefined,
      model: input.model?.trim() || undefined,
      component: input.component?.trim() || undefined,
      investigationType: input.investigationType?.trim() || undefined,
    };
    const openDateRange = normalizeDateRange(input.openDateRange, 'openDateRange');
    const closeDateRange = normalizeDateRange(input.closeDateRange, 'closeDateRange');

    if (
      input.nhtsaId &&
      (input.query ||
        input.make ||
        input.model ||
        input.modelYear !== undefined ||
        input.component ||
        input.investigationType ||
        input.status ||
        openDateRange ||
        closeDateRange)
    ) {
      throw ctx.fail(
        'mode_conflict',
        'Provide either nhtsaId for one investigation, or search filters including date ranges — not both.',
      );
    }

    const pageLimit = resolveLimit(ctx, PAGE, input.limit);
    if (pageLimit.kind === 'rejected') {
      throw ctx.fail('limit_too_large', limitTooLargeMessage(pageLimit));
    }
    const limit = pageLimit.applied;

    // The service hands the records over newest-opened first; every filter below keeps that order.
    let investigations = await svc.getInvestigations(ctx.signal);

    if (input.nhtsaId) {
      const nhtsaId = input.nhtsaId.toUpperCase();
      investigations = investigations.filter((i) => i.nhtsaId?.toUpperCase() === nhtsaId);
    }

    if (input.investigationType) {
      const type = input.investigationType.toUpperCase();
      investigations = investigations.filter((i) => i.investigationType === type);
    }
    if (input.status) {
      const status = input.status;
      investigations = investigations.filter((i) => i.status === status);
    }
    if (input.make || input.model || input.modelYear !== undefined) {
      const vehicle = {
        make: input.make?.toLowerCase(),
        model: input.model?.toLowerCase(),
        modelYear: input.modelYear,
      };
      investigations = investigations.filter((i) => matchesVehicle(i, vehicle));
    }
    if (input.component) {
      const component = input.component;
      investigations = investigations.filter((i) => matchesComponent(i, component));
    }
    if (input.query) {
      const query = input.query;
      investigations = investigations.filter((i) => matchesText(i, query));
    }

    investigations = investigations.filter(
      (i) =>
        matchesDateRange(i.openDate, openDateRange) &&
        matchesDateRange(i.closeDate, closeDateRange),
    );
    const totalCount = investigations.length;
    const page = investigations.slice(offset, offset + limit);
    // nhtsaId mode always carries the summary; search rows carry it only on request.
    const omitSummaries = !input.nhtsaId && !input.includeSummary;

    ctx.log.info('Investigation search', {
      nhtsaId: input.nhtsaId,
      query: input.query,
      make: input.make,
      model: input.model,
      modelYear: input.modelYear,
      component: input.component,
      includeSummary: input.includeSummary,
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
      input.modelYear !== undefined ? `modelYear=${input.modelYear}` : null,
      input.component ? `component="${input.component}"` : null,
      input.investigationType ? `investigationType="${input.investigationType}"` : null,
      input.status ? `status="${input.status}"` : null,
      describeDateRange('openDateRange', openDateRange) || null,
      describeDateRange('closeDateRange', closeDateRange) || null,
    ].filter((f): f is string => f !== null);

    const effectiveQuery = appliedFilters.length > 0 ? appliedFilters.join(', ') : '(all)';
    ctx.enrich({ effectiveQuery });

    const notices: string[] = [];
    const clamped = limitClampNotice(pageLimit, { offset, returned: page.length, totalCount });
    if (clamped) notices.push(clamped);
    if (totalCount === 0) {
      if (input.nhtsaId) {
        notices.push(
          `No investigation has the ID "${input.nhtsaId}". IDs are a type prefix plus a number, e.g. "EA23003" or "PE24010" (some older IDs hold a letter, as in "EA78N34"); nhtsa_search_recalls returns one as investigationId for campaigns NHTSA links to an investigation.`,
        );
      } else if (appliedFilters.length === 0) {
        notices.push(
          'No investigations found. This is unexpected — the investigations dataset should contain thousands of records.',
        );
      } else {
        notices.push(
          `No investigations matched the applied filters (${appliedFilters.join(', ')}). Filters are ANDed; try broadening by removing a filter. make, model, and modelYear must all match on the same vehicle association; component matches any of the investigation's components.`,
        );
      }
    } else if (page.length === 0) {
      notices.push(outOfBoundsMessage({ offset, limit, totalCount }));
    } else if (omitSummaries && page.some((i) => i.summary !== undefined)) {
      notices.push(SUMMARIES_OMITTED);
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
        manufacturers: i.manufacturers,
        subject: i.subject,
        ...(omitSummaries || i.summary === undefined ? {} : { summary: i.summary }),
        openDate: i.openDate,
        closeDate: i.closeDate,
        recallCampaigns: i.recallCampaigns,
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
    const nextPage = nextPageHint(result);
    if (nextPage) lines.push(nextPage);

    /**
     * Names join on "; " because some makes, models, components, and manufacturer names contain
     * commas and none contains a semicolon; years and campaign numbers contain neither.
     */
    for (const i of result.investigations) {
      const statusLabel = i.statusName || 'Unknown';
      lines.push(`### ${i.nhtsaId || 'Unknown ID'} [${i.status ?? 'N/A'}: ${statusLabel}]`);
      lines.push(
        `**Type:** ${i.investigationType ?? 'N/A'} — ${i.investigationTypeName || 'Not available'}`,
      );
      if (i.makes && i.makes.length > 0) lines.push(`**Makes:** ${i.makes.join('; ')}`);
      if (i.models && i.models.length > 0) lines.push(`**Models:** ${i.models.join('; ')}`);
      if (i.years && i.years.length > 0) lines.push(`**Years:** ${i.years.join(', ')}`);
      if (i.components && i.components.length > 0)
        lines.push(`**Components:** ${i.components.join('; ')}`);
      if (i.manufacturers && i.manufacturers.length > 0)
        lines.push(`**Manufacturers:** ${i.manufacturers.join('; ')}`);
      if (i.subject) lines.push(`**Subject:** ${i.subject}`);
      lines.push(
        `**Opened:** ${i.openDate || 'Not available'}${i.closeDate ? ` | **Closed:** ${i.closeDate}` : ''}`,
      );
      if (i.recallCampaigns && i.recallCampaigns.length > 0)
        lines.push(`**Recall Campaigns:** ${i.recallCampaigns.join(', ')}`);
      if (i.summary) lines.push(`\n${i.summary}`);
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
