/**
 * @fileoverview Shared rendering helpers for NHTSA tool format() output.
 * Centralized so tools rendering the same upstream shapes — crash-test stars, recall
 * advisory flags, out-of-range pagination — agree on wording rather than each
 * reimplementing it.
 * @module services/nhtsa/format
 */

/** The optional advisory flags NHTSA attaches to a recall, on every recall shape. */
export interface RecallAdvisoryFlags {
  overTheAirUpdate?: boolean | undefined;
  parkIt?: boolean | undefined;
  parkOutSide?: boolean | undefined;
}

export function formatStars(rating?: string): string {
  if (!rating) return 'Not available';
  const n = Number.parseInt(rating, 10);
  if (Number.isNaN(n)) return rating;
  return `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))} (${n}/5)`;
}

export function formatRolloverProbability(probability?: number): string {
  return probability == null ? 'Not available' : `${(probability * 100).toFixed(1)}%`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Render every advisory flag NHTSA set on a recall, including the ones set to false, so an
 * explicit "no" is distinguishable from an advisory NHTSA never reported.
 */
export function formatRecallAdvisories(recall: RecallAdvisoryFlags): string {
  const yesNo = (value: boolean) => (value ? 'yes' : 'no');
  const flags: string[] = [];
  if (recall.parkIt !== undefined) flags.push(`Do not drive: ${yesNo(recall.parkIt)}`);
  if (recall.parkOutSide !== undefined) flags.push(`Park outside: ${yesNo(recall.parkOutSide)}`);
  if (recall.overTheAirUpdate !== undefined) {
    flags.push(`Over-the-air update: ${yesNo(recall.overTheAirUpdate)}`);
  }

  return flags.length > 0 ? flags.join(' | ') : 'None reported by NHTSA';
}

/**
 * Explain a page that landed past the end of a non-empty result set, so an overshooting
 * offset is distinguishable from filters that matched nothing.
 */
export function outOfBoundsMessage({
  offset,
  limit,
  totalCount,
}: {
  offset: number;
  limit: number;
  totalCount: number;
}): string {
  return `No results for this page (offset ${offset}, limit ${limit}). ${totalCount} total — try a smaller offset.`;
}
