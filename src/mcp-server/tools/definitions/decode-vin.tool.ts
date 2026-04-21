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
  make: z.string().optional().describe('Vehicle manufacturer when provided by VPIC'),
  model: z.string().optional().describe('Vehicle model when provided by VPIC'),
  modelYear: z.string().optional().describe('Model year when provided by VPIC'),
  bodyClass: z.string().optional().describe('Body class (e.g., "Sedan/Saloon", "SUV")'),
  vehicleType: z.string().optional().describe('Vehicle type (e.g., "PASSENGER CAR")'),
  driveType: z.string().optional().describe('Drive type (e.g., "FWD", "AWD")'),
  engineCylinders: z.string().optional().describe('Number of engine cylinders'),
  engineDisplacementL: z.string().optional().describe('Engine displacement in liters'),
  engineHP: z.string().optional().describe('Engine horsepower'),
  fuelType: z.string().optional().describe('Primary fuel type'),
  trim: z.string().optional().describe('Trim level'),
  manufacturer: z.string().optional().describe('Full manufacturer name'),
  plantCity: z.string().optional().describe('Manufacturing plant city'),
  plantState: z.string().optional().describe('Manufacturing plant state'),
  plantCountry: z.string().optional().describe('Manufacturing plant country'),
  airBagLocFront: z.string().optional().describe('Front airbag locations'),
  airBagLocSide: z.string().optional().describe('Side airbag locations'),
  airBagLocCurtain: z.string().optional().describe('Curtain airbag info'),
  airBagLocKnee: z.string().optional().describe('Knee airbag info'),
  electronicStabilityControl: z.string().optional().describe('ESC availability'),
  abs: z.string().optional().describe('ABS availability'),
  tractionControl: z.string().optional().describe('Traction control availability'),
  errorCode: z.string().optional().describe('VPIC error code (0 = no error)'),
  errorText: z.string().optional().describe('VPIC error or warning text'),
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

    const nonEmpty = vins.filter((v) => v.trim().length > 0);
    if (nonEmpty.length === 0) {
      throw validationError('At least one non-empty VIN is required.');
    }

    if (nonEmpty.length > MAX_BATCH_SIZE) {
      throw validationError(
        `Maximum ${MAX_BATCH_SIZE} VINs per batch. Received ${nonEmpty.length}.`,
      );
    }

    const [firstVin] = nonEmpty;
    const vehicles =
      firstVin && nonEmpty.length === 1
        ? [await svc.decodeVin(firstVin, input.modelYear, ctx.signal)]
        : await svc.decodeVinBatch(
            nonEmpty.map((vin) =>
              input.modelYear != null ? { vin, modelYear: input.modelYear } : { vin },
            ),
            ctx.signal,
          );

    ctx.log.info('VIN decode', { count: nonEmpty.length, results: vehicles.length });

    return { vehicles };
  },

  format: (result) => {
    if (result.vehicles.length === 0) {
      return [{ type: 'text' as const, text: 'No VIN decode results.' }];
    }

    const lines: string[] = [];
    for (const v of result.vehicles) {
      lines.push(`## ${v.vin}\n`);

      const hasError = v.errorCode != null && v.errorCode !== '0';
      if (hasError) {
        lines.push(
          `**Warning (errorCode: ${v.errorCode}):** ${v.errorText ?? 'VPIC returned a decode warning.'}\n`,
        );
      }

      const summaryParts = [v.modelYear, v.make, v.model].filter(Boolean);
      if (summaryParts.length > 0) {
        lines.push(`**${summaryParts.join(' ')}**${v.trim ? ` ${v.trim}` : ''}`);
      } else if (v.trim) {
        lines.push(`**Trim:** ${v.trim}`);
      } else {
        lines.push('**Vehicle details:** Not available');
      }

      const classification = [v.bodyClass, v.vehicleType].filter(Boolean);
      if (classification.length > 0) {
        lines.push(classification.join(' | '));
      }
      if (v.driveType) {
        lines.push(v.driveType);
      }
      lines.push('');

      const engineParts = [
        v.engineCylinders ? `${v.engineCylinders}-cyl` : '',
        v.engineDisplacementL ? `${v.engineDisplacementL}L` : '',
        v.engineHP ? `${v.engineHP} HP` : '',
        v.fuelType,
      ].filter(Boolean);
      if (engineParts.length > 0) {
        lines.push(`**Engine:** ${engineParts.join(', ')}`);
      }

      const plant = [v.plantCity, v.plantState, v.plantCountry].filter(Boolean).join(', ');
      if (plant) lines.push(`**Manufactured:** ${plant}`);
      if (v.manufacturer) lines.push(`**Manufacturer:** ${v.manufacturer}`);

      const safetyEquipment = [
        v.airBagLocFront ? `- Front airbags: ${v.airBagLocFront}` : '',
        v.airBagLocSide ? `- Side airbags: ${v.airBagLocSide}` : '',
        v.airBagLocCurtain ? `- Curtain airbags: ${v.airBagLocCurtain}` : '',
        v.airBagLocKnee ? `- Knee airbags: ${v.airBagLocKnee}` : '',
        v.electronicStabilityControl ? `- ESC: ${v.electronicStabilityControl}` : '',
        v.abs ? `- ABS: ${v.abs}` : '',
        v.tractionControl ? `- Traction control: ${v.tractionControl}` : '',
      ].filter(Boolean);

      if (safetyEquipment.length > 0) {
        lines.push('\n**Safety Equipment:**');
        lines.push(...safetyEquipment);
      }
      lines.push('');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
