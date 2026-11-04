/**
 * @fileoverview Decode VINs to extract vehicle identification, specs, and safety equipment,
 * driver-assistance features included. Takes one VIN or several, joined in a string or listed in
 * an array; decodes up to 50 per call and hands the rest back for a follow-up call.
 * @module mcp-server/tools/definitions/decode-vin.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { holdToCap } from '@/mcp-server/tools/request-cap.js';
import { getNhtsaService } from '@/services/nhtsa/nhtsa-service.js';

/** VINs one call decodes; past this, the rest come back in `deferredVins`. */
const MAX_BATCH_SIZE = 50;
/** VINs one call takes, counted after joined strings are split. */
const MAX_VINS_PER_CALL = 500;
const VIN_LENGTH = 17;

/** Whitespace and `;` separate the chunks of a string; `,` separates VINs within a chunk. */
const CHUNK_SEPARATOR = /[\s;]+/;
/** A `VIN,YYYY` chunk — VPIC's batch syntax for one VIN with its own model year. */
const VIN_WITH_YEAR = /^([A-Za-z0-9*]{1,17}),([0-9]{4})$/;
/** The longest chunk {@link VIN_WITH_YEAR} can match, so a longer one skips the test. */
const MAX_VIN_WITH_YEAR_LENGTH = VIN_LENGTH + 5;
const VIN_CHAR = /^[A-Za-z0-9*]$/;
/** Characters of a VIN an error message quotes before cutting it short. */
const QUOTED_VIN_CHARS = 32;

const OPTIONAL_CAVEAT =
  'Optional: offered on this configuration; the VIN does not record whether this vehicle has it.';

/** A VIN to decode, with the model year its own `VIN,YYYY` chunk gave it. */
interface RequestedVin {
  modelYear?: number;
  vin: string;
}

type ParsedVins =
  | { readonly kind: 'vins'; readonly vins: RequestedVin[] }
  | { readonly kind: 'blank'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const BLANK_MESSAGE =
  'At least one non-empty VIN is required, and every VIN entry must be nonblank.';

/**
 * Split the `vin` input into the VINs it names, in order. Each string is NFKC-normalized and
 * trimmed, then split on whitespace and `;`, and each chunk on `,` — except a `VIN,YYYY` chunk,
 * which is one VIN with its own model year. A VIN is 1–17 letters, digits, or `*`, and a string
 * naming several VINs takes only full 17-character ones: a separator inside a single VIN would
 * otherwise split it into partials that each decode as something else.
 */
function parseVins(input: string | readonly string[]): ParsedVins {
  const entries = typeof input === 'string' ? [input] : input;
  if (entries.length === 0) return { kind: 'blank', message: BLANK_MESSAGE };

  const vins: RequestedVin[] = [];
  for (const [index, entry] of entries.entries()) {
    const where = typeof input === 'string' ? 'vin' : `vin[${index}]`;
    const named = entryVins(entry.normalize('NFKC').trim());
    if (named.length === 0) {
      return { kind: 'blank', message: `${where} names no VIN. ${BLANK_MESSAGE}` };
    }
    for (const { vin } of named) {
      const problem = vinProblem(vin);
      if (problem) return { kind: 'invalid', message: `${where}: ${quoteVin(vin)} ${problem}` };
    }
    const partial = named.length > 1 ? named.find(({ vin }) => vin.length < VIN_LENGTH) : undefined;
    if (partial) {
      return {
        kind: 'invalid',
        message: `${where}: ${quoteVin(partial.vin)} is ${partial.vin.length} characters, but an entry naming several VINs takes only full ${VIN_LENGTH}-character VINs. Send a partial VIN as its own entry, or remove the separator if the entry is one VIN.`,
      };
    }
    for (const requested of named) vins.push(requested);
  }
  return { kind: 'vins', vins };
}

/** The VINs one normalized, trimmed entry names, unvalidated; empty pieces are dropped. */
function entryVins(text: string): RequestedVin[] {
  const vins: RequestedVin[] = [];
  for (const chunk of text.split(CHUNK_SEPARATOR)) {
    const withYear =
      chunk.length <= MAX_VIN_WITH_YEAR_LENGTH ? VIN_WITH_YEAR.exec(chunk) : undefined;
    if (withYear?.[1] && withYear[2]) {
      vins.push({ vin: withYear[1], modelYear: Number(withYear[2]) });
      continue;
    }
    for (const piece of chunk.split(',')) {
      if (piece) vins.push({ vin: piece });
    }
  }
  return vins;
}

/** Why `vin` is not a VIN — its first character outside the alphabet, or its length — if it isn't. */
function vinProblem(vin: string): string | undefined {
  let length = 0;
  for (const char of vin) {
    length++;
    if (!VIN_CHAR.test(char)) {
      return `has ${describeChar(char)} at position ${length}; a VIN holds only the letters A-Z (any case), digits, and * for an unknown position.`;
    }
  }
  return length > VIN_LENGTH
    ? `is ${length} characters; a VIN has at most ${VIN_LENGTH}.`
    : undefined;
}

/** A character as a message names it: quoted, with its code point unless it is printable ASCII. */
function describeChar(char: string): string {
  if (/^[!-~]$/.test(char)) return `"${char}"`;
  const codePoint = `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`;
  return /^\p{C}$/u.test(char) ? codePoint : `"${char}" (${codePoint})`;
}

/** A VIN as a message quotes it, cut after {@link QUOTED_VIN_CHARS} characters. */
function quoteVin(vin: string): string {
  const head = Array.from(vin.slice(0, QUOTED_VIN_CHARS * 2))
    .slice(0, QUOTED_VIN_CHARS)
    .join('');
  return head.length < vin.length ? `"${head}…"` : `"${vin}"`;
}

/**
 * A driver-assistance feature as VPIC decodes it for the VIN's configuration, named by VPIC's
 * variable name.
 */
function feature(name: string) {
  return z
    .string()
    .optional()
    .describe(
      `${name}: Standard, Optional, or Not Available for this VIN's configuration. Optional means the configuration offers it; the VIN does not record whether this vehicle has it. Omitted when VPIC leaves it blank.`,
    );
}

const decodedVinSchema = z
  .object({
    vin: z.string().describe('The decoded VIN, echoed back from the request'),
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
    airBagLocSeatCushion: z
      .string()
      .optional()
      .describe(
        'Seat Cushion Air Bag Locations: a seating position, from Driver Seat Only or Passenger Seat Only through 1st Row (Driver and Passenger) to All Rows. Omitted when VPIC leaves it blank.',
      ),
    electronicStabilityControl: z.string().optional().describe('ESC availability'),
    abs: z.string().optional().describe('ABS availability'),
    tractionControl: z.string().optional().describe('Traction control availability'),
    tpmsType: z
      .string()
      .optional()
      .describe(
        'Tire Pressure Monitoring System (TPMS) Type: Direct or Indirect. Omitted when VPIC leaves it blank.',
      ),
    crashImminentBraking: feature('Crash Imminent Braking (CIB)'),
    dynamicBrakeSupport: feature('Dynamic Brake Support (DBS)'),
    pedestrianAutomaticEmergencyBraking: feature('Pedestrian Automatic Emergency Braking (PAEB)'),
    forwardCollisionWarning: feature('Forward Collision Warning (FCW)'),
    laneDepartureWarning: feature('Lane Departure Warning (LDW)'),
    laneKeepingAssistance: feature('Lane Keeping Assistance (LKA)'),
    laneCenteringAssistance: feature('Lane Centering Assistance'),
    blindSpotWarning: feature('Blind Spot Warning (BSW)'),
    blindSpotIntervention: feature('Blind Spot Intervention (BSI)'),
    rearCrossTrafficAlert: feature('Rear Cross Traffic Alert'),
    backupCamera: feature('Backup Camera'),
    rearAutomaticEmergencyBraking: feature('Rear Automatic Emergency Braking'),
    parkingAssist: feature('Parking Assist'),
    adaptiveCruiseControl: feature('Adaptive Cruise Control (ACC)'),
    errorCode: z.string().optional().describe('VPIC error code (0 = no error)'),
    errorText: z.string().optional().describe('VPIC error or warning text'),
  })
  .describe('Decoded details for a single VIN');

type DecodedVinField = keyof z.infer<typeof decodedVinSchema>;

/**
 * The safety equipment `content[]` lists, in order, each with its label. The driver-assistance
 * fields and the seat-cushion and TPMS fields carry VPIC's own variable names.
 */
const SAFETY_EQUIPMENT: ReadonlyArray<readonly [DecodedVinField, string]> = [
  ['airBagLocFront', 'Front airbags'],
  ['airBagLocSide', 'Side airbags'],
  ['airBagLocCurtain', 'Curtain airbags'],
  ['airBagLocKnee', 'Knee airbags'],
  ['airBagLocSeatCushion', 'Seat Cushion Air Bag Locations'],
  ['electronicStabilityControl', 'ESC'],
  ['abs', 'ABS'],
  ['tractionControl', 'Traction control'],
  ['tpmsType', 'Tire Pressure Monitoring System (TPMS) Type'],
  ['crashImminentBraking', 'Crash Imminent Braking (CIB)'],
  ['dynamicBrakeSupport', 'Dynamic Brake Support (DBS)'],
  ['pedestrianAutomaticEmergencyBraking', 'Pedestrian Automatic Emergency Braking (PAEB)'],
  ['forwardCollisionWarning', 'Forward Collision Warning (FCW)'],
  ['laneDepartureWarning', 'Lane Departure Warning (LDW)'],
  ['laneKeepingAssistance', 'Lane Keeping Assistance (LKA)'],
  ['laneCenteringAssistance', 'Lane Centering Assistance'],
  ['blindSpotWarning', 'Blind Spot Warning (BSW)'],
  ['blindSpotIntervention', 'Blind Spot Intervention (BSI)'],
  ['rearCrossTrafficAlert', 'Rear Cross Traffic Alert'],
  ['backupCamera', 'Backup Camera'],
  ['rearAutomaticEmergencyBraking', 'Rear Automatic Emergency Braking'],
  ['parkingAssist', 'Parking Assist'],
  ['adaptiveCruiseControl', 'Adaptive Cruise Control (ACC)'],
];

export const decodeVin = tool('nhtsa_decode_vin', {
  description:
    'Decode Vehicle Identification Numbers to extract make, model, year, body type, engine, manufacturing details, and safety equipment: airbags, stability and braking systems, tire pressure monitoring, and the driver-assistance features VPIC records for the configuration, such as automatic emergency braking, lane keeping, blind spot warning, backup camera, and adaptive cruise control. Pass one VIN, or several as an array or in one string separated by spaces, semicolons, or commas. Partial VINs are accepted, with * for unknown positions; send each partial VIN as its own string or array entry. A call decodes up to 50 VINs; VINs past the first 50 come back in deferredVins to pass back as vin.',
  annotations: { readOnlyHint: true },
  input: z.object({
    vin: z
      .union([
        z.string().describe('One VIN, or several separated by spaces, semicolons, or commas.'),
        z
          .array(z.string())
          .max(MAX_VINS_PER_CALL)
          .describe(
            `VINs, one per entry or several per entry as in a single string; at most ${MAX_VINS_PER_CALL} entries.`,
          ),
      ])
      .describe(
        `One VIN or several. A VIN is up to 17 letters, digits, or * for an unknown position (e.g., "1HGCM82633A004352"). Separate several VINs in one string with spaces, semicolons, or commas, or list them in an array; a string naming several VINs takes only full 17-character VINs, so send a partial VIN alone. Append ,YYYY to give one VIN its own model year (e.g., "1HGCM82633A004352,2003"). A call decodes up to ${MAX_BATCH_SIZE} VINs and takes at most ${MAX_VINS_PER_CALL}; VINs past the first ${MAX_BATCH_SIZE} come back in deferredVins.`,
      ),
    modelYear: z
      .number()
      .int()
      .optional()
      .describe(
        'Model year, a whole number, for every VIN without its own ,YYYY. Helps resolve ambiguity for pre-1980 or partial VINs.',
      ),
  }),
  output: z.object({
    vehicles: z.array(decodedVinSchema).describe('Decoded vehicle information per VIN'),
    deferredVins: z
      .array(z.string())
      .optional()
      .describe(
        `VINs past the first ${MAX_BATCH_SIZE}, in the order sent, present when the call named more VINs than it decodes. Each carries its model year as VIN,YYYY when one applied; pass this list as vin to decode them.`,
      ),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'Number of VINs named and the path taken (single or batch), with how many were decoded and deferred when VINs were deferred.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        `Present when VINs past the first ${MAX_BATCH_SIZE} were deferred to deferredVins, or when VINs decoded with VPIC warnings (errorCode != 0) — check errorCode/errorText per vehicle.`,
      ),
  },
  errors: [
    {
      reason: 'empty_vin_list',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The VIN list is empty, or an entry is blank or holds only separators.',
      recovery: 'Provide at least one VIN and remove every blank entry before retrying.',
    },
    {
      reason: 'invalid_vin',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A VIN holds a character other than a letter A-Z, a digit, or *, runs past 17 characters, or is a partial VIN in a string that names several VINs.',
      recovery:
        'Send each VIN as up to 17 letters, digits, or *, and send each partial VIN as its own string or array entry.',
    },
    {
      reason: 'batch_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `The input names more than ${MAX_VINS_PER_CALL} VINs, or more than ${MAX_BATCH_SIZE} on a server set to reject an over-cap batch rather than defer the rest.`,
      recovery: `Split the VIN list into batches of ${MAX_BATCH_SIZE} or fewer.`,
    },
  ],

  async handler(input, ctx) {
    const parsed = parseVins(input.vin);
    if (parsed.kind === 'blank') throw ctx.fail('empty_vin_list', parsed.message);
    if (parsed.kind === 'invalid') throw ctx.fail('invalid_vin', parsed.message);
    const named = parsed.vins.length;

    if (named > MAX_VINS_PER_CALL) {
      throw ctx.fail(
        'batch_too_large',
        `vin names ${named} VINs; one call takes at most ${MAX_VINS_PER_CALL}.`,
      );
    }
    const batch = holdToCap(ctx, {
      tool: 'nhtsa_decode_vin',
      input: 'vin',
      requested: named,
      cap: MAX_BATCH_SIZE,
    });
    if (batch.kind === 'rejected') {
      throw ctx.fail(
        'batch_too_large',
        `vin names ${batch.requested} VINs; one call decodes at most ${batch.cap}.`,
      );
    }

    /** A VIN's own `,YYYY` wins; `modelYear` covers the rest. */
    const requested: RequestedVin[] = parsed.vins.map(({ vin, modelYear = input.modelYear }) =>
      modelYear != null ? { vin, modelYear } : { vin },
    );
    const toDecode = requested.slice(0, batch.applied);
    const deferredVins = requested
      .slice(batch.applied)
      .map(({ vin, modelYear }) => (modelYear != null ? `${vin},${modelYear}` : vin));

    const svc = getNhtsaService();
    const [only] = toDecode;
    const isSingle = only != null && toDecode.length === 1;
    const vehicles = isSingle
      ? await svc.decodeVin(only.vin, only.modelYear, ctx.signal).then((v) => (v ? [v] : []))
      : await svc.decodeVinBatch(toDecode, ctx.signal);

    ctx.log.info('VIN decode', {
      count: toDecode.length,
      deferred: deferredVins.length,
      results: vehicles.length,
    });

    const path = `${named} VIN${named === 1 ? '' : 's'} (${isSingle ? 'single' : 'batch'})`;
    ctx.enrich({
      effectiveQuery:
        deferredVins.length > 0
          ? `${path}: decoded ${toDecode.length}, deferred ${deferredVins.length}`
          : path,
    });

    /** `notice` is last-wins, so every notice this call raises goes out as one. */
    const notices: string[] = [];
    if (deferredVins.length > 0) {
      notices.push(
        `vin names ${named} VINs, more than the ${MAX_BATCH_SIZE} one call decodes: decoded the first ${toDecode.length} and returned the other ${deferredVins.length} in deferredVins — pass deferredVins as vin to decode them.`,
      );
    }
    const partialDecodes = vehicles.filter((v) => v.errorCode != null && v.errorCode !== '0');
    if (partialDecodes.length > 0) {
      notices.push(
        `${partialDecodes.length} VIN${partialDecodes.length === 1 ? '' : 's'} decoded with VPIC warnings — check errorCode/errorText per vehicle for decode quality.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { vehicles, ...(deferredVins.length > 0 ? { deferredVins } : {}) };
  },

  format: (result) => {
    /** Every value below is VPIC's or the caller's text — a partial VIN's `*` included. */
    const esc = escapeMarkdownInline;
    /** The values VPIC supplied, escaped, in order. */
    const present = (...values: (string | undefined)[]) =>
      values.flatMap((value) => (value ? [esc(value)] : []));
    const lines: string[] = [];
    if (result.vehicles.length === 0) lines.push('No VIN decode results.');

    for (const v of result.vehicles) {
      lines.push(`## ${esc(v.vin)}\n`);

      /**
       * VPIC reports decode quality on every result, "0" included. Render the clean case too,
       * so a VIN that decoded without errors says so rather than saying nothing — which is
       * otherwise indistinguishable from VPIC omitting the field.
       */
      if (v.errorCode != null) {
        lines.push(
          v.errorCode === '0'
            ? `**Decode status (errorCode: 0):** ${esc(v.errorText?.trim() || 'VPIC decoded this VIN with no errors.')}\n`
            : `**Warning (errorCode: ${esc(v.errorCode)}):** ${esc(v.errorText?.trim() || 'VPIC returned a decode warning.')}\n`,
        );
      }

      const summaryParts = present(v.modelYear, v.make, v.model);
      if (summaryParts.length > 0) {
        lines.push(`**${summaryParts.join(' ')}**${v.trim ? ` ${esc(v.trim)}` : ''}`);
      } else if (v.trim) {
        lines.push(`**Trim:** ${esc(v.trim)}`);
      } else {
        lines.push('**Vehicle details:** Not available');
      }

      const classification = present(v.bodyClass, v.vehicleType);
      if (classification.length > 0) {
        lines.push(classification.join(' | '));
      }
      if (v.driveType) {
        lines.push(esc(v.driveType));
      }
      lines.push('');

      const engineParts = [
        v.engineCylinders ? `${esc(v.engineCylinders)}-cyl` : '',
        v.engineDisplacementL ? `${esc(v.engineDisplacementL)}L` : '',
        v.engineHP ? `${esc(v.engineHP)} HP` : '',
        ...present(v.fuelType),
      ].filter(Boolean);
      if (engineParts.length > 0) {
        lines.push(`**Engine:** ${engineParts.join(', ')}`);
      }

      const plant = present(v.plantCity, v.plantState, v.plantCountry);
      if (plant.length > 0) lines.push(`**Manufactured:** ${plant.join(', ')}`);
      if (v.manufacturer) lines.push(`**Manufacturer:** ${esc(v.manufacturer)}`);

      const safetyEquipment = SAFETY_EQUIPMENT.flatMap(([field, label]) => {
        const value = v[field];
        return value ? [{ label, value }] : [];
      });
      if (safetyEquipment.length > 0) {
        lines.push('\n**Safety Equipment:**');
        lines.push(...safetyEquipment.map(({ label, value }) => `- ${label}: ${esc(value)}`));
        if (safetyEquipment.some(({ value }) => value === 'Optional')) {
          lines.push('', OPTIONAL_CAVEAT);
        }
      }
      lines.push('');
    }

    if (result.deferredVins?.length) {
      lines.push(
        `**Deferred VINs (${result.deferredVins.length})** — pass these as vin to decode them:`,
      );
      lines.push(...result.deferredVins.map((vin) => `- ${esc(vin)}`));
    }

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
