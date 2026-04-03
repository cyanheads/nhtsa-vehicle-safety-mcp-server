/**
 * @fileoverview Composite vehicle safety profile tool — combines recalls, complaints,
 * crash test ratings, and investigation counts into a single response.
 * @module mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Complaint, ComponentBreakdown } from '@/services/nhtsa/types.js';

function buildComponentBreakdown(complaints: Complaint[]): ComponentBreakdown[] {
  const map = new Map<string, ComponentBreakdown>();
  for (const c of complaints) {
    for (const component of c.components
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const entry = map.get(component) ?? {
        component,
        count: 0,
        crashCount: 0,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      };
      entry.count++;
      if (c.crash) entry.crashCount++;
      if (c.fire) entry.fireCount++;
      entry.injuryCount += c.numberOfInjuries;
      entry.deathCount += c.numberOfDeaths;
      map.set(component, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const safetyRatingSchema = z.object({
  vehicleId: z.number().describe('NCAP vehicle ID for follow-up queries'),
  vehicleDescription: z.string().describe('Vehicle variant description'),
  overallRating: z.string().describe('Overall safety rating (1-5 stars or "Not Rated")'),
  frontalCrash: z
    .object({
      overall: z.string().describe('Overall frontal crash rating'),
      driverSide: z.string().describe('Driver-side frontal crash rating'),
      passengerSide: z.string().describe('Passenger-side frontal crash rating'),
    })
    .describe('Frontal crash test ratings'),
  sideCrash: z
    .object({
      overall: z.string().describe('Overall side crash rating'),
      driverSide: z.string().describe('Driver-side rating'),
      passengerSide: z.string().describe('Passenger-side rating'),
      barrierOverall: z.string().describe('Side barrier overall rating'),
      pole: z.string().describe('Side pole crash rating'),
    })
    .describe('Side crash test ratings'),
  rollover: z
    .object({
      rating: z.string().describe('Rollover resistance rating'),
      probability: z.number().describe('Rollover probability percentage'),
      dynamicTipResult: z.string().describe('Dynamic tip test result'),
    })
    .describe('Rollover risk assessment'),
  adasFeatures: z
    .object({
      electronicStabilityControl: z.string().describe('ESC availability'),
      forwardCollisionWarning: z.string().describe('FCW availability'),
      laneDepartureWarning: z.string().describe('LDW availability'),
    })
    .describe('Advanced driver assistance features'),
});

const recallSchema = z.object({
  campaignNumber: z.string().describe('NHTSA campaign number'),
  component: z.string().describe('Affected component'),
  summary: z.string().describe('Recall summary'),
  remedy: z.string().describe('Corrective action'),
  reportReceivedDate: z.string().describe('Date recall was reported'),
  parkIt: z.boolean().describe('Do-not-drive advisory'),
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
  }),

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const { make, model, modelYear } = input;

    const [variants, recalls, complaints] = await Promise.all([
      svc.getSafetyRatingVariants(modelYear, make, model).catch(() => []),
      svc.getRecallsByVehicle(make, model, modelYear).catch(() => []),
      svc.getComplaintsByVehicle(make, model, modelYear).catch(() => []),
    ]);

    const safetyRatings = (
      await Promise.all(variants.map((v) => svc.getSafetyRating(v.vehicleId)))
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
        parkIt: r.parkIt,
      })),
      complaintSummary: {
        totalCount: complaints.length,
        componentBreakdown: breakdown,
        crashCount: complaints.filter((c) => c.crash).length,
        fireCount: complaints.filter((c) => c.fire).length,
        injuryCount: complaints.reduce((sum, c) => sum + c.numberOfInjuries, 0),
        deathCount: complaints.reduce((sum, c) => sum + c.numberOfDeaths, 0),
      },
    };
  },

  format: (result) => {
    const lines: string[] = [];

    // Safety ratings
    if (result.safetyRatings.length > 0) {
      lines.push('## NCAP Safety Ratings\n');
      for (const r of result.safetyRatings) {
        lines.push(`### ${r.vehicleDescription}`);
        lines.push(`**Overall:** ${r.overallRating} stars`);
        lines.push(
          `**Frontal Crash:** ${r.frontalCrash.overall} (Driver: ${r.frontalCrash.driverSide}, Passenger: ${r.frontalCrash.passengerSide})`,
        );
        lines.push(
          `**Side Crash:** ${r.sideCrash.overall} (Driver: ${r.sideCrash.driverSide}, Passenger: ${r.sideCrash.passengerSide}, Barrier: ${r.sideCrash.barrierOverall}, Pole: ${r.sideCrash.pole})`,
        );
        lines.push(
          `**Rollover:** ${r.rollover.rating} (${(r.rollover.probability * 100).toFixed(1)}% probability, Tip test: ${r.rollover.dynamicTipResult})`,
        );
        lines.push(
          `**ADAS:** ESC: ${r.adasFeatures.electronicStabilityControl}, FCW: ${r.adasFeatures.forwardCollisionWarning}, LDW: ${r.adasFeatures.laneDepartureWarning}`,
        );
        lines.push('');
      }
    } else {
      lines.push('## NCAP Safety Ratings\n\nNo crash test ratings available for this vehicle.\n');
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
