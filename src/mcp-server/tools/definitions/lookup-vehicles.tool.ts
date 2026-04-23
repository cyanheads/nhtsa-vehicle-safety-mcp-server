/**
 * @fileoverview Look up valid makes, models, vehicle types, and manufacturer details
 * from NHTSA's VPIC database. Consolidates several reference endpoints.
 * @module mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

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
    totalCount: z.number().describe('Total results matching before pagination'),
    returned: z.number().describe('Number of results in the returned slice'),
    offset: z.number().describe('Pagination offset used for this response'),
    limit: z.number().describe('Pagination limit used for this response'),
    message: z
      .string()
      .optional()
      .describe('Contextual guidance populated when the result set is empty'),
    makes: z
      .array(
        z.object({
          makeId: z.number().describe('VPIC make ID'),
          makeName: z.string().describe('Make name'),
        }),
      )
      .optional()
      .describe('Results for "makes" operation'),
    models: z
      .array(
        z.object({
          modelId: z.number().describe('VPIC model ID'),
          modelName: z.string().describe('Model name'),
          makeId: z.number().describe('VPIC make ID'),
          makeName: z.string().describe('Make name'),
        }),
      )
      .optional()
      .describe('Results for "models" operation'),
    vehicleTypes: z
      .array(
        z.object({
          vehicleTypeId: z.number().describe('Vehicle type ID'),
          vehicleTypeName: z.string().describe('Vehicle type name'),
        }),
      )
      .optional()
      .describe('Results for "vehicle_types" operation'),
    manufacturers: z
      .array(
        z.object({
          manufacturerId: z.number().describe('Manufacturer ID'),
          manufacturerName: z.string().describe('Manufacturer name'),
          country: z.string().optional().describe('Country of origin when provided'),
          vehicleTypes: z
            .array(
              z.object({
                id: z.number().optional().describe('Vehicle type ID'),
                name: z.string().describe('Vehicle type name'),
              }),
            )
            .describe('Vehicle types produced'),
        }),
      )
      .optional()
      .describe('Results for "manufacturer" operation'),
  }),

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
        const message =
          all.length > 0 && slice.length === 0 ? outOfBoundsMessage(all.length) : undefined;
        return {
          operation: 'makes',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          makes: slice,
          ...(message ? { message } : {}),
        };
      }

      case 'models': {
        if (!input.make) {
          throw validationError('"make" is required for the "models" operation.');
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
        const yearPart = input.modelYear ? ` for model year ${input.modelYear}` : '';
        const message =
          all.length === 0
            ? emptyMessage(
                `models for make "${input.make}"${yearPart}`,
                'Verify the make spelling with operation="makes" — partial matches are supported.',
              )
            : slice.length === 0
              ? outOfBoundsMessage(all.length)
              : undefined;
        return {
          operation: 'models',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          models: slice,
          ...(message ? { message } : {}),
        };
      }

      case 'vehicle_types': {
        if (!input.make) {
          throw validationError('"make" is required for the "vehicle_types" operation.');
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
        const message =
          all.length === 0
            ? emptyMessage(
                `vehicle types for make "${input.make}"`,
                'Verify the make spelling with operation="makes".',
              )
            : slice.length === 0
              ? outOfBoundsMessage(all.length)
              : undefined;
        return {
          operation: 'vehicle_types',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          vehicleTypes: slice,
          ...(message ? { message } : {}),
        };
      }

      case 'manufacturer': {
        if (!input.manufacturer) {
          throw validationError('"manufacturer" is required for the "manufacturer" operation.');
        }
        const all = await svc.getManufacturer(input.manufacturer, ctx.signal);
        const slice = all.slice(offset, offset + limit);
        ctx.log.info('VPIC manufacturer lookup', {
          manufacturer: input.manufacturer,
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
        });
        const message =
          all.length === 0
            ? emptyMessage(
                `manufacturers matching "${input.manufacturer}"`,
                'Partial matches are supported — try a shorter or different query.',
              )
            : slice.length === 0
              ? outOfBoundsMessage(all.length)
              : undefined;
        return {
          operation: 'manufacturer',
          totalCount: all.length,
          returned: slice.length,
          offset,
          limit,
          manufacturers: slice,
          ...(message ? { message } : {}),
        };
      }
    }
  },

  format: (result) => {
    if (result.returned === 0) {
      return [
        {
          type: 'text' as const,
          text:
            result.message ??
            `No results for "${result.operation}" lookup. Check the spelling of the make/manufacturer name — partial matches are supported.`,
        },
      ];
    }

    const lines = [`**${result.totalCount} ${result.operation} result(s)**\n`];
    lines.push(
      `*Showing ${result.returned} of ${result.totalCount} (offset ${result.offset}, limit ${result.limit})*\n`,
    );
    if (result.message) lines.push(`*${result.message}*\n`);

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
