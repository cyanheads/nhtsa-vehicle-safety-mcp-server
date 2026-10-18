/**
 * @fileoverview Shared inclusive calendar-date ranges for recall and investigation filters.
 * @module services/nhtsa/date-range
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Public, JSON-Schema-serializable range input; semantic validation precedes upstream work. */
export const dateRangeSchema = z.object({
  after: z
    .string()
    .optional()
    .describe('Inclusive lower bound, a calendar date in YYYY-MM-DD. Blank means unset.'),
  before: z
    .string()
    .optional()
    .describe('Inclusive upper bound, a calendar date in YYYY-MM-DD. Blank means unset.'),
});

/** Active, normalized calendar-date bounds. */
export type DateRange = z.infer<typeof dateRangeSchema>;

const calendarDate = z.iso.date();

/** Normalize form blanks and reject invalid or inverted ranges before fetching records. */
export function normalizeDateRange(
  range: DateRange | undefined,
  field: string,
): DateRange | undefined {
  const after = range?.after?.trim() || undefined;
  const before = range?.before?.trim() || undefined;
  for (const [bound, value] of [
    ['after', after],
    ['before', before],
  ] as const) {
    if (value !== undefined && !calendarDate.safeParse(value).success) {
      throw validationError(
        `Invalid date: ${field}.${bound} must be a calendar-valid YYYY-MM-DD date.`,
        {
          reason: 'invalid_date',
          recovery: { hint: 'Use calendar-valid YYYY-MM-DD dates, for example 2024-02-29.' },
        },
      );
    }
  }
  if (after && before && after > before) {
    throw validationError(`${field}.after must be on or before ${field}.before.`, {
      reason: 'inverted_date_range',
      recovery: { hint: 'Set after on or before before, or omit a bound.' },
    });
  }
  return after || before ? { after, before } : undefined;
}

/** Missing or unusable record dates are excluded only while a bound is active. */
export function matchesDateRange(date: string | undefined, range: DateRange | undefined): boolean {
  if (!range) return true;
  if (!date || !calendarDate.safeParse(date).success) return false;
  return (!range.after || date >= range.after) && (!range.before || date <= range.before);
}

/** Echo only active bounds so clients can distinguish filtering from an upstream miss. */
export function describeDateRange(field: string, range: DateRange | undefined): string {
  if (!range) return '';
  return `${field}(${[range.after && `after=${range.after}`, range.before && `before=${range.before}`].filter(Boolean).join(', ')})`;
}
