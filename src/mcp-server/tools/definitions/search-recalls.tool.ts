/**
 * @fileoverview Search recall campaigns by campaign number, by vehicle, or broadly across
 * NHTSA's recall flat files by make, model, model year, and received date. Date bounds apply
 * in every mode.
 * @module mcp-server/tools/definitions/search-recalls.tool
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
import {
  formatRecallAdvisories,
  nextPageHint,
  outOfBoundsMessage,
} from '@/services/nhtsa/format.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const PAGE = {
  tool: 'nhtsa_search_recalls',
  defaultLimit: 20,
  maxLimit: 50,
} as const satisfies PageLimit;

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * The broad-search notice for zero matches: the filters to relax, named as the caller sends
 * them. Composed from which filters are set, never from their values.
 */
function noMatchNotice(filters: string[], byName: boolean): string {
  const relax = `No recall campaign matches ${listFormat.format(filters)}. Relax or remove ${filters.length > 1 ? 'one of these filters' : 'this filter'}.`;
  return byName
    ? `${relax} The make and model filters match whole names as NHTSA's recall records spell them, ignoring case, and NHTSA may file a vehicle's recalls under another model name, such as a series name or a base name.`
    : relax;
}

export const searchRecalls = tool('nhtsa_search_recalls', {
  description:
    "Search recall campaigns by campaign number, by vehicle, or across every campaign by make, model, model year, and received date. campaignNumber returns that campaign with every vehicle it covers; make, model, and modelYear together return that vehicle's recalls; any other combination of make, model, modelYear, and dateRange is a broad search of NHTSA's recall files, newest first, paged with limit and offset. A broad search matches a campaign when one of its vehicle records carries every vehicle filter given, and the received date it reports can fall one day before the date the other modes report for the same campaign.",
  annotations: { readOnlyHint: true },
  input: z.object({
    campaignNumber: z
      .string()
      .optional()
      .describe(
        'NHTSA campaign number (e.g., "20V682000"). When provided, returns the campaign detail plus every vehicle it covers. A 6-character number (e.g., "00V419") returns every campaign it covers, each with its own detail and vehicles. Mutually exclusive with make/model/modelYear.',
      ),
    make: z
      .string()
      .optional()
      .describe(
        'Vehicle make (e.g., "Toyota"). With model and modelYear, looks up that vehicle\'s recalls; otherwise a broad-search filter matching the whole make name, ignoring case.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Vehicle model. With make and modelYear, looks up that vehicle's recalls; otherwise a broad-search filter matching the whole model name, ignoring case.",
      ),
    modelYear: z
      .number()
      .int()
      .optional()
      .describe(
        "Model year, a whole number. With make and model, looks up that vehicle's recalls; otherwise a broad-search filter.",
      ),
    dateRange: dateRangeSchema
      .optional()
      .describe(
        'Inclusive received-date bounds in YYYY-MM-DD, in every mode; a bound alone is a broad search. Blank bounds are unset; records without a usable date are excluded only with active bounds.',
      ),
    limit: limitSchema()
      .optional()
      .describe(
        `Campaigns per page of a broad search. Defaults to ${PAGE.defaultLimit}; at most ${PAGE.maxLimit} per page. Not accepted with campaignNumber or a full make + model + modelYear lookup, which return every match.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Pagination offset into the newest-first results of a broad search. Defaults to 0. Not accepted with campaignNumber or a full make + model + modelYear lookup.',
      ),
  }),
  output: z.object({
    recalls: z
      .array(
        z
          .object({
            campaignNumber: z.string().describe('NHTSA campaign number'),
            manufacturer: z.string().describe('Vehicle/equipment manufacturer'),
            component: z
              .string()
              .optional()
              .describe(
                'Affected component. A broad search joins all of the campaign\'s components with " | ".',
              ),
            summary: z
              .string()
              .optional()
              .describe(
                'Recall summary. Omitted for older campaigns whose record leaves it blank.',
              ),
            consequence: z
              .string()
              .optional()
              .describe(
                'Safety consequence. Omitted for older campaigns whose record leaves it blank.',
              ),
            remedy: z
              .string()
              .optional()
              .describe(
                'Corrective action. Omitted for older campaigns whose record leaves it blank.',
              ),
            reportReceivedDate: z.string().describe('Date received by NHTSA (ISO YYYY-MM-DD)'),
            potentialUnitsAffected: z
              .number()
              .optional()
              .describe('Units affected (campaign queries and broad searches)'),
            affectedVehicles: z
              .array(
                z
                  .object({
                    make: z.string().optional().describe('Vehicle make'),
                    model: z.string().optional().describe('Vehicle model'),
                    modelYear: z.number().optional().describe('Model year'),
                  })
                  .describe('One vehicle covered by the campaign'),
              )
              .optional()
              .describe(
                'Every distinct make/model the campaign covers (campaign queries). Equipment and tire campaigns name the part here — make is the brand, model is the part — and carry no model year.',
              ),
            investigationId: z
              .string()
              .optional()
              .describe(
                'ODI investigation that preceded this campaign, when NHTSA links one (campaign queries) — pass it as nhtsaId to nhtsa_search_investigations for the full record.',
              ),
            parkIt: z.boolean().optional().describe('Do-not-drive advisory when provided by NHTSA'),
            parkOutSide: z
              .boolean()
              .optional()
              .describe('Park-outside advisory when provided by NHTSA'),
            overTheAirUpdate: z
              .boolean()
              .optional()
              .describe(
                "OTA update availability when provided by NHTSA. Never set by a broad search: NHTSA's recall files carry no such flag.",
              ),
          })
          .describe('A single recall campaign'),
      )
      .describe('Matching recall campaigns; in a broad search, one page of them'),
    totalCount: z
      .number()
      .describe('Total recalls matching criteria; in a broad search, across every page'),
    returned: z.number().optional().describe('Broad search only: campaigns in this page'),
    offset: z
      .number()
      .optional()
      .describe('Broad search only: pagination offset used for this page'),
    limit: z.number().optional().describe('Broad search only: pagination limit used for this page'),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The search key used: campaign number, "make model modelYear" for a vehicle lookup, or the broad-search filters as key=value pairs with make and model uppercased as matched, plus any active date bounds.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no recalls match: for a vehicle lookup, how to list the other model names NHTSA may file its recalls under with nhtsa_lookup_vehicles operation="dataset_models"; for a broad search, which filters to relax. Also explains a date range that excluded every recall, a broad-search page past the last match, and a limit lowered to the page maximum.',
      ),
  },
  errors: [
    {
      reason: 'mode_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'campaignNumber was combined with make, model, or modelYear; or limit or offset was sent with campaignNumber or a full make + model + modelYear lookup.',
      recovery: 'Use either campaignNumber or make + model + modelYear, not both.',
    },
    {
      reason: 'missing_required_combo',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No campaignNumber, make, model, modelYear, or active dateRange bound was supplied.',
      recovery:
        'Provide a campaignNumber, or at least one of make, model, modelYear, or a dateRange bound; make, model, and modelYear together look up one vehicle.',
    },
    {
      reason: 'limit_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `limit exceeds the ${PAGE.maxLimit}-row page maximum on a server set to reject an over-maximum limit rather than lower it.`,
      recovery: `Request a limit of ${PAGE.maxLimit} or less and page through the rest with offset.`,
    },
    {
      reason: 'campaign_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The campaignNumber did not match any NHTSA recall.',
      recovery: 'Verify the campaign number format like 24V744000, or query by vehicle.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A dateRange bound is not a calendar-valid YYYY-MM-DD date.',
      recovery: 'Use calendar-valid YYYY-MM-DD dates such as 2025-01-01.',
      thrownBy: 'service',
    },
    {
      reason: 'inverted_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dateRange.after is later than dateRange.before.',
      recovery: 'Set after on or before before, or omit a bound.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getNhtsaService();
    input = {
      ...input,
      campaignNumber: input.campaignNumber?.trim() || undefined,
      make: input.make?.trim() || undefined,
      model: input.model?.trim() || undefined,
    };
    const dateRange = normalizeDateRange(input.dateRange, 'dateRange');
    const dateQuery = describeDateRange('dateRange', dateRange);

    if (input.campaignNumber && (input.make || input.model || input.modelYear)) {
      throw ctx.fail(
        'mode_conflict',
        'Provide either campaignNumber OR make/model/modelYear, not both.',
      );
    }
    const vehicle =
      input.make && input.model && input.modelYear != null
        ? { make: input.make, model: input.model, modelYear: input.modelYear }
        : undefined;
    if (
      (input.campaignNumber || vehicle) &&
      (input.limit !== undefined || input.offset !== undefined)
    ) {
      throw ctx.fail(
        'mode_conflict',
        'limit and offset page a broad search only; a campaignNumber or full make + model + modelYear lookup returns every match at once.',
        {
          recovery: {
            hint: 'Drop limit and offset to get every match at once, or page a broad search instead: replace campaignNumber with make, model, modelYear, or a dateRange bound, or leave one of make, model, and modelYear out of a vehicle lookup.',
          },
        },
      );
    }

    // Campaign number lookup; a 6-character number can cover several campaigns
    if (input.campaignNumber) {
      const campaigns = await svc.getRecallCampaigns(input.campaignNumber, ctx.signal);
      ctx.log.info('Campaign lookup', {
        campaignNumber: input.campaignNumber,
        campaigns: campaigns.length,
      });

      if (campaigns.length === 0) {
        throw ctx.fail(
          'campaign_not_found',
          `No recall found for campaign "${input.campaignNumber}". Verify the campaign number format (e.g., "24V744000").`,
        );
      }

      ctx.enrich({ effectiveQuery: [input.campaignNumber, dateQuery].filter(Boolean).join(' ') });
      const recalls = campaigns
        .filter((campaign) => matchesDateRange(campaign.receivedDate, dateRange))
        .map((campaign) => ({
          campaignNumber: campaign.campaignNumber,
          manufacturer: campaign.manufacturer,
          component: campaign.component,
          ...(campaign.summary !== undefined ? { summary: campaign.summary } : {}),
          ...(campaign.consequence !== undefined ? { consequence: campaign.consequence } : {}),
          ...(campaign.remedy !== undefined ? { remedy: campaign.remedy } : {}),
          reportReceivedDate: campaign.receivedDate,
          ...(campaign.potentialUnitsAffected !== undefined
            ? { potentialUnitsAffected: campaign.potentialUnitsAffected }
            : {}),
          affectedVehicles: campaign.affectedVehicles,
          ...(campaign.investigationId !== undefined
            ? { investigationId: campaign.investigationId }
            : {}),
          ...(campaign.parkIt !== undefined ? { parkIt: campaign.parkIt } : {}),
          ...(campaign.parkOutSide !== undefined ? { parkOutSide: campaign.parkOutSide } : {}),
          ...(campaign.overTheAirUpdate !== undefined
            ? { overTheAirUpdate: campaign.overTheAirUpdate }
            : {}),
        }));
      if (recalls.length === 0)
        ctx.enrich.notice(
          campaigns.length === 1
            ? 'The campaign exists, but no recalls match the date range. Broaden or remove the date bounds.'
            : `The campaign number covers ${campaigns.length} campaigns, but none match the date range. Broaden or remove the date bounds.`,
        );
      return { recalls, totalCount: recalls.length };
    }

    // Vehicle-scoped lookup
    if (vehicle) {
      const all = await svc.getRecallsByVehicle(
        vehicle.make,
        vehicle.model,
        vehicle.modelYear,
        ctx.signal,
      );

      const recalls = all.filter((r) => matchesDateRange(r.reportReceivedDate, dateRange));

      ctx.log.info('Vehicle recall search', {
        make: vehicle.make,
        model: vehicle.model,
        modelYear: vehicle.modelYear,
        count: recalls.length,
      });

      const effectiveQuery = [`${vehicle.make} ${vehicle.model} ${vehicle.modelYear}`, dateQuery]
        .filter(Boolean)
        .join(' ');
      ctx.enrich({ effectiveQuery });
      if (all.length > 0 && recalls.length === 0) {
        ctx.enrich.notice(
          'The vehicle has recalls, but none match the date range. Broaden or remove the date bounds.',
        );
      } else if (all.length === 0) {
        ctx.enrich.notice(
          'No recalls found. This vehicle may have no recalls on file, or NHTSA may list them under another model name, such as a series name or a base name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search recalls under each.',
        );
      }

      return { recalls, totalCount: recalls.length };
    }

    // Broad search of the recall flat files
    const { make, model, modelYear } = input;
    const filters = [
      ...(make ? ['make'] : []),
      ...(model ? ['model'] : []),
      ...(modelYear != null ? ['modelYear'] : []),
      ...(dateRange ? ['dateRange'] : []),
    ];
    if (filters.length === 0) {
      throw ctx.fail(
        'missing_required_combo',
        "Provide campaignNumber for one recall, make + model + modelYear for one vehicle's recalls, or at least one of make, model, modelYear, or a dateRange bound to search every campaign.",
      );
    }
    const pageLimit = resolveLimit(ctx, PAGE, input.limit);
    if (pageLimit.kind === 'rejected') {
      throw ctx.fail('limit_too_large', limitTooLargeMessage(pageLimit));
    }
    const limit = pageLimit.applied;
    const offset = input.offset ?? 0;
    const { recalls, totalCount } = await svc.searchRecallFiles(
      { make, model, modelYear, dateRange, limit, offset },
      ctx.signal,
    );

    ctx.log.info('Broad recall search', {
      make,
      model,
      modelYear,
      dateQuery,
      total: totalCount,
      returned: recalls.length,
      offset,
      limit,
    });

    ctx.enrich({
      effectiveQuery: [
        make && `make=${make.toUpperCase()}`,
        model && `model=${model.toUpperCase()}`,
        modelYear != null && `modelYear=${modelYear}`,
        dateQuery,
      ]
        .filter(Boolean)
        .join(' '),
    });
    const notices: string[] = [];
    const clamped = limitClampNotice(pageLimit, { offset, returned: recalls.length, totalCount });
    if (clamped) notices.push(clamped);
    if (totalCount === 0) {
      notices.push(noMatchNotice(filters, Boolean(make || model)));
    } else if (recalls.length === 0) {
      notices.push(outOfBoundsMessage({ offset, limit, totalCount }));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { recalls, totalCount, returned: recalls.length, offset, limit };
  },

  format: (result) => {
    const page = formatPage(result);
    if (result.totalCount === 0) {
      const none = 'No recalls found matching the search criteria.';
      return [{ type: 'text' as const, text: page ? `${none}\n\n${page}` : none }];
    }

    const lines = [`**${result.totalCount} recall(s) found**\n`];
    if (page) lines.push(page);
    for (const r of result.recalls) {
      const alerts: string[] = [];
      if (r.parkIt) alerts.push('DO NOT DRIVE');
      if (r.parkOutSide) alerts.push('PARK OUTSIDE');
      if (r.overTheAirUpdate) alerts.push('OTA update available');
      const alertStr = alerts.length > 0 ? ` [${alerts.join(', ')}]` : '';

      lines.push(`### ${r.campaignNumber}${alertStr}`);
      if (r.component) lines.push(`**Component:** ${r.component}`);
      if (r.potentialUnitsAffected != null) {
        lines.push(`**Units Affected:** ${r.potentialUnitsAffected}`);
      }
      lines.push(`**Date:** ${r.reportReceivedDate}`);
      lines.push(`**Manufacturer:** ${r.manufacturer}`);
      lines.push(`**Advisories:** ${formatRecallAdvisories(r)}`);
      if (r.investigationId) {
        lines.push(
          `**Investigation:** ${r.investigationId} — pass as nhtsaId to nhtsa_search_investigations`,
        );
      }
      if (r.affectedVehicles && r.affectedVehicles.length > 0) {
        lines.push(`**Affected Vehicles (${r.affectedVehicles.length}):**`);
        for (const v of r.affectedVehicles) {
          lines.push(`- ${[v.modelYear, v.make, v.model].filter(Boolean).join(' ')}`);
        }
      }
      lines.push(`\n${r.summary ?? 'Summary: Not available'}`);
      lines.push(`\n**Consequence:** ${r.consequence ?? 'Not available'}`);
      lines.push(`**Remedy:** ${r.remedy ?? 'Not available'}\n`);
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

/**
 * A broad search's page line, with the next offset while matches remain past it. Undefined for
 * the lookups, which return every match at once and carry no paging fields.
 */
function formatPage(result: {
  limit?: number | undefined;
  offset?: number | undefined;
  returned?: number | undefined;
  totalCount: number;
}): string | undefined {
  const { limit, offset, returned, totalCount } = result;
  const parts = [
    returned !== undefined && `returned ${returned} of ${totalCount}`,
    offset !== undefined && `offset ${offset}`,
    limit !== undefined && `limit ${limit}`,
  ].filter(Boolean);
  if (parts.length === 0) return;
  const line = `**Page:** ${parts.join(', ')}, newest received date first\n`;
  const nextPage = nextPageHint({ offset: offset ?? 0, returned: returned ?? 0, totalCount });
  return nextPage ? `${line}\n${nextPage}` : line;
}
