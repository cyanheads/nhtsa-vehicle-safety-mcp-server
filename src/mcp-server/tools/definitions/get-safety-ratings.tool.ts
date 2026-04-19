/**
 * @fileoverview NCAP crash test ratings and ADAS feature availability tool.
 * Two-step lookup: year/make/model → variant IDs → full ratings per variant.
 * @module mcp-server/tools/definitions/get-safety-ratings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { SafetyRating } from '@/services/nhtsa/types.js';

function formatStars(rating?: string): string {
  if (!rating) return 'Not available';
  const n = Number.parseInt(rating, 10);
  if (Number.isNaN(n)) return rating;
  return `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))} (${n}/5)`;
}

function formatCount(count: number | undefined): string {
  return count == null ? 'N/A' : String(count);
}

export const getSafetyRatings = tool('nhtsa_get_safety_ratings', {
  description:
    'Get NCAP crash test ratings and ADAS feature availability for a vehicle. Use when the user specifically wants crash test stars, rollover risk, or wants to compare safety features across vehicles. NCAP data available from 1990+, best coverage for 2011+.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z
      .string()
      .optional()
      .describe(
        'Vehicle manufacturer. Required with model and modelYear when vehicleId is omitted.',
      ),
    model: z
      .string()
      .optional()
      .describe('Vehicle model. Required with make and modelYear when vehicleId is omitted.'),
    modelYear: z
      .number()
      .optional()
      .describe(
        'Model year. Required with make and model when vehicleId is omitted. NCAP coverage increases significantly for 2011+.',
      ),
    vehicleId: z
      .number()
      .optional()
      .describe('Specific NCAP vehicle ID (from prior results). Skips the year/make/model lookup.'),
  }),
  output: z.object({
    ratings: z
      .array(
        z.object({
          vehicleId: z.number().describe('NCAP vehicle ID'),
          vehicleDescription: z.string().optional().describe('Vehicle variant description'),
          overallRating: z
            .string()
            .optional()
            .describe('Overall safety rating (1-5 stars or "Not Rated")'),
          frontalCrash: z
            .object({
              overall: z.string().optional().describe('Overall frontal crash rating'),
              driverSide: z.string().optional().describe('Driver-side rating'),
              passengerSide: z.string().optional().describe('Passenger-side rating'),
            })
            .describe('Frontal crash test results'),
          sideCrash: z
            .object({
              overall: z.string().optional().describe('Overall side crash rating'),
              driverSide: z.string().optional().describe('Driver-side rating'),
              passengerSide: z.string().optional().describe('Passenger-side rating'),
              combinedBarrierPoleFront: z
                .string()
                .optional()
                .describe('Combined barrier/pole front rating'),
              combinedBarrierPoleRear: z
                .string()
                .optional()
                .describe('Combined barrier/pole rear rating'),
              barrierOverall: z.string().optional().describe('Side barrier overall rating'),
              pole: z.string().optional().describe('Side pole crash rating'),
            })
            .describe('Side crash test results'),
          rollover: z
            .object({
              rating: z.string().optional().describe('Rollover resistance rating'),
              probability: z.number().optional().describe('Rollover probability (0-1 scale)'),
              dynamicTipResult: z.string().optional().describe('Dynamic tip test result'),
            })
            .describe('Rollover risk assessment'),
          adasFeatures: z
            .object({
              electronicStabilityControl: z
                .string()
                .optional()
                .describe('"Standard", "Optional", or "Not Available"'),
              forwardCollisionWarning: z
                .string()
                .optional()
                .describe('Forward collision warning availability'),
              laneDepartureWarning: z
                .string()
                .optional()
                .describe('Lane departure warning availability'),
            })
            .describe('Advanced driver assistance features'),
          complaintsCount: z.number().optional().describe('Number of complaints on file'),
          recallsCount: z.number().optional().describe('Number of recalls on file'),
          investigationCount: z.number().optional().describe('Number of investigations on file'),
        }),
      )
      .describe('Safety ratings per vehicle variant'),
    message: z
      .string()
      .optional()
      .describe('Contextual guidance populated when no ratings are returned'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    let ratings: SafetyRating[] = [];
    let message: string | undefined;

    if (input.vehicleId != null) {
      const rating = await svc.getSafetyRating(input.vehicleId);
      if (rating) {
        ratings = [rating];
      } else {
        message = `No NCAP vehicle found for vehicleId ${input.vehicleId}. Verify the ID — look it up via make/model/modelYear first.`;
      }
    } else {
      if (!input.make || !input.model || input.modelYear == null) {
        throw validationError(
          'Provide either vehicleId, or make + model + modelYear to look up NCAP safety ratings.',
        );
      }
      const variants = await svc.getSafetyRatingVariants(input.modelYear, input.make, input.model);
      if (variants.length === 0) {
        message = `No NCAP crash test data for ${input.make} ${input.model} ${input.modelYear}. NCAP coverage starts from 1990, with best coverage for 2011+. Adjacent model years or a different trim/drivetrain may have ratings.`;
      } else {
        ratings = (await Promise.all(variants.map((v) => svc.getSafetyRating(v.vehicleId)))).filter(
          (r): r is NonNullable<typeof r> => r !== null,
        );
      }
    }

    ctx.log.info('Safety ratings fetched', {
      make: input.make,
      model: input.model,
      modelYear: input.modelYear,
      variants: ratings.length,
    });

    return { ratings, ...(message ? { message } : {}) };
  },

  format: (result) => {
    if (result.ratings.length === 0) {
      return [
        {
          type: 'text' as const,
          text:
            result.message ??
            'No NCAP safety ratings available for this vehicle. Ratings are most comprehensive for 2011+ model years.',
        },
      ];
    }

    const lines: string[] = [];
    for (const r of result.ratings) {
      const label = r.vehicleDescription || `Vehicle ${r.vehicleId}`;
      const rolloverProbability =
        r.rollover.probability == null
          ? 'Not available'
          : `${(r.rollover.probability * 100).toFixed(1)}%`;

      lines.push(`## ${label}\n`);
      lines.push(`**Overall:** ${formatStars(r.overallRating)}\n`);

      lines.push('### Frontal Crash');
      lines.push(`Overall: ${formatStars(r.frontalCrash.overall)}`);
      lines.push(
        `Driver: ${formatStars(r.frontalCrash.driverSide)} | Passenger: ${formatStars(r.frontalCrash.passengerSide)}\n`,
      );

      lines.push('### Side Crash');
      lines.push(`Overall: ${formatStars(r.sideCrash.overall)}`);
      lines.push(
        `Driver: ${formatStars(r.sideCrash.driverSide)} | Passenger: ${formatStars(r.sideCrash.passengerSide)}`,
      );
      lines.push(
        `Barrier: ${formatStars(r.sideCrash.barrierOverall)} | Pole: ${formatStars(r.sideCrash.pole)}\n`,
      );

      lines.push('### Rollover');
      lines.push(`Rating: ${formatStars(r.rollover.rating)}`);
      lines.push(
        `Probability: ${rolloverProbability} | Tip test: ${r.rollover.dynamicTipResult || 'Not available'}\n`,
      );

      lines.push('### ADAS Features');
      lines.push(`ESC: ${r.adasFeatures.electronicStabilityControl || 'Not available'}`);
      lines.push(
        `Forward Collision Warning: ${r.adasFeatures.forwardCollisionWarning || 'Not available'}`,
      );
      lines.push(
        `Lane Departure Warning: ${r.adasFeatures.laneDepartureWarning || 'Not available'}\n`,
      );

      lines.push(
        `*Complaints: ${formatCount(r.complaintsCount)} | Recalls: ${formatCount(r.recallsCount)} | Investigations: ${formatCount(r.investigationCount)}*\n`,
      );
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
