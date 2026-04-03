/**
 * @fileoverview Look up valid makes, models, vehicle types, and manufacturer details
 * from NHTSA's VPIC database. Consolidates several reference endpoints.
 * @module mcp-server/tools/definitions/lookup-vehicles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

export const lookupVehicles = tool('nhtsa_lookup_vehicles', {
  description:
    "Look up valid makes, models, and vehicle types in NHTSA's database. Use to resolve ambiguous vehicle names, find correct make/model spelling, or discover what models a manufacturer produces.",
  annotations: { readOnlyHint: true },
  input: z.object({
    operation: z
      .enum(['makes', 'models', 'vehicle_types', 'manufacturer'])
      .describe(
        '"makes" (all makes — warning: 12K+ results), "models" (models for a make), "vehicle_types" (types for a make), "manufacturer" (manufacturer details).',
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
  }),
  output: z.object({
    operation: z.string().describe('The operation that was performed'),
    count: z.number().describe('Number of results'),
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
          country: z.string().describe('Country of origin'),
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
        const makes = allMakes.slice(0, 200);
        ctx.log.info('VPIC makes lookup', { total: allMakes.length, returned: makes.length });
        return { operation: 'makes', count: allMakes.length, makes };
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
        return { operation: 'models', count: models.length, models };
      }

      case 'vehicle_types': {
        if (!input.make) {
          throw validationError('"make" is required for the "vehicle_types" operation.');
        }
        const vehicleTypes = await svc.getVehicleTypes(input.make);
        ctx.log.info('VPIC vehicle types lookup', { make: input.make, count: vehicleTypes.length });
        return { operation: 'vehicle_types', count: vehicleTypes.length, vehicleTypes };
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
        return { operation: 'manufacturer', count: manufacturers.length, manufacturers };
      }
    }
  },

  format: (result) => {
    if (result.count === 0) {
      return [
        {
          type: 'text' as const,
          text: `No results for "${result.operation}" lookup. Check the spelling of the make/manufacturer name — partial matches are supported.`,
        },
      ];
    }

    const lines = [`**${result.count} result(s)**\n`];

    if (result.makes) {
      if (result.count > 100) {
        lines.push(
          `*Showing first 100 of ${result.count} makes. Consider using "models" with a specific make instead.*\n`,
        );
      }
      for (const m of result.makes.slice(0, 100)) {
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
        lines.push(`**Country:** ${m.country || 'N/A'}`);
        if (m.vehicleTypes.length > 0) {
          lines.push(`**Vehicle Types:** ${m.vehicleTypes.map((vt) => vt.name).join(', ')}`);
        }
        lines.push('');
      }
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
