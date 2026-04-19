/**
 * @fileoverview Look up valid makes, models, vehicle types, and manufacturer details
 * from NHTSA's VPIC database. Consolidates several reference endpoints.
 * @module mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const DEFAULT_MAKES_LIMIT = 100;
const MAX_MAKES_LIMIT = 200;

export const lookupVehicles = tool('nhtsa_lookup_vehicles', {
  description:
    "Look up valid makes, models, and vehicle types in NHTSA's database. Use to resolve ambiguous vehicle names, find correct make/model spelling, or discover what models a manufacturer produces.",
  annotations: { readOnlyHint: true },
  input: z.object({
    operation: z
      .enum(['makes', 'models', 'vehicle_types', 'manufacturer'])
      .describe(
        `"makes" (paginated slice of all makes), "models" (models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details).`,
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
      .max(MAX_MAKES_LIMIT)
      .optional()
      .describe(
        `For "makes" only: maximum makes to return. Defaults to ${DEFAULT_MAKES_LIMIT}; max ${MAX_MAKES_LIMIT}. Ignored for other operations.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'For "makes" only: pagination offset into the full makes list. Defaults to 0. Ignored for other operations.',
      ),
  }),
  output: z.object({
    operation: z.string().describe('The operation that was performed'),
    count: z.number().describe('Number of results returned in this response'),
    totalAvailable: z
      .number()
      .optional()
      .describe('Total results available before pagination, when relevant'),
    offset: z.number().optional().describe('Pagination offset used for this response'),
    limit: z.number().optional().describe('Pagination limit used for this response'),
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

    switch (input.operation) {
      case 'makes': {
        const allMakes = await svc.getAllMakes();
        const limit = input.limit ?? DEFAULT_MAKES_LIMIT;
        const offset = input.offset ?? 0;
        const makes = allMakes.slice(offset, offset + limit);
        ctx.log.info('VPIC makes lookup', {
          total: allMakes.length,
          returned: makes.length,
          offset,
          limit,
        });
        return {
          operation: 'makes',
          count: makes.length,
          totalAvailable: allMakes.length,
          offset,
          limit,
          makes,
        };
      }

      case 'models': {
        if (!input.make) {
          throw validationError('"make" is required for the "models" operation.');
        }
        const models = await svc.getModels(input.make, input.modelYear);
        ctx.log.info('VPIC models lookup', {
          make: input.make,
          modelYear: input.modelYear,
          count: models.length,
        });
        const yearPart = input.modelYear ? ` for model year ${input.modelYear}` : '';
        const message =
          models.length === 0
            ? `No models found for make "${input.make}"${yearPart}. Verify the make spelling with operation="makes" — partial matches are supported.`
            : undefined;
        return {
          operation: 'models',
          count: models.length,
          models,
          ...(message ? { message } : {}),
        };
      }

      case 'vehicle_types': {
        if (!input.make) {
          throw validationError('"make" is required for the "vehicle_types" operation.');
        }
        const vehicleTypes = await svc.getVehicleTypes(input.make);
        ctx.log.info('VPIC vehicle types lookup', { make: input.make, count: vehicleTypes.length });
        const message =
          vehicleTypes.length === 0
            ? `No vehicle types found for make "${input.make}". Verify the make spelling with operation="makes".`
            : undefined;
        return {
          operation: 'vehicle_types',
          count: vehicleTypes.length,
          vehicleTypes,
          ...(message ? { message } : {}),
        };
      }

      case 'manufacturer': {
        if (!input.manufacturer) {
          throw validationError('"manufacturer" is required for the "manufacturer" operation.');
        }
        const manufacturers = await svc.getManufacturer(input.manufacturer);
        ctx.log.info('VPIC manufacturer lookup', {
          manufacturer: input.manufacturer,
          count: manufacturers.length,
        });
        const message =
          manufacturers.length === 0
            ? `No manufacturer matched "${input.manufacturer}". Partial matches are supported — try a shorter or different query.`
            : undefined;
        return {
          operation: 'manufacturer',
          count: manufacturers.length,
          manufacturers,
          ...(message ? { message } : {}),
        };
      }
    }
  },

  format: (result) => {
    if (result.count === 0) {
      if (result.operation === 'makes' && (result.totalAvailable ?? 0) > 0) {
        return [
          {
            type: 'text' as const,
            text: `No makes returned for this page. Total makes available: ${result.totalAvailable}. Try a smaller offset.`,
          },
        ];
      }
      return [
        {
          type: 'text' as const,
          text:
            result.message ??
            `No results for "${result.operation}" lookup. Check the spelling of the make/manufacturer name — partial matches are supported.`,
        },
      ];
    }

    const lines = [`**${result.count} result(s)**\n`];

    if (result.makes) {
      if ((result.totalAvailable ?? result.makes.length) > result.makes.length) {
        const start = (result.offset ?? 0) + 1;
        const end = (result.offset ?? 0) + result.makes.length;
        lines.push(
          `*Showing makes ${start}-${end} of ${result.totalAvailable}. Use limit/offset to page through the full list.*\n`,
        );
      }
      for (const m of result.makes) {
        lines.push(`- ${m.makeName} (ID: ${m.makeId})`);
      }
    }

    if (result.models) {
      for (const m of result.models) {
        lines.push(`- **${m.modelName}** — ${m.makeName} (Model ID: ${m.modelId})`);
      }
    }

    if (result.vehicleTypes) {
      for (const vt of result.vehicleTypes) {
        lines.push(`- ${vt.vehicleTypeName} (ID: ${vt.vehicleTypeId})`);
      }
    }

    if (result.manufacturers) {
      for (const m of result.manufacturers) {
        lines.push(`### ${m.manufacturerName}`);
        lines.push(`**Country:** ${m.country ?? 'Not available'}`);
        if (m.vehicleTypes.length > 0) {
          lines.push(`**Vehicle Types:** ${m.vehicleTypes.map((vt) => vt.name).join(', ')}`);
        }
        lines.push('');
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
