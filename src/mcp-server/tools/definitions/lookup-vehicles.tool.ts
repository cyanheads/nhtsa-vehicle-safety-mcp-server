/**
 * @fileoverview Look up valid makes, models, vehicle types, and manufacturer details
 * from NHTSA's VPIC database. Consolidates several reference endpoints.
 * @module mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService, MANUFACTURER_RESULT_CAP } from '@/services/nhtsa/nhtsa-service.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export const lookupVehicles = tool('nhtsa_lookup_vehicles', {
  description:
    "Look up valid makes, models, and vehicle types in NHTSA's database. Use to resolve ambiguous vehicle names, find correct make/model spelling, or discover what models a manufacturer produces.",
  annotations: { readOnlyHint: true },
  input: z.object({
    operation: z
      .enum(['makes', 'models', 'vehicle_types', 'manufacturer'])
      .describe(
        `"makes" (all NHTSA makes), "models" (models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details).`,
      ),
    make: z
      .string()
      .optional()
      .describe('Make name (required for "models" and "vehicle_types"). Partial match supported.'),
    modelYear: z
      .number()
      .optional()
      .describe('Filter models to a specific year. Only for "models" operation.'),
    manufacturer: z
      .string()
      .optional()
      .describe('Manufacturer name or ID (for "manufacturer" operation). Partial match supported.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max results in the returned slice. Defaults to ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
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
        'Results retrieved before pagination. For "manufacturer" this is capped — check the truncated field, since VPIC reports no match total.',
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
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('The operation with key args, e.g. "models make=Toyota year=2020".'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the result set is empty or the page is out of bounds.'),
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
  errors: [
    {
      reason: 'missing_operation_arg',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A required argument for the chosen operation was not provided.',
      recovery: 'Supply the argument required by the operation: make, or manufacturer.',
    },
  ],

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;

    const emptyMessage = (subject: string, recovery: string): string =>
      `No ${subject} found. ${recovery}`;

    const outOfBoundsMessage = (totalCount: number): string =>
      `No results for this page (offset ${offset}, limit ${limit}). ${totalCount} total — try a smaller offset.`;

    switch (input.operation) {
      case 'makes': {
        const all = await svc.getAllMakes(ctx.signal);
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('VPIC makes lookup', {
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        ctx.enrich({ effectiveQuery: `makes offset=${offset} limit=${limit}` });
        if (all.length > 0 && slice.length === 0) {
          ctx.enrich.notice(outOfBoundsMessage(all.length));
        }
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
          throw ctx.fail(
            'missing_operation_arg',
            '"make" is required for the "models" operation.',
            { ...ctx.recoveryFor('missing_operation_arg') },
          );
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
        if (all.length === 0) {
          ctx.enrich.notice(
            emptyMessage(
              `models for make "${input.make}"${input.modelYear ? ` for model year ${input.modelYear}` : ''}`,
              'Verify the make spelling with operation="makes" — partial matches are supported.',
            ),
          );
        } else if (slice.length === 0) {
          ctx.enrich.notice(outOfBoundsMessage(all.length));
        }
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
            { ...ctx.recoveryFor('missing_operation_arg') },
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
        if (all.length === 0) {
          ctx.enrich.notice(
            emptyMessage(
              `vehicle types for make "${input.make}"`,
              'Verify the make spelling with operation="makes".',
            ),
          );
        } else if (slice.length === 0) {
          ctx.enrich.notice(outOfBoundsMessage(all.length));
        }
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
            { ...ctx.recoveryFor('missing_operation_arg') },
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

        const notices: string[] = [];
        if (all.length === 0) {
          notices.push(
            emptyMessage(
              `manufacturers matching "${input.manufacturer}"`,
              'Partial matches are supported — try a shorter or different query.',
            ),
          );
        } else if (slice.length === 0) {
          notices.push(outOfBoundsMessage(all.length));
        }
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
    }
  },

  format: (result) => {
    if (result.returned === 0) {
      return [
        {
          type: 'text' as const,
          text: `No results for "${result.operation}" lookup. Check the spelling of the make/manufacturer name — partial matches are supported.`,
        },
      ];
    }

    const lines = [`**${result.totalCount} ${result.operation} result(s)**\n`];
    lines.push(
      `*Showing ${result.returned} of ${result.totalCount} (offset ${result.offset}, limit ${result.limit})*\n`,
    );

    if (result.makes) {
      for (const m of result.makes) {
        lines.push(`- ${m.makeName} (ID: ${m.makeId})`);
      }
    }

    if (result.models) {
      for (const m of result.models) {
        lines.push(
          `- **${m.modelName}** — ${m.makeName} (Model ID: ${m.modelId}, Make ID: ${m.makeId})`,
        );
      }
    }

    if (result.vehicleTypes) {
      for (const vt of result.vehicleTypes) {
        lines.push(`- ${vt.vehicleTypeName} (ID: ${vt.vehicleTypeId})`);
      }
    }

    if (result.manufacturers) {
      for (const m of result.manufacturers) {
        lines.push(`### ${m.manufacturerName} (Manufacturer ID: ${m.manufacturerId})`);
        lines.push(`**Country:** ${m.country ?? 'Not available'}`);
        if (m.vehicleTypes.length > 0) {
          lines.push(
            `**Vehicle Types:** ${m.vehicleTypes.map((vt) => `${vt.name} (ID: ${vt.id ?? 'N/A'})`).join(', ')}`,
          );
        }
        lines.push('');
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
