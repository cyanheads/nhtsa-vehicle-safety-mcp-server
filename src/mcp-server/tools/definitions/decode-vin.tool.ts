/**
 * @fileoverview Decode VINs to extract vehicle identification, specs, and safety equipment.
 * Supports single VINs and batch decode (up to 50).
 * @module mcp-server/tools/definitions/decode-vin.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

const MAX_BATCH_SIZE = 50;

const decodedVinSchema = z.object({
  vin: z.string().describe('The decoded VIN'),
  make: z.string().describe('Vehicle manufacturer'),
  model: z.string().describe('Vehicle model'),
  modelYear: z.string().describe('Model year'),
  bodyClass: z.string().describe('Body class (e.g., "Sedan/Saloon", "SUV")'),
  vehicleType: z.string().describe('Vehicle type (e.g., "PASSENGER CAR")'),
  driveType: z.string().describe('Drive type (e.g., "FWD", "AWD")'),
  engineCylinders: z.string().describe('Number of engine cylinders'),
  engineDisplacementL: z.string().describe('Engine displacement in liters'),
  engineHP: z.string().describe('Engine horsepower'),
  fuelType: z.string().describe('Primary fuel type'),
  trim: z.string().describe('Trim level'),
  manufacturer: z.string().describe('Full manufacturer name'),
  plantCity: z.string().describe('Manufacturing plant city'),
  plantState: z.string().describe('Manufacturing plant state'),
  plantCountry: z.string().describe('Manufacturing plant country'),
  airBagLocFront: z.string().describe('Front airbag locations'),
  airBagLocSide: z.string().describe('Side airbag locations'),
  airBagLocCurtain: z.string().describe('Curtain airbag info'),
  airBagLocKnee: z.string().describe('Knee airbag info'),
  electronicStabilityControl: z.string().describe('ESC availability'),
  abs: z.string().describe('ABS availability'),
  tractionControl: z.string().describe('Traction control availability'),
  errorCode: z.string().describe('VPIC error code (0 = no error)'),
  errorText: z.string().describe('VPIC error/warning text'),
});

export const decodeVin = tool('nhtsa_decode_vin', {
  description:
    'Decode a Vehicle Identification Number to extract make, model, year, body type, engine, safety equipment, and manufacturing details. Supports single VINs or batch decode (up to 50). Partial VINs accepted — use * for unknown positions.',
  annotations: { readOnlyHint: true },
  input: z.object({
    vin: z
      .union([z.string(), z.array(z.string())])
      .describe(
        'A single 17-character VIN (e.g., "1HGCM82633A004352") or an array of up to 50 VINs for batch decode. Partial VINs accepted — use * for unknown positions.',
      ),
    modelYear: z
      .number()
      .optional()
      .describe('Helps resolve ambiguity for pre-1980 VINs or partial VINs.'),
  }),
  output: z.object({
    vehicles: z.array(decodedVinSchema).describe('Decoded vehicle information per VIN'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const vins = Array.isArray(input.vin) ? input.vin : [input.vin];

    if (vins.length > MAX_BATCH_SIZE) {
      throw validationError(`Maximum ${MAX_BATCH_SIZE} VINs per batch. Received ${vins.length}.`);
    }

    const [firstVin] = vins;
    const vehicles =
      firstVin && vins.length === 1
        ? [await svc.decodeVin(firstVin, input.modelYear)]
        : await svc.decodeVinBatch(
            vins.map((vin) =>
              input.modelYear != null ? { vin, modelYear: input.modelYear } : { vin },
            ),
          );

    ctx.log.info('VIN decode', { count: vins.length, results: vehicles.length });

    return { vehicles };
  },

  format: (result) => {
    if (result.vehicles.length === 0) {
      return [{ type: 'text' as const, text: 'No VIN decode results.' }];
    }

    const lines: string[] = [];
    for (const v of result.vehicles) {
      lines.push(`## ${v.vin}\n`);

      const hasError = v.errorCode !== '0' && v.errorCode !== '';
      if (hasError) {
        lines.push(`**Warning:** ${v.errorText}\n`);
      }

      lines.push(`**${v.modelYear} ${v.make} ${v.model}**${v.trim ? ` ${v.trim}` : ''}`);
      lines.push(`${v.bodyClass} | ${v.vehicleType}`);
      lines.push(`${v.driveType}\n`);

      // Engine
      const engineParts = [
        v.engineCylinders ? `${v.engineCylinders}-cyl` : '',
        v.engineDisplacementL ? `${v.engineDisplacementL}L` : '',
        v.engineHP ? `${v.engineHP} HP` : '',
        v.fuelType,
      ].filter(Boolean);
      if (engineParts.length > 0) {
        lines.push(`**Engine:** ${engineParts.join(', ')}`);
      }

      // Manufacturing
      const plant = [v.plantCity, v.plantState, v.plantCountry].filter(Boolean).join(', ');
      if (plant) lines.push(`**Manufactured:** ${plant}`);
      if (v.manufacturer) lines.push(`**Manufacturer:** ${v.manufacturer}`);

      // Safety equipment
      lines.push('\n**Safety Equipment:**');
      if (v.airBagLocFront) lines.push(`- Front airbags: ${v.airBagLocFront}`);
      if (v.airBagLocSide) lines.push(`- Side airbags: ${v.airBagLocSide}`);
      if (v.airBagLocCurtain) lines.push(`- Curtain airbags: ${v.airBagLocCurtain}`);
      if (v.airBagLocKnee) lines.push(`- Knee airbags: ${v.airBagLocKnee}`);
      if (v.electronicStabilityControl) lines.push(`- ESC: ${v.electronicStabilityControl}`);
      if (v.abs) lines.push(`- ABS: ${v.abs}`);
      if (v.tractionControl) lines.push(`- Traction control: ${v.tractionControl}`);
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
