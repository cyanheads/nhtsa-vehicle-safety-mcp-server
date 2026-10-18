/**
 * @fileoverview Calendar-date validation and inclusive comparison shared by both search tools.
 * @module tests/services/nhtsa/date-range
 */

import { describe, expect, it } from 'vitest';
import { matchesDateRange, normalizeDateRange } from '@/services/nhtsa/date-range.js';

describe('calendar ranges', () => {
  it.each([undefined, {}, { after: '', before: ' \t' }])('normalizes inactive %j', (range) => {
    expect(normalizeDateRange(range, 'range')).toBeUndefined();
    expect(matchesDateRange(undefined, normalizeDateRange(range, 'range'))).toBe(true);
  });

  it.each(['2024-02-29', '2000-02-29', '0000-01-01', '1968-12-31'])(
    'accepts calendar date %s inclusively',
    (date) => {
      const range = normalizeDateRange({ after: ` ${date} `, before: date }, 'range');
      expect(range).toEqual({ after: date, before: date });
      expect(matchesDateRange(date, range)).toBe(true);
      expect(matchesDateRange(undefined, range)).toBe(false);
      expect(matchesDateRange('not-a-date', range)).toBe(false);
      expect(matchesDateRange('2025-02-30', range)).toBe(false);
    },
  );

  it.each([
    '1900-02-29',
    '2025-02-29',
    '2025-02-30',
    '2025-04-31',
    '2025-00-01',
    '2025-13-01',
    '2025-01-00',
    '2025',
    '2025-1-01',
    '2025-01-01T00:00:00Z',
  ])('rejects invalid bound %s', (date) => {
    for (const bound of ['after', 'before']) {
      expect(() => normalizeDateRange({ [bound]: date }, 'range')).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: 'invalid_date',
            recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
          }),
        }),
      );
    }
  });

  it('rejects inversion and handles open bounds without an epoch floor', () => {
    expect(() =>
      normalizeDateRange({ after: '2025-01-01', before: '2020-01-01' }, 'range'),
    ).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'inverted_date_range' }) }),
    );
    expect(
      matchesDateRange('1968-01-01', normalizeDateRange({ before: '2020-01-01' }, 'range')),
    ).toBe(true);
    expect(
      matchesDateRange('2021-01-01', normalizeDateRange({ before: '2020-01-01' }, 'range')),
    ).toBe(false);
    expect(
      matchesDateRange('2021-01-01', normalizeDateRange({ after: '2020-01-01' }, 'range')),
    ).toBe(true);
    expect(
      matchesDateRange('1968-01-01', normalizeDateRange({ after: '2020-01-01' }, 'range')),
    ).toBe(false);
  });
});
