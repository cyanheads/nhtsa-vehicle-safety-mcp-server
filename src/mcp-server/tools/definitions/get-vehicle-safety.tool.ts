/**
 * @fileoverview Composite vehicle safety profile tool — combines crash test ratings, recalls,
 * complaints, and the defect investigations covering the vehicle into a single response.
 * @module mcp-server/tools/definitions/get-vehicle-safety.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { BoundedLoad } from '@/services/nhtsa/flat-file.js';
import {
  formatInvestigationDates,
  formatInvestigationHeading,
  formatRecallAdvisories,
  formatRolloverProbability,
  formatStars,
  formatText,
  pluralize,
  renderNotice,
} from '@/services/nhtsa/format.js';
import {
  type InvestigationVehicleFilter,
  investigationStatusName,
  investigationTypeName,
  matchedModels,
} from '@/services/nhtsa/investigation-match.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';
import type {
  Complaint,
  Investigation,
  SafetyRating,
  SafetyRatingVariant,
} from '@/services/nhtsa/types.js';
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
    notes: z
      .string()
      .optional()
      .describe(
        "NHTSA's recall notes as published: the defect description for many campaigns received before 2000, and NHTSA's hotline sentence on most received since 2010. Omitted when NHTSA sends none.",
      ),
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

const investigationSchema = z
  .object({
    nhtsaId: z
      .string()
      .optional()
      .describe(
        'NHTSA investigation ID. Pass it to nhtsa_search_investigations as nhtsaId for the full summary.',
      ),
    investigationType: z
      .string()
      .optional()
      .describe('Investigation type code, the letters that open the ID (e.g., "PE")'),
    investigationTypeName: z
      .string()
      .optional()
      .describe(
        'Investigation type name (e.g., "Preliminary Evaluation"), or the code for a type without one',
      ),
    status: z.string().optional().describe('Status code: "O" (open) or "C" (closed)'),
    statusName: z.string().optional().describe('Status name'),
    subject: z.string().optional().describe('Investigation subject'),
    openDate: z.string().optional().describe('Date the investigation opened (YYYY-MM-DD)'),
    closeDate: z
      .string()
      .optional()
      .describe('Date the investigation closed (YYYY-MM-DD), if closed'),
    recallCampaigns: z
      .array(z.string())
      .optional()
      .describe(
        'Recall campaigns NHTSA links to the investigation — pass any to nhtsa_search_recalls as campaignNumber',
      ),
    matchedModels: z
      .array(z.string())
      .describe(
        'Model names on the investigation\'s vehicle associations that carry this make, model, and model year. The model matches within a longer name, so "Cherokee" also matches "GRAND CHEROKEE".',
      ),
  })
  .describe('A defect investigation covering this vehicle');

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
  investigations: z
    .enum(['available', 'unavailable'])
    .describe(
      "Availability of defect investigation data in this response. Unavailable when NHTSA's investigation file failed to load, or was still loading 30 s into the call.",
    ),
});

const vehicleSafetyOutputSchema = z.object({
  safetyRatings: z
    .array(safetyRatingSchema)
    .optional()
    .describe('Crash test ratings per vehicle variant (e.g., FWD vs AWD)'),
  recalls: z.array(recallSchema).optional().describe('All recalls for this vehicle when available'),
  complaintSummary: complaintSummarySchema.optional().describe('Summary of consumer complaints'),
  investigations: z
    .array(investigationSchema)
    .optional()
    .describe(
      'Every defect investigation covering this vehicle, newest-opened first, when available. Rows omit summaries.',
    ),
  sectionStatus: sectionStatusSchema.describe('Availability of each data section in this response'),
  warnings: z
    .array(z.string())
    .describe('Warnings about sections that could not be loaded from NHTSA'),
});

type VehicleSafetyOutput = z.infer<typeof vehicleSafetyOutputSchema>;
type SectionStatus = VehicleSafetyOutput['sectionStatus'];
type SafetyRatingsResult = NonNullable<VehicleSafetyOutput['safetyRatings']>;
type ComplaintSummary = NonNullable<VehicleSafetyOutput['complaintSummary']>;
type InvestigationRow = NonNullable<VehicleSafetyOutput['investigations']>[number];

const EMPTY_COMPLAINT_SUMMARY = {
  totalCount: 0,
  componentBreakdown: [],
  crashCount: 0,
  fireCount: 0,
  injuryCount: 0,
  deathCount: 0,
} satisfies ComplaintSummary;

const INVESTIGATIONS_FAILED = 'Investigation data could not be retrieved.';
const INVESTIGATIONS_STILL_LOADING =
  'Investigation data is still loading from NHTSA; a later call will include it once the load finishes.';

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

function toInvestigationRow(investigation: Investigation, models: string[]): InvestigationRow {
  const { investigationType, status } = investigation;
  return {
    ...omitUndefined({
      nhtsaId: investigation.nhtsaId,
      investigationType,
      investigationTypeName: investigationType
        ? investigationTypeName(investigationType)
        : undefined,
      status,
      statusName: status ? investigationStatusName(status) : undefined,
      subject: investigation.subject,
      openDate: investigation.openDate,
      closeDate: investigation.closeDate,
      recallCampaigns: investigation.recallCampaigns,
    }),
    matchedModels: models,
  };
}

/**
 * A failed section request becomes `null` through `onError`, unless the caller cancelled: a
 * cancellation propagates rather than reading as a section NHTSA failed to serve.
 */
function loadSection<T>(
  request: Promise<T>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<T | null> {
  return request.catch((error) => {
    signal.throwIfAborted();
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
    lines.push(`### Vehicle ${rating.vehicleId}`);
    lines.push(`**Description:** ${formatText(rating.vehicleDescription)}`);
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

    lines.push(
      `**${escapeMarkdownInline(recall.campaignNumber)}** — ${escapeMarkdownInline(recall.component)}${alert}`,
    );
    lines.push(`*Manufacturer:* ${escapeMarkdownInline(recall.manufacturer)}`);
    lines.push(recall.summary ? escapeMarkdownInline(recall.summary) : 'Summary: Not available');
    if (recall.notes) lines.push(`*Notes:* ${escapeMarkdownInline(recall.notes)}`);
    lines.push(`*Consequence:* ${formatText(recall.consequence)}`);
    lines.push(`*Remedy:* ${formatText(recall.remedy)}`);
    lines.push(`*Date:* ${escapeMarkdownInline(recall.reportReceivedDate)}`);
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
      `- ${escapeMarkdownInline(component.component)}: ${component.count} ${pluralize(component.count, 'complaint')} (${component.crashCount} ${pluralize(component.crashCount, 'crash', 'crashes')}, ${component.fireCount} ${pluralize(component.fireCount, 'fire')}, ${component.injuryCount} ${pluralize(component.injuryCount, 'injury', 'injuries')}, ${component.deathCount} ${pluralize(component.deathCount, 'death')})`,
    );
  }

  return lines;
}

/**
 * Model names join on "; " because some contain commas and none a semicolon; campaign numbers
 * contain neither. Each list is joined, then escaped as one string: escaped element by element,
 * a value ending `&amp` would form an entity with the separator's `;`.
 */
function formatInvestigationsSection(result: VehicleSafetyOutput): string[] {
  const lines: string[] = [];

  if (result.sectionStatus.investigations === 'unavailable') {
    lines.push('## Investigations\n');
    lines.push(
      'Investigation data was unavailable for this request. nhtsa_search_investigations with the same make, model, and modelYear lists them once the data loads.\n',
    );
    return lines;
  }

  const investigations = result.investigations ?? [];
  lines.push(`## Investigations (${investigations.length})\n`);
  if (investigations.length === 0) {
    lines.push('No investigations found.\n');
    return lines;
  }

  lines.push(
    'Rows leave out summaries: read one with nhtsa_search_investigations, passing its nhtsaId.\n',
  );
  for (const i of investigations) {
    lines.push(...formatInvestigationHeading(i));
    if (i.subject) lines.push(`**Subject:** ${escapeMarkdownInline(i.subject)}`);
    lines.push(`**Matched models:** ${escapeMarkdownInline(i.matchedModels.join('; '))}`);
    lines.push(formatInvestigationDates(i));
    if (i.recallCampaigns && i.recallCampaigns.length > 0) {
      lines.push(`**Recall Campaigns:** ${escapeMarkdownInline(i.recallCampaigns.join(', '))}`);
    }
    lines.push('');
  }

  return lines;
}

/** Sections in reading order, as the notices name them. */
const SECTION_LABELS: Record<VehicleSafetySection, string> = {
  safetyRatings: 'NCAP ratings',
  recalls: 'recalls',
  complaints: 'complaints',
  investigations: 'investigations',
};

/**
 * Sections that cover only some vehicles: NCAP rates a subset, and most vehicles have never been
 * investigated. Empty, they never fire the model-name notice on their own.
 */
const PARTIAL_COVERAGE_SECTIONS: ReadonlySet<VehicleSafetySection> = new Set([
  'safetyRatings',
  'investigations',
]);

/** "a", "a or b", "a, b, or c" — and the same with "and". */
const sectionLists = {
  and: new Intl.ListFormat('en', { type: 'conjunction' }),
  or: new Intl.ListFormat('en', { type: 'disjunction' }),
};

/**
 * Follows the dataset tag list whenever investigations are among the empty sections: no list
 * tags investigation names, and the investigation search matches within a model name.
 */
const INVESTIGATIONS_NAME_CLAUSE =
  ' For investigations, any of the listed names works: nhtsa_search_investigations matches part of a model name.';

/**
 * The notice routing empty sections to the model names NHTSA files the vehicle under, composed
 * from section results alone, never from caller text. `counts` holds each section's record
 * count, undefined where the section failed to load: a failed section is neither empty nor
 * populated. Investigations that failed or are still loading leave the comparison instead: they
 * are best-effort and often still loading, so they never silence the notice the other three
 * sections call for. Every remaining section empty gets the all-empty notice. Recalls or
 * complaints empty while another section has records gets one naming the empty sections; empty
 * NCAP ratings or investigations alone never fire it.
 */
function modelNameNotice(counts: Record<VehicleSafetySection, number | undefined>) {
  const sections = (Object.keys(SECTION_LABELS) as VehicleSafetySection[]).filter(
    (section) => section !== 'investigations' || counts.investigations !== undefined,
  );
  const empty = sections.filter((section) => counts[section] === 0);
  const populated = sections.filter((section) => (counts[section] ?? 0) > 0);
  const name = (list: VehicleSafetySection[], conjunction: 'and' | 'or') =>
    sectionLists[conjunction].format(list.map((section) => SECTION_LABELS[section]));
  const investigationsClause = empty.includes('investigations') ? INVESTIGATIONS_NAME_CLAUSE : '';
  if (empty.length === sections.length) {
    return `No ${name(empty, 'or')} matched this vehicle. It may have a clean record, or NHTSA may list its records under another model name. List the names with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search each dataset under the names it tags for it: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings.${investigationsClause}`;
  }
  if (populated.length === 0 || empty.every((section) => PARTIAL_COVERAGE_SECTIONS.has(section))) {
    return;
  }
  return `No ${name(empty, 'or')} matched, though ${name(populated, 'and')} did. NHTSA's datasets can file one vehicle under different model names. List them with nhtsa_lookup_vehicles operation="dataset_models" for this make and model year, then search the empty sections under the names it tags for each: "recalls" for recalls, "products" for complaints, "ncap" for NCAP ratings.${investigationsClause}`;
}

export const getVehicleSafety = tool('nhtsa_get_vehicle_safety', {
  description:
    'Get a comprehensive safety profile for a vehicle. Combines NCAP crash test ratings, recalls, a complaint summary, and the defect investigations covering the vehicle into a single response. Use as the default when asked about vehicle safety, reliability, or purchase decisions. Investigation rows omit summaries: read one with nhtsa_search_investigations by nhtsaId.',
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
        'Guidance when no section matched the vehicle, or when recalls or complaints matched nothing while another section had records; empty NCAP ratings or investigations alone never trigger it. NHTSA can file one vehicle under different model names in each dataset, so the notice names the lookup that lists them and the tag marking the names each dataset uses; empty investigations take any listed name.',
      ),
  },
  enrichmentTrailer: { notice: { render: renderNotice } },

  async handler(input, ctx) {
    const svc = getNhtsaService();
    const { make, model, modelYear } = input;
    const requestContext = { make, model, modelYear };

    const warnings: string[] = [];
    const sectionStatus: SectionStatus = {
      safetyRatings: 'available',
      recalls: 'available',
      complaints: 'available',
      investigations: 'available',
    };

    const [variants, recalls, complaints, investigationLoad] = await Promise.all([
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
      svc.getInvestigationsWithin(ctx.signal),
    ]);

    const safetyRatings = await resolveSafetyRatings(svc, variants, ctx, warnings, sectionStatus);
    const recallResults = sectionStatus.recalls === 'available' && recalls ? recalls : undefined;
    const complaintSummary =
      sectionStatus.complaints === 'available' && complaints
        ? summarizeComplaints(complaints)
        : undefined;
    const investigations = resolveInvestigations(
      investigationLoad,
      requestContext,
      ctx,
      warnings,
      sectionStatus,
    );

    ctx.log.info('Vehicle safety profile assembled', {
      make,
      model,
      modelYear,
      variants: safetyRatings?.length ?? 0,
      recalls: recallResults?.length ?? 0,
      complaints: complaintSummary?.totalCount ?? 0,
      investigations: investigations?.length ?? 0,
      safetyRatingsStatus: sectionStatus.safetyRatings,
      recallsStatus: sectionStatus.recalls,
      complaintsStatus: sectionStatus.complaints,
      investigationsStatus: sectionStatus.investigations,
    });

    ctx.enrich({ effectiveQuery: `${make} ${model} ${modelYear}` });
    const notice = modelNameNotice({
      safetyRatings: safetyRatings?.length,
      recalls: recallResults?.length,
      complaints: complaintSummary?.totalCount,
      investigations: investigations?.length,
    });
    if (notice) ctx.enrich.notice(notice);

    return {
      ...(safetyRatings && { safetyRatings }),
      ...(recallResults && { recalls: recallResults }),
      ...(complaintSummary && { complaintSummary }),
      ...(investigations && { investigations }),
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
    lines.push(...formatInvestigationsSection(result));

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

type VehicleSafetySection = keyof SectionStatus;
type VehicleSafetyContext = {
  log: {
    warning(message: string, details: Record<string, unknown>): void;
  };
  signal: AbortSignal;
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
  ctx: VehicleSafetyContext;
  request: Promise<T>;
  section: VehicleSafetySection;
  sectionStatus: SectionStatus;
  warnings: string[];
  logMessage: string;
  warning: string;
  details: Record<string, unknown>;
}): Promise<T | null> {
  return loadSection(request, ctx.signal, (error) => {
    ctx.log.warning(logMessage, { ...details, error: String(error) });
    sectionStatus[section] = 'unavailable';
    warnings.push(warning);
  });
}

async function resolveSafetyRatings(
  svc: ReturnType<typeof getNhtsaService>,
  variants: SafetyRatingVariant[] | null,
  ctx: VehicleSafetyContext,
  warnings: string[],
  sectionStatus: SectionStatus,
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
        loadSection(svc.getSafetyRating(variant.vehicleId, ctx.signal), ctx.signal, (error) => {
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

/**
 * The investigations covering the vehicle, through the matcher nhtsa_search_investigations
 * uses, in the service's newest-opened order. The wait on the shared FLAT_INV.zip load is
 * bounded: a load that failed, or is still running when the wait ends, leaves the section
 * unavailable with a warning rather than failing the call, and a still-running load goes on to
 * fill the cache for a later call.
 */
function resolveInvestigations(
  load: BoundedLoad<Investigation[]>,
  filter: InvestigationVehicleFilter,
  ctx: VehicleSafetyContext,
  warnings: string[],
  sectionStatus: SectionStatus,
): InvestigationRow[] | undefined {
  switch (load.kind) {
    case 'ready':
      return load.value.flatMap((investigation) => {
        const models = matchedModels(investigation, filter);
        return models ? [toInvestigationRow(investigation, models)] : [];
      });
    case 'pending':
      ctx.log.warning('Investigation data still loading', { ...filter });
      sectionStatus.investigations = 'unavailable';
      warnings.push(INVESTIGATIONS_STILL_LOADING);
      return;
    case 'failed':
      ctx.log.warning('Failed to load investigations', { ...filter, error: String(load.error) });
      sectionStatus.investigations = 'unavailable';
      warnings.push(INVESTIGATIONS_FAILED);
      return;
    default: {
      const unreachable: never = load;
      return unreachable;
    }
  }
}
