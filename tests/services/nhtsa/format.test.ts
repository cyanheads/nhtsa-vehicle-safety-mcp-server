/**
 * @fileoverview Tests for NHTSA shared rendering helpers (format.ts).
 * @module tests/services/nhtsa/format
 */

import { describe, expect, it } from 'vitest';
import {
  formatRecallAdvisories,
  formatRolloverProbability,
  formatStars,
  outOfBoundsMessage,
  pluralize,
} from '@/services/nhtsa/format.js';

describe('formatStars', () => {
  it('renders 5-star rating with filled and empty stars', () => {
    expect(formatStars('5')).toBe('★★★★★ (5/5)');
  });

  it('renders 1-star rating', () => {
    expect(formatStars('1')).toBe('★☆☆☆☆ (1/5)');
  });

  it('renders 3-star rating', () => {
    expect(formatStars('3')).toBe('★★★☆☆ (3/5)');
  });

  it('returns "Not available" for undefined', () => {
    expect(formatStars(undefined)).toBe('Not available');
  });

  it('returns "Not available" for empty string', () => {
    expect(formatStars('')).toBe('Not available');
  });

  it('returns the raw value for non-numeric strings', () => {
    expect(formatStars('Not Rated')).toBe('Not Rated');
  });

  it('handles zero stars without negative repeat', () => {
    const result = formatStars('0');
    expect(result).toBe('☆☆☆☆☆ (0/5)');
  });
});

describe('formatRolloverProbability', () => {
  it('formats a decimal probability as a percentage', () => {
    expect(formatRolloverProbability(0.099)).toBe('9.9%');
  });

  it('formats zero probability', () => {
    expect(formatRolloverProbability(0)).toBe('0.0%');
  });

  it('formats 100% probability', () => {
    expect(formatRolloverProbability(1)).toBe('100.0%');
  });

  it('returns "Not available" for undefined', () => {
    expect(formatRolloverProbability(undefined)).toBe('Not available');
  });

  it('formats a small probability with one decimal place', () => {
    expect(formatRolloverProbability(0.125)).toBe('12.5%');
  });
});

describe('pluralize', () => {
  it('returns singular form for count=1', () => {
    expect(pluralize(1, 'complaint')).toBe('complaint');
  });

  it('returns default plural (singular + s) for count != 1', () => {
    expect(pluralize(2, 'complaint')).toBe('complaints');
    expect(pluralize(0, 'complaint')).toBe('complaints');
  });

  it('uses custom plural when provided', () => {
    expect(pluralize(2, 'crash', 'crashes')).toBe('crashes');
    expect(pluralize(1, 'crash', 'crashes')).toBe('crash');
  });

  it('uses custom plural for zero', () => {
    expect(pluralize(0, 'injury', 'injuries')).toBe('injuries');
  });
});

describe('formatRecallAdvisories', () => {
  it('renders every present flag, false included', () => {
    expect(
      formatRecallAdvisories({ parkIt: false, parkOutSide: true, overTheAirUpdate: false }),
    ).toBe('Do not drive: no | Park outside: yes | Over-the-air update: no');
  });

  it('renders all-false advisories rather than dropping them', () => {
    expect(
      formatRecallAdvisories({ parkIt: false, parkOutSide: false, overTheAirUpdate: false }),
    ).toBe('Do not drive: no | Park outside: no | Over-the-air update: no');
  });

  it('omits only the flags NHTSA never reported', () => {
    expect(formatRecallAdvisories({ parkOutSide: false })).toBe('Park outside: no');
  });

  it('reports the absent case distinctly from an all-false one', () => {
    expect(formatRecallAdvisories({})).toBe('None reported by NHTSA');
  });
});

describe('outOfBoundsMessage', () => {
  it('names the offset, limit, and total, and points at a reachable page', () => {
    expect(outOfBoundsMessage({ offset: 9000, limit: 5, totalCount: 264 })).toBe(
      'No results for this page (offset 9000, limit 5). 264 total — try a smaller offset.',
    );
  });
});
