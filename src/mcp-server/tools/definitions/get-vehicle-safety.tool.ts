/**
 * @fileoverview Composite vehicle safety profile tool — combines recalls, complaints,
 * crash test ratings, and investigation counts into a single response.
 * @module mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type {
  Complaint,
  Recall,
  SafetyRating,
  SafetyRatingVariant,
} from '@/services/nhtsa/types.js';
import { buildComponentBreakdown } from '@/services/nhtsa/types.js';

function formatValue(value?: string): string {
  return value || 'Not available';
}

function formatOverallRating(value?: string): string {
  if (!value) return 'Not available';
  const stars = Number.parseInt(value, 10);
  return Number.isNaN(stars) ? value : `${stars} stars`;
}

const safetyRatingSchema = z
  .object({
    vehicleId: z.number().describe('NCAP vehicle ID for follow-up queries'),
    vehicleDescription: z.string().optional().describe('Vehicle variant description'),
    overallRating: z
      .string()
      .optional()
      .describe('Overall safety rating (1-5 stars or "Not Rated")'),
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
  })
  .describe('Safety ratings for a single vehicle variant');

const recallSchema = z
  .object({
    campaignNumber: z.string().describe('NHTSA campaign number'),
    component: z.string().describe('Affected component'),
    summary: z.string().describe('Recall summary'),
    remedy: z.string().describe('Corrective action'),
    reportReceivedDate: z.string().describe('Date recall was reported'),
    parkIt: z.boolean().optional().describe('Do-not-drive advisory when provided by NHTSA'),
  })
  .describe('A single recall campaign');

const componentBreakdownSchema = z
  .object({
    component: z.string().describe('Component name'),
    count: z.number().describe('Number of complaints'),
    crashCount: z.number().describe('Complaints involving crashes'),
    fireCount: z.number().describe('Complaints involving fires'),
    injuryCount: z.number().describe('Total injuries reported'),
    deathCount: z.number().describe('Total deaths reported'),
  })
  .describe('Complaint counts for a single component');

const complaintSummarySchema = z.object({
  totalCount: z.number().describe('Total complaints filed'),
  componentBreakdown: z.array(componentBreakdownSchema).describe('Complaints grouped by component'),
  crashCount: z.number().describe('Total complaints involving crashes'),
  fireCount: z.number().describe('Total complaints involving fires'),
  injuryCount: z.number().describe('Total injuries across all complaints'),
  deathCount: z.number().describe('Total deaths across all complaints'),
});

const sectionStatusSchema = z.object({
  safetyRatings: z
    .enum(['available', 'partial', 'unavailable'])
    .describe('Availability of NCAP safety ratings in this response'),
  recalls: z
    .enum(['available', 'partial', 'unavailable'])
    .describe('Availability of recall data in this response'),
  complaints: z
    .enum(['available', 'partial', 'unavailable'])
    .describe('Availability of complaint data in this response'),
});

const vehicleSafetyOutputSchema = z.object({
  safetyRatings: z
    .array(safetyRatingSchema)
    .optional()
    .describe('Crash test ratings per vehicle variant (e.g., FWD vs AWD)'),
  recalls: z.array(recallSchema).optional().describe('All recalls for this vehicle when available'),
  complaintSummary: complaintSummarySchema.optional().describe('Summary of consumer complaints'),
  sectionStatus: sectionStatusSchema.describe('Availability of each data section in this response'),
  warnings: z
    .array(z.string())
    .describe('Warnings about sections that could not be loaded from NHTSA'),
});

type VehicleSafetyOutput = z.infer<typeof vehicleSafetyOutputSchema>;
type SectionStatus = VehicleSafetyOutput['sectionStatus'];
type SafetyRatingsResult = NonNullable<VehicleSafetyOutput['safetyRatings']>;
type RecallsResult = NonNullable<VehicleSafetyOutput['recalls']>;
type ComplaintSummary = NonNullable<VehicleSafetyOutput['complaintSummary']>;

const EMPTY_COMPLAINT_SUMMARY = {
  totalCount: 0,
  componentBreakdown: [],
  crashCount: 0,
  fireCount: 0,
  injuryCount: 0,
  deathCount: 0,
} satisfies ComplaintSummary;

type DefinedOptionalFields<T extends Record<string, unknown>> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function omitUndefined<T extends Record<string, unknown>>(value: T): DefinedOptionalFields<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as DefinedOptionalFields<T>;
}

function summarizeComplaints(complaints: Complaint[]): ComplaintSummary {
  return {
    totalCount: complaints.length,
    componentBreakdown: buildComponentBreakdown(complaints),
    crashCount: complaints.filter((complaint) => complaint.crash).length,
    fireCount: complaints.filter((complaint) => complaint.fire).length,
    injuryCount: complaints.reduce(
      (total, complaint) => total + (complaint.numberOfInjuries ?? 0),
      0,
    ),
    deathCount: complaints.reduce((total, complaint) => total + (complaint.numberOfDeaths ?? 0), 0),
  };
}

function mapRecalls(recalls: Recall[]): RecallsResult {
  return recalls.map((recall) => ({
    campaignNumber: recall.campaignNumber,
    component: recall.component,
    summary: recall.summary,
    remedy: recall.remedy,
    reportReceivedDate: recall.reportReceivedDate,
    ...omitUndefined({ parkIt: recall.parkIt }),
  }));
}

function mapSafetyRatings(ratings: SafetyRating[]): SafetyRatingsResult {
  return ratings.map((rating) => ({
    vehicleId: rating.vehicleId,
    ...omitUndefined({
      vehicleDescription: rating.vehicleDescription,
      overallRating: rating.overallRating,
    }),
    frontalCrash: rating.frontalCrash,
    sideCrash: omitUndefined({
      overall: rating.sideCrash.overall,
      driverSide: rating.sideCrash.driverSide,
      passengerSide: rating.sideCrash.passengerSide,
      combinedBarrierPoleFront: rating.sideCrash.combinedBarrierPoleFront,
      combinedBarrierPoleRear: rating.sideCrash.combinedBarrierPoleRear,
      barrierOverall: rating.sideCrash.barrierOverall,
      pole: rating.sideCrash.pole,
    }),
    rollover: rating.rollover,
    adasFeatures: rating.adasFeatures,
  }));
}

function loadSection<T>(request: Promise<T>, onError: (error: unknown) => void): Promise<T | null> {
  return request.catch((error) => {
    onError(error);
    return null;
  });
}

function formatSafetyRatingsSection(result: VehicleSafetyOutput): string[] {
  const lines: string[] = [];
  const ratings = result.safetyRatings ?? [];

  if (result.sectionStatus.safetyRatings === 'unavailable') {
    lines.push('## NCAP Safety Ratings\n');
    lines.push(
      'NCAP safety ratings were unavailable for this request. Use nhtsa_get_safety_ratings to retry specific variants or adjacent model years.\n',
    );
    return lines;
  }

  if (ratings.length === 0) {
    lines.push(
      '## NCAP Safety Ratings\n\nNo NCAP crash test ratings found. Not all vehicles are tested — coverage varies by trim, drivetrain, and model year. Use nhtsa_get_safety_ratings to check specific variants or adjacent years.\n',
    );
    return lines;
  }

  lines.push('## NCAP Safety Ratings\n');
  if (result.sectionStatus.safetyRatings === 'partial') {
    lines.push('*Some matching NCAP variant ratings could not be loaded.*\n');
  }

  for (const rating of ratings) {
    const label = rating.vehicleDescription
      ? `${rating.vehicleDescription} (vehicleId: ${rating.vehicleId})`
      : `Vehicle ${rating.vehicleId}`;
    const rolloverProbability =
      rating.rollover.probability == null
        ? 'Not available'
        : `${(rating.rollover.probability * 100).toFixed(1)}%`;

    lines.push(`### ${label}`);
    lines.push(`**Overall:** ${formatOverallRating(rating.overallRating)}`);
    lines.push(
      `**Frontal Crash:** ${formatValue(rating.frontalCrash.overall)} (Driver: ${formatValue(rating.frontalCrash.driverSide)}, Passenger: ${formatValue(rating.frontalCrash.passengerSide)})`,
    );
    lines.push(
      `**Side Crash:** ${formatValue(rating.sideCrash.overall)} (Driver: ${formatValue(rating.sideCrash.driverSide)}, Passenger: ${formatValue(rating.sideCrash.passengerSide)}, Barrier: ${formatValue(rating.sideCrash.barrierOverall)}, Pole: ${formatValue(rating.sideCrash.pole)}, Combined Front: ${formatValue(rating.sideCrash.combinedBarrierPoleFront)}, Combined Rear: ${formatValue(rating.sideCrash.combinedBarrierPoleRear)})`,
    );
    lines.push(
      `**Rollover:** ${formatValue(rating.rollover.rating)} (${rolloverProbability} probability, Tip test: ${formatValue(rating.rollover.dynamicTipResult)})`,
    );
    lines.push(
      `**ADAS:** ESC: ${formatValue(rating.adasFeatures.electronicStabilityControl)}, FCW: ${formatValue(rating.adasFeatures.forwardCollisionWarning)}, LDW: ${formatValue(rating.adasFeatures.laneDepartureWarning)}`,
    );
    lines.push('');
  }

  return lines;
}

function formatRecallsSection(result: VehicleSafetyOutput): string[] {
  const lines: string[] = [];
  const recalls = result.recalls ?? [];

  if (result.sectionStatus.recalls === 'unavailable') {
    lines.push('## Recalls\n');
    lines.push('Recall data was unavailable for this request.\n');
    return lines;
  }

  lines.push(`## Recalls (${recalls.length})\n`);
  if (recalls.length === 0) {
    lines.push('No recalls found.\n');
    return lines;
  }

  for (const recall of recalls) {
    const alert = recall.parkIt ? ' **PARK IT — DO NOT DRIVE**' : '';
    lines.push(`**${recall.campaignNumber}** — ${recall.component}${alert}`);
    lines.push(recall.summary);
    lines.push(`*Remedy:* ${recall.remedy}`);
    lines.push(`*Date:* ${recall.reportReceivedDate}\n`);
  }

  return lines;
}

function formatComplaintsSection(result: VehicleSafetyOutput): string[] {
  const lines: string[] = [];

  if (result.sectionStatus.complaints === 'unavailable') {
    lines.push('## Complaints\n');
    lines.push('Complaint data was unavailable for this request.\n');
    return lines;
  }

  const summary = result.complaintSummary ?? EMPTY_COMPLAINT_SUMMARY;

  lines.push(`## Complaints (${summary.totalCount})\n`);
  if (summary.totalCount === 0) {
    lines.push('No complaints filed.\n');
    return lines;
  }

  lines.push(
    `Crashes: ${summary.crashCount} | Fires: ${summary.fireCount} | Injuries: ${summary.injuryCount} | Deaths: ${summary.deathCount}\n`,
  );
  lines.push('**Top Components:**');
  for (const component of summary.componentBreakdown.slice(0, 10)) {
    lines.push(
      `- ${component.component}: ${component.count} complaints (${component.crashCount} crashes, ${component.fireCount} fires, ${component.injuryCount} injuries, ${component.deathCount} deaths)`,
    );
  }

  return lines;
}

export const getVehicleSafety = tool('nhtsa_get_vehicle_safety', {
  description:
    'Get a comprehensive safety profile for a vehicle. Combines NCAP crash test ratings, recalls, and complaint summary into a single response. Use as the default when asked about vehicle safety, reliability, or purchase decisions.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z.string().describe('Vehicle manufacturer (e.g., "Toyota", "Ford"). Case-insensitive.'),
    model: z.string().describe('Vehicle model (e.g., "Camry", "F-150"). Case-insensitive.'),
    modelYear: z.number().describe('Model year (e.g., 2020).'),
  }),
  output: vehicleSafetyOutputSchema,

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const { make, model, modelYear } = input;
    const requestContext = { make, model, modelYear };

    const warnings: string[] = [];
    const sectionStatus: SectionStatus = {
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
    };

    const [variants, recalls, complaints] = await Promise.all([
      loadVehicleDataSection({
        ctx,
        request: svc.getSafetyRatingVariants(modelYear, make, model, ctx.signal),
        section: 'safetyRatings',
        sectionStatus,
        warnings,
        logMessage: 'Failed to fetch safety rating variants',
        warning: 'NCAP safety ratings could not be retrieved.',
        details: requestContext,
      }),
      loadVehicleDataSection({
        ctx,
        request: svc.getRecallsByVehicle(make, model, modelYear, ctx.signal),
        section: 'recalls',
        sectionStatus,
        warnings,
        logMessage: 'Failed to fetch recalls',
        warning: 'Recall data could not be retrieved.',
        details: requestContext,
      }),
      loadVehicleDataSection({
        ctx,
        request: svc.getComplaintsByVehicle(make, model, modelYear, ctx.signal),
        section: 'complaints',
        sectionStatus,
        warnings,
        logMessage: 'Failed to fetch complaints',
        warning:
          'Complaint data could not be retrieved — the make/model/year combination may not match NHTSA records.',
        details: requestContext,
      }),
    ]);

    const safetyRatings = await resolveSafetyRatings(
      svc,
      variants,
      ctx,
      warnings,
      sectionStatus,
      ctx.signal,
    );
    const recallResults =
      sectionStatus.recalls === 'available' && recalls ? mapRecalls(recalls) : undefined;
    const complaintSummary =
      sectionStatus.complaints === 'available' && complaints
        ? summarizeComplaints(complaints)
        : undefined;

    ctx.log.info('Vehicle safety profile assembled', {
      make,
      model,
      modelYear,
      variants: safetyRatings?.length ?? 0,
      recalls: recallResults?.length ?? 0,
      complaints: complaintSummary?.totalCount ?? 0,
      safetyRatingsStatus: sectionStatus.safetyRatings,
      recallsStatus: sectionStatus.recalls,
      complaintsStatus: sectionStatus.complaints,
    });

    return {
      ...(safetyRatings && { safetyRatings }),
      ...(recallResults && { recalls: recallResults }),
      ...(complaintSummary && { complaintSummary }),
      sectionStatus,
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

    lines.push(...formatSafetyRatingsSection(result));
    lines.push(...formatRecallsSection(result));
    lines.push(...formatComplaintsSection(result));

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

type VehicleSafetySection = keyof SectionStatus;
type VehicleSafetyLogContext = {
  log: {
    warning(message: string, details: Record<string, unknown>): void;
  };
};

function loadVehicleDataSection<T>({
  ctx,
  request,
  section,
  sectionStatus,
  warnings,
  logMessage,
  warning,
  details,
}: {
  ctx: VehicleSafetyLogContext;
  request: Promise<T>;
  section: VehicleSafetySection;
  sectionStatus: SectionStatus;
  warnings: string[];
  logMessage: string;
  warning: string;
  details: Record<string, unknown>;
}): Promise<T | null> {
  return loadSection(request, (error) => {
    ctx.log.warning(logMessage, { ...details, error: String(error) });
    sectionStatus[section] = 'unavailable';
    warnings.push(warning);
  });
}

async function resolveSafetyRatings(
  svc: ReturnType<typeof getNhtsaService>,
  variants: SafetyRatingVariant[] | null,
  ctx: VehicleSafetyLogContext,
  warnings: string[],
  sectionStatus: SectionStatus,
  signal?: AbortSignal,
): Promise<SafetyRatingsResult | undefined> {
  if (!variants || sectionStatus.safetyRatings === 'unavailable') {
    return;
  }

  if (variants.length === 0) {
    sectionStatus.safetyRatings = 'unavailable';
    warnings.push(
      'NCAP crash test data is not available for this vehicle. NCAP coverage starts from 1990, with best coverage for 2011+.',
    );
    return;
  }

  let failedVariantCount = 0;
  const ratings = (
    await Promise.all(
      variants.map((variant) =>
        loadSection(svc.getSafetyRating(variant.vehicleId, signal), (error) => {
          failedVariantCount++;
          ctx.log.warning('Failed to fetch safety rating for variant', {
            vehicleId: variant.vehicleId,
            error: String(error),
          });
        }),
      ),
    )
  ).filter((rating): rating is SafetyRating => rating != null);

  if (failedVariantCount === 0) {
    return mapSafetyRatings(ratings);
  }

  if (ratings.length === 0 && variants.length > 0) {
    sectionStatus.safetyRatings = 'unavailable';
    warnings.push('NCAP safety ratings could not be retrieved for matching variants.');
    return;
  }

  sectionStatus.safetyRatings = 'partial';
  warnings.push(
    `Some NCAP safety ratings could not be retrieved (${failedVariantCount} variant${failedVariantCount === 1 ? '' : 's'}).`,
  );

  return mapSafetyRatings(ratings);
}
