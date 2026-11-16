/**
 * @fileoverview Tests for the investigation matching both investigation-reading tools share
 * (investigation-match.ts): the one-association vehicle match and its matched model names, the
 * type-name lookup, and the type and status names.
 * @module tests/services/nhtsa/investigation-match
 */

import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_TYPE_MAP,
  type InvestigationVehicleFilter,
  investigationStatusName,
  investigationTypeCode,
  investigationTypeName,
  matchedModels,
} from '@/services/nhtsa/investigation-match.js';
import type { Investigation, InvestigationVehicle } from '@/services/nhtsa/types.js';

const investigation = (vehicles: InvestigationVehicle[]): Investigation => ({
  nhtsaId: 'PE20001',
  vehicles,
});

/** Associations in flat-file row order: a sibling model, a repeated model, and a row with no model. */
const jeep = investigation([
  { make: 'JEEP', model: 'GRAND CHEROKEE', year: 2014 },
  { make: 'JEEP', model: 'CHEROKEE', year: 2014 },
  { make: 'JEEP', model: 'GRAND CHEROKEE', year: 2015 },
  { make: 'JEEP', model: 'WRANGLER', year: 2015 },
  { make: 'JEEP', year: 2016 },
]);

/** #51: (HONDA, CIVIC, 2015) and (HONDA, ACCORD, 2017), but no (HONDA, CIVIC, 2017). */
const honda = investigation([
  { make: 'HONDA', model: 'CIVIC', year: 2015 },
  { make: 'HONDA', model: 'ACCORD', year: 2017 },
]);

/** (FORD, F-150) and (TOYOTA, TUNDRA), but no (FORD, TUNDRA); neither row carries a year. */
const mixed = investigation([
  { make: 'FORD', model: 'F-150' },
  { make: 'TOYOTA', model: 'TUNDRA' },
]);

interface MatchCase {
  expected: string[] | undefined;
  filter: InvestigationVehicleFilter;
  label: string;
  record: Investigation;
}

describe('matchedModels', () => {
  it.each<MatchCase>([
    // A model matches within the name, so a series query also reaches its sibling models.
    {
      label: 'a sibling model, in association order',
      record: jeep,
      filter: { make: 'Jeep', model: 'Cherokee' },
      expected: ['GRAND CHEROKEE', 'CHEROKEE'],
    },
    {
      label: 'one name per model across its years',
      record: jeep,
      filter: { model: 'grand cherokee' },
      expected: ['GRAND CHEROKEE'],
    },
    {
      label: 'model and year on one association',
      record: jeep,
      filter: { model: 'cherokee', modelYear: 2015 },
      expected: ['GRAND CHEROKEE'],
    },
    {
      label: 'make within the name, every year',
      record: jeep,
      filter: { make: 'jee' },
      expected: ['GRAND CHEROKEE', 'CHEROKEE', 'WRANGLER'],
    },
    {
      label: 'a match on a row with no model names none',
      record: jeep,
      filter: { make: 'JEEP', modelYear: 2016 },
      expected: [],
    },
    {
      label: 'a model filter never matches a row with no model',
      record: jeep,
      filter: { model: 'Cherokee', modelYear: 2016 },
      expected: undefined,
    },
    {
      label: 'no association carries the year',
      record: jeep,
      filter: { modelYear: 2017 },
      expected: undefined,
    },
    {
      label: 'no association carries the make',
      record: jeep,
      filter: { make: 'Ford' },
      expected: undefined,
    },
    // #51: every supplied value on the same association, never across rows.
    {
      label: 'make, model, and year spread across two rows',
      record: honda,
      filter: { make: 'Honda', model: 'Civic', modelYear: 2017 },
      expected: undefined,
    },
    {
      label: 'model and year on one row',
      record: honda,
      filter: { model: 'Accord', modelYear: 2017 },
      expected: ['ACCORD'],
    },
    {
      label: 'make and model within the names on one row',
      record: honda,
      filter: { make: 'honda', model: 'acc' },
      expected: ['ACCORD'],
    },
    {
      label: 'make and model spread across two rows',
      record: mixed,
      filter: { make: 'Ford', model: 'Tundra' },
      expected: undefined,
    },
    {
      label: 'make and model on the other row',
      record: mixed,
      filter: { make: 'Toyota', model: 'Tundra' },
      expected: ['TUNDRA'],
    },
    {
      label: 'a year filter on rows with no year',
      record: mixed,
      filter: { model: 'F-150', modelYear: 2015 },
      expected: undefined,
    },
    {
      label: 'no associations',
      record: investigation([]),
      filter: { make: 'Honda' },
      expected: undefined,
    },
  ])('$label', ({ record, filter, expected }) => {
    expect(matchedModels(record, filter)).toStrictEqual(expected);
  });

  it('matches a row with no make only when make is unfiltered', () => {
    const record = investigation([{ model: 'CIVIC', year: 2015 }]);

    expect(matchedModels(record, { model: 'Civic', modelYear: 2015 })).toStrictEqual(['CIVIC']);
    expect(matchedModels(record, { make: 'Honda', model: 'Civic' })).toBeUndefined();
  });
});

describe('investigationTypeCode', () => {
  it.each([
    ['Preliminary Evaluation', 'PE'],
    [' preliminary evaluation ', 'PE'],
    ['ENGINEERING ANALYSIS', 'EA'],
    ['Defect Petition', 'DP'],
    ['recall query', 'RQ'],
    ['\tAudit Query\n', 'AQ'],
    // Codes come back trimmed and uppercased, a fixture-only prefix included.
    ['pe', 'PE'],
    [' ea ', 'EA'],
    ['xy', 'XY'],
    // Names match whole: a part of a name, or a name with doubled inner space, is not a name.
    ['Query', 'QUERY'],
    ['Recall', 'RECALL'],
    ['Preliminary', 'PRELIMINARY'],
    ['Preliminary  Evaluation', 'PRELIMINARY  EVALUATION'],
    ['constructor', 'CONSTRUCTOR'],
  ])('%j selects %j', (value, code) => {
    expect(investigationTypeCode(value)).toBe(code);
  });
});

describe('investigation type and status names', () => {
  it('names exactly the five published types', () => {
    expect([...INVESTIGATION_TYPE_MAP]).toStrictEqual([
      ['PE', 'Preliminary Evaluation'],
      ['EA', 'Engineering Analysis'],
      ['DP', 'Defect Petition'],
      ['RQ', 'Recall Query'],
      ['AQ', 'Audit Query'],
    ]);
  });

  it.each([
    ['PE', 'Preliminary Evaluation'],
    ['AQ', 'Audit Query'],
    ['SQ', 'SQ'],
    ['C', 'C'],
    ['pe', 'pe'],
    ['constructor', 'constructor'],
  ])('type %j is named %j', (code, name) => {
    expect(investigationTypeName(code)).toBe(name);
  });

  it.each([
    ['O', 'Open'],
    ['C', 'Closed'],
    ['X', 'X'],
  ])('status %j is named %j', (status, name) => {
    expect(investigationStatusName(status)).toBe(name);
  });
});
