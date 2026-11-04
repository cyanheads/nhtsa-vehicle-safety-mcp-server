/**
 * @fileoverview Composite vehicle safety profile tool — combines recalls, complaints, and
 * crash test ratings into a single response.
 * @module mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  formatRecallAdvisories,
  formatRolloverProbability,
  formatStars,
  formatText,
  pluralize,
} from '@/services/nhtsa/format.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type { Complaint, SafetyRating, SafetyRatingVariant } from '@/services/nhtsa/types.js';
import { buildComponentBreakdown } from '@/services/nhtsa/types.js';

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
        electronicStabilityControl: z
          .string()
          .optional()
          .describe('Electronic stability control: "Standard", "Optional", or "No"'),
        forwardCollisionWarning: z
          .string()
          .optional()
          .describe('Forward collision warning: "Standard", "Optional", or "No"'),
        laneDepartureWarning: z
          .string()
          .optional()
          .describe('Lane departure warning: "Standard", "Optional", or "No"'),
      })
      .describe('Advanced driver assistance features'),
  })
  .describe('Safety ratings for a single vehicle variant');

const recallSchema = z
  .object({
    campaignNumber: z.string().describe('NHTSA campaign number'),
    manufacturer: z.string().describe('Vehicle/equipment manufacturer'),
    component: z.string().describe('Affected component'),
    summary: z
      .string()
      .optional()
      .describe('Recall summary. Omitted for older campaigns whose record leaves it blank.'),
    consequence: z
      .string()
      .optional()
      .describe('Safety consequence. Omitted for older campaigns whose record leaves it blank.'),
    remedy: z
      .string()
      .optional()
      .describe('Corrective action. Omitted for older campaigns whose record leaves it blank.'),
    reportReceivedDate: z.string().describe('Date recall was reported'),
    parkIt: z.boolean().optional().describe('Do-not-drive advisory when provided by NHTSA'),
    parkOutSide: z.boolean().optional().describe('Park-outside advisory when provided by NHTSA'),
    overTheAirUpdate: z
      .boolean()
      .optional()
      .describe('OTA update availability when provided by NHTSA'),
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

function mapSafetyRatings(ratings: SafetyRating[]): SafetyRatingsResult {
  return ratings.map((rating) => ({
    vehicleId: rating.vehicleId,
    ...omitUndefined({
      vehicleDescription: rating.vehicleDescription,
      overallRating: rating.overallRating,
    }),
    frontalCrash: rating.frontalCrash,
    sideCrash: rating.sideCrash,
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
      '## NCAP Safety Ratings\n\nNo NCAP crash test ratings found. Not all vehicles are tested — coverage starts from 1990, is most complete for 2011 and later, and varies by trim, drivetrain, and model year. Use nhtsa_get_safety_ratings to check specific variants or adjacent years.\n',
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

    lines.push(`### ${label}`);
    lines.push(`**Overall:** ${formatStars(rating.overallRating)}`);
    lines.push(
      `**Frontal Crash:** ${formatStars(rating.frontalCrash.overall)} | Driver: ${formatStars(rating.frontalCrash.driverSide)} | Passenger: ${formatStars(rating.frontalCrash.passengerSide)}`,
    );
    lines.push(
      `**Side Crash:** ${formatStars(rating.sideCrash.overall)} | Driver: ${formatStars(rating.sideCrash.driverSide)} | Passenger: ${formatStars(rating.sideCrash.passengerSide)} | Barrier: ${formatStars(rating.sideCrash.barrierOverall)} | Pole: ${formatStars(rating.sideCrash.pole)} | Combined Front: ${formatStars(rating.sideCrash.combinedBarrierPoleFront)} | Combined Rear: ${formatStars(rating.sideCrash.combinedBarrierPoleRear)}`,
    );
    lines.push(
      `**Rollover:** ${formatStars(rating.rollover.rating)} | Probability: ${formatRolloverProbability(rating.rollover.probability)} | Tip test: ${formatText(rating.rollover.dynamicTipResult)}`,
    );
    lines.push(
      `**ADAS:** ESC: ${formatText(rating.adasFeatures.electronicStabilityControl)} | Forward Collision Warning: ${formatText(rating.adasFeatures.forwardCollisionWarning)} | Lane Departure Warning: ${formatText(rating.adasFeatures.laneDepartureWarning)}`,
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
    const alerts: string[] = [];
    if (recall.parkIt) alerts.push('PARK IT — DO NOT DRIVE');
    if (recall.parkOutSide) alerts.push('PARK OUTSIDE');
    if (recall.overTheAirUpdate) alerts.push('OTA UPDATE AVAILABLE');
    const alert = alerts.length > 0 ? ` **${alerts.join(' | ')}**` : '';

    lines.push(`**${recall.campaignNumber}** — ${recall.component}${alert}`);
    lines.push(`*Manufacturer:* ${recall.manufacturer}`);
    lines.push(recall.summary ?? 'Summary: Not available');
    lines.push(`*Consequence:* ${formatText(recall.consequence)}`);
    lines.push(`*Remedy:* ${formatText(recall.remedy)}`);
    lines.push(`*Date:* ${recall.reportReceivedDate}`);
    lines.push(`*Advisories:* ${formatRecallAdvisories(recall)}\n`);
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
  lines.push('**Components:**');
  for (const component of summary.componentBreakdown) {
    lines.push(
      `- ${component.component}: ${component.count} ${pluralize(component.count, 'complaint')} (${component.crashCount} ${pluralize(component.crashCount, 'crash', 'crashes')}, ${component.fireCount} ${pluralize(component.fireCount, 'fire')}, ${component.injuryCount} ${pluralize(component.injuryCount, 'injury', 'injuries')}, ${component.deathCount} ${pluralize(component.deathCount, 'death')})`,
    );
  }

  return lines;
}

/** Sections in reading order, as the notices name them. */
const SECTION_LABELS: Record<VehicleSafetySection, string> = {
  safetyRatings: 'NCAP ratings',
  recalls: 'recalls',
  complaints: 'complaints',
};

/**
 * The notice routing empty sections to the model names NHTSA files the vehicle under, composed
 * from section results alone, never from caller text. `counts` holds each section's record
 * count, undefined where the section failed to load: a failed section is neither empty nor
 * populated. Every section empty gets the all-empty notice. Recalls or complaints empty while
 * another section has records gets one naming the empty sections; empty NCAP ratings alone never
 * fire it, since NCAP rates only some vehicles.
 */
function modelNameNotice(counts: Record<VehicleSafetySection, number | undefined>) {
  const sections = Object.keys(SECTION_LABELS) as VehicleSafetySection[];
  const empty = sections.filter((section) => counts[section] === 0);
  const populated = sections.filter((section) => (counts[section] ?? 0) > 0);
  if (empty.length === sections.length) {
    return 'No NCAP ratings, recalls, or complaints matched this vehicle. It may have a clean record, or NHTSA may list its records under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search under each.';
  }
  if (populated.length === 0 || empty.every((section) => section === 'safetyRatings')) return;
  const name = (list: VehicleSafetySection[], conjunction: 'and' | 'or') =>
    list.map((section) => SECTION_LABELS[section]).join(` ${conjunction} `);
  return `No ${name(empty, 'or')} matched, though ${name(populated, 'and')} did. NHTSA's datasets can file one vehicle under different model names. List them with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search the empty sections under those names.`;
}

export const getVehicleSafety = tool('nhtsa_get_vehicle_safety', {
  description:
    'Get a comprehensive safety profile for a vehicle. Combines NCAP crash test ratings, recalls, and complaint summary into a single response. Use as the default when asked about vehicle safety, reliability, or purchase decisions.',
  annotations: { readOnlyHint: true },
  input: z.object({
    make: z
      .string()
      .trim()
      .min(1)
      .describe('Nonblank vehicle manufacturer (e.g., "Toyota", "Ford"). Case-insensitive.'),
    model: z
      .string()
      .trim()
      .min(1)
      .describe('Nonblank vehicle model (e.g., "Camry", "F-150"). Case-insensitive.'),
    modelYear: z.number().int().describe('Model year, a whole number (e.g., 2020).'),
  }),
  output: vehicleSafetyOutputSchema,
  enrichment: {
    effectiveQuery: z.string().describe('The vehicle queried, as "make model modelYear".'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no section matched the vehicle, or when recalls or complaints matched nothing while another section had records. NHTSA can file one vehicle under different model names in each dataset, so the notice names the lookup that lists them.',
      ),
  },

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
        warning: 'Complaint data could not be retrieved.',
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
    const recallResults = sectionStatus.recalls === 'available' && recalls ? recalls : undefined;
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

    ctx.enrich({ effectiveQuery: `${make} ${model} ${modelYear}` });
    const notice = modelNameNotice({
      safetyRatings: safetyRatings?.length,
      recalls: recallResults?.length,
      complaints: complaintSummary?.totalCount,
    });
    if (notice) ctx.enrich.notice(notice);

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

  /**
   * Zero matching variants means the NHTSA query succeeded and matched nothing — the same
   * state the recalls and complaints sections report as 'available' with no rows. Leaving the
   * status alone routes format() to the no-coverage copy instead of the fetch-failure copy,
   * and the empty array states the absence of coverage to structured-only consumers, for whom
   * an omitted field would be indistinguishable from a field the response never carried.
   */
  if (variants.length === 0) {
    return [];
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
