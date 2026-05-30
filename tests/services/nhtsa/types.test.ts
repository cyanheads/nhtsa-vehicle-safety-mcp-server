/**
 * @fileoverview Tests for NHTSA types module — buildComponentBreakdown.
 * @module tests/services/nhtsa/types
 */

import { describe, expect, it } from 'vitest';
import { buildComponentBreakdown } from '@/services/nhtsa/types.js';

describe('buildComponentBreakdown', () => {
  it('returns empty array for no complaints', () => {
    expect(buildComponentBreakdown([])).toEqual([]);
  });

  it('counts a single component correctly', () => {
    const result = buildComponentBreakdown([
      {
        components: 'ENGINE',
        crash: true,
        fire: false,
        numberOfInjuries: 2,
        numberOfDeaths: 0,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      component: 'ENGINE',
      count: 1,
      crashCount: 1,
      fireCount: 0,
      injuryCount: 2,
      deathCount: 0,
    });
  });

  it('splits comma-separated components and counts each', () => {
    const result = buildComponentBreakdown([
      { components: 'ENGINE,BRAKES', crash: false, fire: false },
    ]);

    expect(result).toHaveLength(2);
    const engine = result.find((b) => b.component === 'ENGINE');
    const brakes = result.find((b) => b.component === 'BRAKES');
    expect(engine?.count).toBe(1);
    expect(brakes?.count).toBe(1);
  });

  it('sorts components by count descending', () => {
    const result = buildComponentBreakdown([
      { components: 'BRAKES' },
      { components: 'ENGINE' },
      { components: 'ENGINE' },
      { components: 'ENGINE' },
    ]);

    expect(result[0].component).toBe('ENGINE');
    expect(result[0].count).toBe(3);
    expect(result[1].component).toBe('BRAKES');
    expect(result[1].count).toBe(1);
  });

  it('aggregates crash, fire, injury, and death counts across multiple complaints', () => {
    const result = buildComponentBreakdown([
      { components: 'ENGINE', crash: true, fire: false, numberOfInjuries: 1, numberOfDeaths: 0 },
      { components: 'ENGINE', crash: false, fire: true, numberOfInjuries: 0, numberOfDeaths: 1 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      component: 'ENGINE',
      count: 2,
      crashCount: 1,
      fireCount: 1,
      injuryCount: 1,
      deathCount: 1,
    });
  });

  it('handles complaints with undefined components (skips them)', () => {
    const result = buildComponentBreakdown([
      { crash: false },
      { components: undefined, crash: true },
      { components: 'ENGINE' },
    ]);

    // Only ENGINE complaint has a component; the others are skipped
    expect(result).toHaveLength(1);
    expect(result[0].component).toBe('ENGINE');
  });

  it('trims whitespace around component names', () => {
    const result = buildComponentBreakdown([{ components: ' ENGINE , BRAKES ' }]);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.component)).toContain('ENGINE');
    expect(result.map((b) => b.component)).toContain('BRAKES');
  });

  it('handles missing crash/fire/injury/death as zero', () => {
    const result = buildComponentBreakdown([{ components: 'ENGINE' }]);

    expect(result[0].crashCount).toBe(0);
    expect(result[0].fireCount).toBe(0);
    expect(result[0].injuryCount).toBe(0);
    expect(result[0].deathCount).toBe(0);
  });
});
