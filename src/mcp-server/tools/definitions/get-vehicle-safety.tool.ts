/**
 * @fileoverview Composite vehicle safety profile tool — combines recalls, complaints,
 * crash test ratings, and investigation counts into a single response.
 * @module mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import { buildComponentBreakdown } from '@/services/nhtsa/types.js';

function formatValue(value?: string): string {
  return value || 'Not available';
}

function formatOverallRating(value?: string): string {
  if (!value) return 'Not available';
  const stars = Number.parseInt(value, 10);
  return Number.isNaN(stars) ? value : `${stars} stars`;
}

const safetyRatingSchema = z.object({
  vehicleId: z.number().describe('NCAP vehicle ID for follow-up queries'),
  vehicleDescription: z.string().optional().describe('Vehicle variant description'),
  overallRating: z.string().optional().describe('Overall safety rating (1-5 stars or "Not Rated")'),
  frontalCrash: z
    .object({
      overall: z.string().optional().describe('Overall frontal crash rating'),
      driverSide: z.string().optional().describe('Driver-side frontal crash rating'),
      passengerSide: z.string().optional().describe('Passenger-side frontal crash rating'),
    })
    .describe('Frontal crash test ratings'),
  sideCrash: z
    .object({
      overall: z.string().optional().describe('Overall side crash rating'),
      driverSide: z.string().optional().describe('Driver-side rating'),
      passengerSide: z.string().optional().describe('Passenger-side rating'),
      barrierOverall: z.string().optional().describe('Side barrier overall rating'),
      pole: z.string().optional().describe('Side pole crash rating'),
    })
    .describe('Side crash test ratings'),
  rollover: z
    .object({
      rating: z.string().optional().describe('Rollover resistance rating'),
      probability: z.number().optional().describe('Rollover probability (0-1 scale)'),
      dynamicTipResult: z.string().optional().describe('Dynamic tip test result'),
    })
    .describe('Rollover risk assessment'),
  adasFeatures: z
    .object({
      electronicStabilityControl: z.string().optional().describe('ESC availability'),
      forwardCollisionWarning: z.string().optional().describe('FCW availability'),
      laneDepartureWarning: z.string().optional().describe('LDW availability'),
    })
    .describe('Advanced driver assistance features'),
});

const recallSchema = z.object({
  campaignNumber: z.string().describe('NHTSA campaign number'),
  component: z.string().describe('Affected component'),
  summary: z.string().describe('Recall summary'),
  remedy: z.string().describe('Corrective action'),
  reportReceivedDate: z.string().describe('Date recall was reported'),
  parkIt: z.boolean().optional().describe('Do-not-drive advisory when provided by NHTSA'),
});

const componentBreakdownSchema = z.object({
  component: z.string().describe('Component name'),
  count: z.number().describe('Number of complaints'),
  crashCount: z.number().describe('Complaints involving crashes'),
  fireCount: z.number().describe('Complaints involving fires'),
  injuryCount: z.number().describe('Total injuries reported'),
  deathCount: z.number().describe('Total deaths reported'),
});

export const getVehicleSafety = tool('nhtsa_get_vehicle_safety', {
  description:
    'Get a comprehensive safety profile for a vehicle. Combines NCAP crash test ratings, recalls, and complaint summary into a single response. Use as the default when asked about vehicle safety, reliability, or purchase decisions.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z.string().describe('Vehicle manufacturer (e.g., "Toyota", "Ford"). Case-insensitive.'),
    model: z.string().describe('Vehicle model (e.g., "Camry", "F-150"). Case-insensitive.'),
    modelYear: z.number().describe('Model year (e.g., 2020).'),
  }),
  output: z.object({
    safetyRatings: z
      .array(safetyRatingSchema)
      .describe('Crash test ratings per vehicle variant (e.g., FWD vs AWD)'),
    recalls: z.array(recallSchema).describe('All recalls for this vehicle'),
    complaintSummary: z
      .object({
        totalCount: z.number().describe('Total complaints filed'),
        componentBreakdown: z
          .array(componentBreakdownSchema)
          .describe('Complaints grouped by component'),
        crashCount: z.number().describe('Total complaints involving crashes'),
        fireCount: z.number().describe('Total complaints involving fires'),
        injuryCount: z.number().describe('Total injuries across all complaints'),
        deathCount: z.number().describe('Total deaths across all complaints'),
      })
      .describe('Summary of consumer complaints'),
    warnings: z
      .array(z.string())
      .describe('Warnings about sections that could not be loaded from NHTSA'),
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const { make, model, modelYear } = input;

    const warnings: string[] = [];

    const [variants, recalls, complaints] = await Promise.all([
      svc.getSafetyRatingVariants(modelYear, make, model).catch((err) => {
        ctx.log.warning('Failed to fetch safety rating variants', {
          make,
          model,
          modelYear,
          error: String(err),
        });
        warnings.push('NCAP safety ratings could not be retrieved.');
        return [];
      }),
      svc.getRecallsByVehicle(make, model, modelYear).catch((err) => {
        ctx.log.warning('Failed to fetch recalls', { make, model, modelYear, error: String(err) });
        warnings.push('Recall data could not be retrieved.');
        return [];
      }),
      svc.getComplaintsByVehicle(make, model, modelYear).catch((err) => {
        ctx.log.warning('Failed to fetch complaints', {
          make,
          model,
          modelYear,
          error: String(err),
        });
        warnings.push(
          'Complaint data could not be retrieved — the make/model/year combination may not match NHTSA records.',
        );
        return [];
      }),
    ]);

    const safetyRatings = (
      await Promise.all(
        variants.map((v) =>
          svc.getSafetyRating(v.vehicleId).catch((err) => {
            ctx.log.warning('Failed to fetch safety rating for variant', {
              vehicleId: v.vehicleId,
              error: String(err),
            });
            return null;
          }),
        ),
      )
    ).filter((r) => r !== null);

    const breakdown = buildComponentBreakdown(complaints);

    ctx.log.info('Vehicle safety profile assembled', {
      make,
      model,
      modelYear,
      variants: safetyRatings.length,
      recalls: recalls.length,
      complaints: complaints.length,
    });

    return {
      safetyRatings: safetyRatings.map((r) => ({
        vehicleId: r.vehicleId,
        vehicleDescription: r.vehicleDescription,
        overallRating: r.overallRating,
        frontalCrash: r.frontalCrash,
        sideCrash: {
          overall: r.sideCrash.overall,
          driverSide: r.sideCrash.driverSide,
          passengerSide: r.sideCrash.passengerSide,
          barrierOverall: r.sideCrash.barrierOverall,
          pole: r.sideCrash.pole,
        },
        rollover: r.rollover,
        adasFeatures: r.adasFeatures,
      })),
      recalls: recalls.map((r) => ({
        campaignNumber: r.campaignNumber,
        component: r.component,
        summary: r.summary,
        remedy: r.remedy,
        reportReceivedDate: r.reportReceivedDate,
        ...(r.parkIt !== undefined ? { parkIt: r.parkIt } : {}),
      })),
      complaintSummary: {
        totalCount: complaints.length,
        componentBreakdown: breakdown,
        crashCount: complaints.filter((c) => c.crash).length,
        fireCount: complaints.filter((c) => c.fire).length,
        injuryCount: complaints.reduce((sum, c) => sum + (c.numberOfInjuries ?? 0), 0),
        deathCount: complaints.reduce((sum, c) => sum + (c.numberOfDeaths ?? 0), 0),
      },
      warnings,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        lines.push(`> **Warning:** ${w}`);
      }
      lines.push('');
    }

    // Safety ratings
    if (result.safetyRatings.length > 0) {
      lines.push('## NCAP Safety Ratings\n');
      for (const r of result.safetyRatings) {
        const label = r.vehicleDescription || `Vehicle ${r.vehicleId}`;
        const rolloverProbability =
          r.rollover.probability == null
            ? 'Not available'
            : `${(r.rollover.probability * 100).toFixed(1)}%`;

        lines.push(`### ${label}`);
        lines.push(`**Overall:** ${formatOverallRating(r.overallRating)}`);
        lines.push(
          `**Frontal Crash:** ${formatValue(r.frontalCrash.overall)} (Driver: ${formatValue(r.frontalCrash.driverSide)}, Passenger: ${formatValue(r.frontalCrash.passengerSide)})`,
        );
        lines.push(
          `**Side Crash:** ${formatValue(r.sideCrash.overall)} (Driver: ${formatValue(r.sideCrash.driverSide)}, Passenger: ${formatValue(r.sideCrash.passengerSide)}, Barrier: ${formatValue(r.sideCrash.barrierOverall)}, Pole: ${formatValue(r.sideCrash.pole)})`,
        );
        lines.push(
          `**Rollover:** ${formatValue(r.rollover.rating)} (${rolloverProbability} probability, Tip test: ${formatValue(r.rollover.dynamicTipResult)})`,
        );
        lines.push(
          `**ADAS:** ESC: ${formatValue(r.adasFeatures.electronicStabilityControl)}, FCW: ${formatValue(r.adasFeatures.forwardCollisionWarning)}, LDW: ${formatValue(r.adasFeatures.laneDepartureWarning)}`,
        );
        lines.push('');
      }
    } else {
      lines.push(
        '## NCAP Safety Ratings\n\nNo NCAP crash test ratings found. Not all vehicles are tested — coverage varies by trim, drivetrain, and model year. Use nhtsa_get_safety_ratings to check specific variants or adjacent years.\n',
      );
    }

    // Recalls
    lines.push(`## Recalls (${result.recalls.length})\n`);
    if (result.recalls.length === 0) {
      lines.push('No recalls found.\n');
    } else {
      for (const r of result.recalls) {
        const alert = r.parkIt ? ' **DO NOT DRIVE**' : '';
        lines.push(`**${r.campaignNumber}** — ${r.component}${alert}`);
        lines.push(`${r.summary}`);
        lines.push(`*Remedy:* ${r.remedy}`);
        lines.push(`*Date:* ${r.reportReceivedDate}\n`);
      }
    }

    // Complaints
    const cs = result.complaintSummary;
    lines.push(`## Complaints (${cs.totalCount})\n`);
    if (cs.totalCount > 0) {
      lines.push(
        `Crashes: ${cs.crashCount} | Fires: ${cs.fireCount} | Injuries: ${cs.injuryCount} | Deaths: ${cs.deathCount}\n`,
      );
      lines.push('**Top Components:**');
      for (const b of cs.componentBreakdown.slice(0, 10)) {
        lines.push(
          `- ${b.component}: ${b.count} complaints (${b.crashCount} crashes, ${b.fireCount} fires)`,
        );
      }
    } else {
      lines.push('No complaints filed.');
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
