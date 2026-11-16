/**
 * @fileoverview Tests for NHTSA shared rendering helpers (format.ts).
 * @module tests/services/nhtsa/format
 */

import { describe, expect, it } from 'vitest';
import {
  formatRecallAdvisories,
  formatRolloverProbability,
  formatStars,
  formatText,
  nextPageHint,
  outOfBoundsMessage,
  pluralize,
  renderNotice,
} from '@/services/nhtsa/format.js';
import { readerText } from '../../helpers/content.js';

/** What a CommonMark reader sees in `markdown`. */
const read = (markdown: string) => readerText([{ type: 'text', text: markdown }]);

/** Upstream text whose Markdown-active characters must read back literally. */
const MARKDOWN_ACTIVE = 'POWER STEERING *DUH* `x` _y_ <tag> [x](y) &amp; ###';

describe('formatText', () => {
  it('passes a value through and renders absent or blank as Not available', () => {
    expect(formatText('Standard')).toBe('Standard');
    expect(formatText()).toBe('Not available');
    expect(formatText('')).toBe('Not available');
  });

  it('renders upstream text so a reader sees it as written', () => {
    expect(read(formatText(MARKDOWN_ACTIVE))).toBe(MARKDOWN_ACTIVE);
    expect(read(formatText('1. FIRST\n- SECOND\n# THIRD'))).toBe('1. FIRST\n- SECOND\n# THIRD');
  });
});

describe('renderNotice', () => {
  it('quotes a notice that reads back exactly, caller text included', () => {
    const notice = 'No models found for make "*x* [y](z)". Verify the make spelling.';
    const rendered = renderNotice(notice);

    expect(rendered.startsWith('> ')).toBe(true);
    expect(read(rendered)).toBe(notice);
  });

  it('keeps every line of a multi-line notice inside the quote', () => {
    const rendered = renderNotice('First line.\n- not a list\n\nAfter a blank line.');

    expect(rendered.split('\n').every((line) => line.startsWith('>'))).toBe(true);
    expect(read(rendered)).toBe('First line.\n- not a list\n\nAfter a blank line.');
  });
});

describe('nextPageHint', () => {
  it('names the offset of the next page while matches remain', () => {
    expect(nextPageHint({ offset: 20, returned: 20, totalCount: 45 })).toBe(
      '*Use offset=40 to retrieve the next page.*\n',
    );
  });

  it('is undefined on the last page and on a page past the end', () => {
    expect(nextPageHint({ offset: 40, returned: 5, totalCount: 45 })).toBeUndefined();
    expect(nextPageHint({ offset: 90, returned: 0, totalCount: 45 })).toBeUndefined();
  });
});

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

  it('renders a non-numeric rating so a reader sees it as written', () => {
    expect(read(formatStars('Not *Rated* [x](y)'))).toBe('Not *Rated* [x](y)');
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
