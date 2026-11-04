/**
 * @fileoverview Tests for NHTSA types module — splitComponentNames, buildComponentBreakdown.
 * @module tests/services/nhtsa/types
 */

import { describe, expect, it } from 'vitest';
import { buildComponentBreakdown, splitComponentNames } from '@/services/nhtsa/types.js';

describe('splitComponentNames (#46)', () => {
  it.each([
    ['SERVICE BRAKES, HYDRAULIC,SERVICE BRAKES', ['SERVICE BRAKES, HYDRAULIC', 'SERVICE BRAKES']],
    [
      'Carry Handle, Shell, Base,Chest Clip, Buckle, Harness,Tether, Lower Anchor (on car seat or vehicle)',
      [
        'Carry Handle, Shell, Base',
        'Chest Clip, Buckle, Harness',
        'Tether, Lower Anchor (on car seat or vehicle)',
      ],
    ],
    ['AIR BAGS,SEAT BELTS', ['AIR BAGS', 'SEAT BELTS']],
  ])('splits %j into its names', (components, names) => {
    expect(splitComponentNames(components)).toEqual(names);
  });

  it('keeps every name NHTSA spells with ", " whole', () => {
    const names = [
      'SERVICE BRAKES, HYDRAULIC',
      'SERVICE BRAKES, AIR',
      'SERVICE BRAKES, ELECTRIC',
      'FUEL SYSTEM, GASOLINE',
      'FUEL SYSTEM, DIESEL',
      'FUEL SYSTEM, OTHER',
      'SERVICE BRAKES, HYDRAULIC; AUTOHOLD BRAKE SYSTEM/BRAKE HOLD',
      'Chest Clip, Buckle, Harness',
      'Carry Handle, Shell, Base',
      'Insert, Padding',
      'Tether, Lower Anchor (on car seat or vehicle)',
    ];

    expect(splitComponentNames(names.join(','))).toEqual(names);
  });

  it('returns each name once, trimmed, with blanks dropped', () => {
    expect(splitComponentNames(' ENGINE ,,ENGINE,SEATS,')).toEqual(['ENGINE', 'SEATS']);
  });

  it.each([undefined, '', ' '])('returns no names for %j', (components) => {
    expect(splitComponentNames(components)).toEqual([]);
  });
});

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

    expect(result[0]!.component).toBe('ENGINE');
    expect(result[0]!.count).toBe(3);
    expect(result[1]!.component).toBe('BRAKES');
    expect(result[1]!.count).toBe(1);
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
      { crash: true },
      { components: 'ENGINE' },
    ]);

    // Only ENGINE complaint has a component; the others are skipped
    expect(result).toHaveLength(1);
    expect(result[0]!.component).toBe('ENGINE');
  });

  it('trims whitespace around component names', () => {
    const result = buildComponentBreakdown([{ components: ' ENGINE ,BRAKES ' }]);

    expect(result).toHaveLength(2);
    expect(result.map((b) => b.component)).toContain('ENGINE');
    expect(result.map((b) => b.component)).toContain('BRAKES');
  });

  it('keeps a name containing ", " whole and counts it apart from its prefix (#46)', () => {
    const result = buildComponentBreakdown([
      { components: 'SERVICE BRAKES, HYDRAULIC' },
      { components: 'SERVICE BRAKES, HYDRAULIC,SERVICE BRAKES' },
      { components: 'SERVICE BRAKES, AIR,FUEL SYSTEM, GASOLINE' },
    ]);

    expect(result.map((b) => [b.component, b.count])).toEqual([
      ['SERVICE BRAKES, HYDRAULIC', 2],
      ['SERVICE BRAKES', 1],
      ['SERVICE BRAKES, AIR', 1],
      ['FUEL SYSTEM, GASOLINE', 1],
    ]);
  });

  it('counts a name once per complaint, so no row exceeds the complaint count (#46)', () => {
    const complaints = [
      { components: 'SERVICE BRAKES, HYDRAULIC,SERVICE BRAKES, AIR', crash: true },
      { components: 'ENGINE,ENGINE', numberOfInjuries: 1 },
    ];
    const result = buildComponentBreakdown(complaints);

    for (const row of result) expect(row.count).toBeLessThanOrEqual(complaints.length);
    expect(result).toEqual([
      {
        component: 'SERVICE BRAKES, HYDRAULIC',
        count: 1,
        crashCount: 1,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      },
      {
        component: 'SERVICE BRAKES, AIR',
        count: 1,
        crashCount: 1,
        fireCount: 0,
        injuryCount: 0,
        deathCount: 0,
      },
      { component: 'ENGINE', count: 1, crashCount: 0, fireCount: 0, injuryCount: 1, deathCount: 0 },
    ]);
  });

  it('handles missing crash/fire/injury/death as zero', () => {
    const result = buildComponentBreakdown([{ components: 'ENGINE' }]);

    expect(result[0]!.crashCount).toBe(0);
    expect(result[0]!.fireCount).toBe(0);
    expect(result[0]!.injuryCount).toBe(0);
    expect(result[0]!.deathCount).toBe(0);
  });
});
