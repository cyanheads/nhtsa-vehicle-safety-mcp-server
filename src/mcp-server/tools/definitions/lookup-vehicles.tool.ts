/**
 * @fileoverview Look up valid makes, models, vehicle types, and manufacturer details from
 * NHTSA's VPIC database, and the model names NHTSA's complaint, NCAP, VPIC, and recall lists
 * file a make and model year under.
 * @module mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  limitClampNotice,
  limitSchema,
  limitTooLargeMessage,
  type PageLimit,
  resolveLimit,
} from '@/mcp-server/tools/request-cap.js';
import { formatText, outOfBoundsMessage, renderNotice } from '@/services/nhtsa/format.js';
import { getNhtsaService, MANUFACTURER_RESULT_CAP } from '@/services/nhtsa/nhtsa-service.js';
import {
  DATASET_MODEL_LISTS,
  type DatasetModel,
  type DatasetModelList,
} from '@/services/nhtsa/types.js';

const PAGE = {
  tool: 'nhtsa_lookup_vehicles',
  defaultLimit: 100,
  maxLimit: 200,
} as const satisfies PageLimit;

/** The recovery every empty make-scoped lookup closes with. */
const VERIFY_MAKE =
  'Verify the make spelling with operation="makes", passing part of the name as make.';

/** The recovery for a name filter that matched nothing ("makes" with make, "manufacturer"). */
const PARTIAL_MATCH = 'Partial matches are supported — try a shorter or different query.';

/**
 * Merge the lists into one entry per name. Names match case-insensitively and render uppercase,
 * as the products and NCAP lists spell them; `listedBy` follows {@link DATASET_MODEL_LISTS}
 * order, and entries sort by name for stable paging.
 */
function mergeDatasetModels(lists: Record<DatasetModelList, string[]>): DatasetModel[] {
  const merged = new Map<string, DatasetModel>();
  for (const list of DATASET_MODEL_LISTS) {
    for (const name of lists[list]) {
      const modelName = name.trim().toUpperCase();
      if (!modelName) continue;
      const entry = merged.get(modelName) ?? { modelName, listedBy: [] };
      if (!entry.listedBy.includes(list)) entry.listedBy.push(list);
      merged.set(modelName, entry);
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.modelName < b.modelName ? -1 : a.modelName > b.modelName ? 1 : 0,
  );
}

export const lookupVehicles = tool('nhtsa_lookup_vehicles', {
  description: `Look up makes, models, vehicle types, and manufacturer details in NHTSA's VPIC catalog, or list the model names NHTSA's datasets file a make and model year under. To check a make's spelling, pass part of the name as make to operation="makes". VPIC names often differ from the names recalls, complaints, and NCAP ratings use (Silverado vs SILVERADO 1500), and one vehicle's recalls can be filed under several names. When a recall, complaint, or rating search comes back empty or partial, call operation="dataset_models" with make and modelYear, then search under each name it lists: recalls under the names tagged "recalls", complaints under "products", ratings under "ncap".`,
  annotations: { readOnlyHint: true },
  input: z.object({
    operation: z
      .enum(['makes', 'models', 'vehicle_types', 'manufacturer', 'dataset_models'])
      .describe(
        `"makes" (VPIC makes: all of them, or those whose name contains make), "models" (VPIC models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details), "dataset_models" (the model names NHTSA's complaint, NCAP, VPIC, and recall lists carry for a make and model year, each tagged with the lists carrying it; requires make and modelYear).`,
      ),
    make: z
      .string()
      .optional()
      .describe(
        'Make name. Required for "models", "vehicle_types", and "dataset_models"; optional for "makes", which then returns the makes whose name contains it ("mercedes" finds MERCEDES-BENZ). VPIC matches partial names in "models" and "vehicle_types"; "dataset_models" takes the full make name (e.g., "Chevrolet").',
      ),
    modelYear: z
      .number()
      .int()
      .optional()
      .describe(
        'Model year, a whole number. Filters "models" to that year; required for "dataset_models". Not accepted by other operations.',
      ),
    manufacturer: z
      .string()
      .optional()
      .describe('Manufacturer name or ID (for "manufacturer" operation). Partial match supported.'),
    limit: limitSchema()
      .optional()
      .describe(
        `Results per page. Defaults to ${PAGE.defaultLimit}; at most ${PAGE.maxLimit} per page.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Pagination offset into the full result list. Defaults to 0.'),
  }),
  output: z.object({
    operation: z.string().describe('The operation that was performed'),
    totalCount: z
      .number()
      .describe(
        'Matching results before pagination. For "manufacturer" this is capped — check the truncated field, since VPIC reports no match total.',
      ),
    returned: z.number().describe('Number of results in the returned slice'),
    offset: z.number().describe('Pagination offset used for this response'),
    limit: z.number().describe('Pagination limit used for this response'),
    makes: z
      .array(
        z
          .object({
            makeId: z.number().describe('VPIC make ID'),
            makeName: z.string().describe('Make name'),
          })
          .describe('A single make entry'),
      )
      .optional()
      .describe('Results for "makes" operation'),
    models: z
      .array(
        z
          .object({
            modelId: z.number().describe('VPIC model ID'),
            modelName: z.string().describe('Model name'),
            makeId: z.number().describe('VPIC make ID'),
            makeName: z.string().describe('Make name'),
          })
          .describe('A single model entry'),
      )
      .optional()
      .describe('Results for "models" operation'),
    vehicleTypes: z
      .array(
        z
          .object({
            vehicleTypeId: z.number().describe('Vehicle type ID'),
            vehicleTypeName: z.string().describe('Vehicle type name'),
          })
          .describe('A single vehicle-type entry'),
      )
      .optional()
      .describe('Results for "vehicle_types" operation'),
    manufacturers: z
      .array(
        z
          .object({
            manufacturerId: z.number().describe('Manufacturer ID'),
            manufacturerName: z.string().describe('Manufacturer name'),
            country: z.string().optional().describe('Country of origin when provided'),
            vehicleTypes: z
              .array(
                z
                  .object({
                    id: z.number().optional().describe('Vehicle type ID'),
                    name: z.string().describe('Vehicle type name'),
                  })
                  .describe('A single vehicle-type entry produced by this manufacturer'),
              )
              .describe('Vehicle types produced'),
          })
          .describe('A single manufacturer entry'),
      )
      .optional()
      .describe('Results for "manufacturer" operation'),
    datasetModels: z
      .array(
        z
          .object({
            modelName: z.string().describe('Model name, uppercase'),
            listedBy: z
              .array(z.enum(DATASET_MODEL_LISTS))
              .describe(
                'Lists carrying this name: "products" (the names complaint searches match), "ncap" (the names NCAP rating searches match), "vpic" (VPIC catalog names, as a decoded VIN reports them), "recalls" (the names on NHTSA\'s recall records, which recall searches match)',
              ),
          })
          .describe('A model name merged across the lists'),
      )
      .optional()
      .describe('Results for "dataset_models" operation, sorted by name'),
    unavailableLists: z
      .array(z.enum(DATASET_MODEL_LISTS))
      .optional()
      .describe(
        'Lists "dataset_models" could not load, so no entry carries their tag; absent when every list loaded. Only "recalls" can be missing: its files load in the background, and any other list failing fails the call.',
      ),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('The operation with key args, e.g. "models make=Toyota year=2020".'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the result set is empty, the page is out of bounds, limit was lowered to the page maximum, or a "dataset_models" list did not load.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the "manufacturer" lookup stopped at its retrieval cap and further matches may exist upstream.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Manufacturer records retrieved before pagination, when the cap was reached.'),
    cap: z.number().optional().describe('Maximum manufacturer records a single lookup retrieves.'),
  },
  enrichmentTrailer: { notice: { render: renderNotice } },
  errors: [
    {
      reason: 'inactive_argument',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An argument is not used by the chosen operation.',
      recovery:
        'makes and vehicle_types accept make; models and dataset_models accept make/modelYear; manufacturer accepts manufacturer. Remove other filters.',
    },
    {
      reason: 'missing_operation_arg',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A required argument for the chosen operation was not provided.',
      recovery:
        'Supply the arguments the operation requires: make for models and vehicle_types, make and modelYear for dataset_models, manufacturer for manufacturer.',
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
      make: input.make?.trim() || undefined,
      manufacturer: input.manufacturer?.trim() || undefined,
    };
    const takesYear = input.operation === 'models' || input.operation === 'dataset_models';
    const takesMake =
      takesYear || input.operation === 'vehicle_types' || input.operation === 'makes';
    const inactive = [
      input.make && !takesMake ? 'make' : null,
      input.modelYear != null && !takesYear ? 'modelYear' : null,
      input.manufacturer && input.operation !== 'manufacturer' ? 'manufacturer' : null,
    ].filter(Boolean);
    if (inactive.length > 0) {
      throw ctx.fail(
        'inactive_argument',
        `The ${input.operation} operation does not accept ${inactive.join(', ')}.`,
      );
    }

    const pageLimit = resolveLimit(ctx, PAGE, input.limit);
    if (pageLimit.kind === 'rejected') {
      throw ctx.fail('limit_too_large', limitTooLargeMessage(pageLimit));
    }
    const limit = pageLimit.applied;

    const emptyMessage = (subject: string, recovery: string): string =>
      `No ${subject} found. ${recovery}`;

    /**
     * The call's notices in reading order: the clamp disclosure, then the empty or out-of-range
     * page. `notice` is last-wins, so each branch joins these into one. `empty` is omitted where
     * an empty result needs no recovery.
     */
    const pageNotices = (totalCount: number, returned: number, empty?: string): string[] => {
      const notices: string[] = [];
      const clamped = limitClampNotice(pageLimit, { offset, returned, totalCount });
      if (clamped) notices.push(clamped);
      if (totalCount === 0) {
        if (empty) notices.push(empty);
      } else if (returned === 0) {
        notices.push(outOfBoundsMessage({ offset, limit, totalCount }));
      }
      return notices;
    };

    switch (input.operation) {
      case 'makes': {
        /**
         * VPIC has no make search, so `make` filters the full list it already returns: a name
         * containing the filter matches, both uppercased as `dataset_models` compares make names.
         */
        const makes = await svc.getAllMakes(ctx.signal);
        const filter = input.make?.toUpperCase();
        const all = filter ? makes.filter((m) => m.makeName.toUpperCase().includes(filter)) : makes;
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('VPIC makes lookup', {
          make: input.make,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        const makePart = input.make ? ` make=${input.make}` : '';
        ctx.enrich({ effectiveQuery: `makes${makePart} offset=${offset} limit=${limit}` });
        const notices = pageNotices(
          all.length,
          slice.length,
          input.make ? emptyMessage(`makes matching "${input.make}"`, PARTIAL_MATCH) : undefined,
        );
        if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
        return {
          operation: 'makes',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          makes: slice,
        };
      }

      case 'models': {
        if (!input.make) {
          throw ctx.fail('missing_operation_arg', '"make" is required for the "models" operation.');
        }
        const all = await svc.getModels(input.make, input.modelYear, ctx.signal);
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('VPIC models lookup', {
          make: input.make,
          modelYear: input.modelYear,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        const yearPart = input.modelYear ? ` year=${input.modelYear}` : '';
        ctx.enrich({ effectiveQuery: `models make=${input.make}${yearPart}` });
        const notices = pageNotices(
          all.length,
          slice.length,
          emptyMessage(
            `models for make "${input.make}"${input.modelYear ? ` for model year ${input.modelYear}` : ''}`,
            VERIFY_MAKE,
          ),
        );
        if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
        return {
          operation: 'models',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          models: slice,
        };
      }

      case 'vehicle_types': {
        if (!input.make) {
          throw ctx.fail(
            'missing_operation_arg',
            '"make" is required for the "vehicle_types" operation.',
          );
        }
        const all = await svc.getVehicleTypes(input.make, ctx.signal);
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('VPIC vehicle types lookup', {
          make: input.make,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        ctx.enrich({ effectiveQuery: `vehicle_types make=${input.make}` });
        const notices = pageNotices(
          all.length,
          slice.length,
          emptyMessage(`vehicle types for make "${input.make}"`, VERIFY_MAKE),
        );
        if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
        return {
          operation: 'vehicle_types',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          vehicleTypes: slice,
        };
      }

      case 'manufacturer': {
        if (!input.manufacturer) {
          throw ctx.fail(
            'missing_operation_arg',
            '"manufacturer" is required for the "manufacturer" operation.',
          );
        }
        const all = await svc.getManufacturer(input.manufacturer, ctx.signal);
        const slice = all.slice(offset, offset + limit);
        const capped = all.length >= MANUFACTURER_RESULT_CAP;
        ctx.log.info('VPIC manufacturer lookup', {
          manufacturer: input.manufacturer,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          capped,
        });
        ctx.enrich({ effectiveQuery: `manufacturer=${input.manufacturer}` });

        const notices = pageNotices(
          all.length,
          slice.length,
          emptyMessage(`manufacturers matching "${input.manufacturer}"`, PARTIAL_MATCH),
        );
        if (capped) {
          /**
           * VPIC pages this endpoint and publishes no match total, so the walk stops at a
           * fixed ceiling. Disclose it rather than presenting the retrieved set as complete.
           */
          notices.push(
            `Retrieval stopped at ${MANUFACTURER_RESULT_CAP} records for "${input.manufacturer}" — VPIC publishes no match total, so more may exist. Narrow with a longer or more specific manufacturer name to reach them.`,
          );
          ctx.enrich.truncated({
            shown: all.length,
            cap: MANUFACTURER_RESULT_CAP,
            guidance: notices.join(' '),
          });
        } else if (notices.length > 0) {
          ctx.enrich.notice(notices.join(' '));
        }
        return {
          operation: 'manufacturer',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          manufacturers: slice,
        };
      }

      case 'dataset_models': {
        const { make, modelYear } = input;
        if (!make || modelYear == null) {
          const missing = [!make && '"make"', modelYear == null && '"modelYear"'].filter(Boolean);
          throw ctx.fail(
            'missing_operation_arg',
            `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required for the "dataset_models" operation.`,
          );
        }
        /**
         * An API list that fails to load fails the call, since a missing tag would read as "not
         * listed", and aborts the call's other waits with its own error as the reason, so the
         * call fails with that error whichever wait rejects first. The recall list is
         * best-effort: the service bounds its wait on the shared recall-file load, and a load
         * still running or failed then leaves its tag out, disclosed in `unavailableLists`. A
         * caller abort rejects every wait, the recall one included, and fails the call.
         */
        const failed = new AbortController();
        const signal = AbortSignal.any([ctx.signal, failed.signal]);
        const load = <T>(request: Promise<T>) =>
          request.catch((error: unknown) => {
            failed.abort(error);
            throw error;
          });
        const [products, ncap, vpic, recalls] = await Promise.all([
          load(svc.getProductModels(make, modelYear, signal)),
          load(svc.getSafetyRatingModels(modelYear, make, signal)),
          load(svc.getModels(make, modelYear, signal)),
          svc.getRecallModelNames(make, modelYear, signal),
        ]);
        if (recalls.kind === 'failed') {
          ctx.log.warning('Recall files failed to load; omitting the recalls list', {
            make,
            modelYear,
            error: String(recalls.error),
          });
        }
        /**
         * VPIC matches make names partially ("Smart" also returns SMART TRAILERS, INC.), so keep
         * only the requested make's models, as the other lists hold.
         */
        const makeKey = make.toUpperCase();
        const all = mergeDatasetModels({
          products,
          ncap,
          vpic: vpic.filter((m) => m.makeName.toUpperCase() === makeKey).map((m) => m.modelName),
          recalls: recalls.kind === 'ready' ? recalls.value : [],
        });
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('Dataset model names lookup', {
          make,
          modelYear,
          products: products.length,
          ncap: ncap.length,
          vpic: vpic.length,
          recalls: recalls.kind === 'ready' ? recalls.value.length : recalls.kind,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        ctx.enrich({ effectiveQuery: `dataset_models make=${make} year=${modelYear}` });
        const notices = pageNotices(
          all.length,
          slice.length,
          `No model names found for make "${make}" in model year ${modelYear}. ${VERIFY_MAKE}`,
        );
        if (recalls.kind === 'pending') {
          notices.push(
            `The "recalls" list is missing: NHTSA's recall files are still loading, so no name here carries that tag. Call again in a minute to include it.`,
          );
        } else if (recalls.kind === 'failed') {
          notices.push(
            `The "recalls" list is missing: NHTSA's recall files failed to load, so no name here carries that tag. Call again later to include it.`,
          );
        }
        if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
        return {
          operation: 'dataset_models',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          datasetModels: slice,
          ...(recalls.kind === 'ready' ? {} : { unavailableLists: ['recalls' as const] }),
        };
      }
    }
  },

  format: (result) => {
    /** The lists `dataset_models` could not load, named on every page, empty ones included. */
    const unavailable = result.unavailableLists
      ? `**Unavailable lists:** ${result.unavailableLists.join(', ')}`
      : undefined;

    if (result.returned === 0) {
      /**
       * Two different empty states. Nothing matched, and the spelling hint is the recovery; or
       * the filters matched and only the page overshot, where the spelling hint names a problem
       * the caller does not have. The handler already draws this line for the enrichment
       * notice — drawing it here too keeps the two surfaces from disagreeing.
       */
      const summary =
        result.totalCount === 0
          ? `No results for "${result.operation}" lookup. Check the spelling of the make or manufacturer name.`
          : `**${result.totalCount} ${result.operation} result(s)** (showing 0, offset ${result.offset}, limit ${result.limit})`;
      return [
        { type: 'text' as const, text: unavailable ? `${summary}\n\n${unavailable}` : summary },
      ];
    }

    const lines = [`**${result.totalCount} ${result.operation} result(s)**\n`];
    lines.push(
      `*Showing ${result.returned} of ${result.totalCount} (offset ${result.offset}, limit ${result.limit})*\n`,
    );
    if (unavailable) lines.push(`${unavailable}\n`);

    if (result.makes) {
      for (const m of result.makes) {
        lines.push(`- ${escapeMarkdownInline(m.makeName)} (ID: ${m.makeId})`);
      }
    }

    if (result.models) {
      for (const m of result.models) {
        lines.push(
          `- **${escapeMarkdownInline(m.modelName)}** — ${escapeMarkdownInline(m.makeName)} (Model ID: ${m.modelId}, Make ID: ${m.makeId})`,
        );
      }
    }

    if (result.vehicleTypes) {
      for (const vt of result.vehicleTypes) {
        lines.push(`- ${escapeMarkdownInline(vt.vehicleTypeName)} (ID: ${vt.vehicleTypeId})`);
      }
    }

    if (result.manufacturers) {
      for (const m of result.manufacturers) {
        /** A heading holds one line, so the free-text name sits on its own labeled line. */
        lines.push(`### Manufacturer ${m.manufacturerId}`);
        lines.push(`**Name:** ${escapeMarkdownInline(m.manufacturerName)}`);
        lines.push(`**Country:** ${formatText(m.country)}`);
        if (m.vehicleTypes.length > 0) {
          /** Joined first and escaped once, so no separator can complete syntax a name started. */
          const vehicleTypes = m.vehicleTypes
            .map((vt) => `${vt.name} (ID: ${vt.id ?? 'N/A'})`)
            .join(', ');
          lines.push(`**Vehicle Types:** ${escapeMarkdownInline(vehicleTypes)}`);
        }
        lines.push('');
      }
    }

    if (result.datasetModels) {
      for (const m of result.datasetModels) {
        lines.push(
          `- **${escapeMarkdownInline(m.modelName)}** — listed by ${m.listedBy.join(', ')}`,
        );
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
