/**
 * @fileoverview Shared rendering helpers for NHTSA tool format() output.
 * Centralized so tools rendering the same upstream shapes — crash-test stars, recall
 * advisory flags, out-of-range pagination — agree on wording rather than each
 * reimplementing it. Every upstream string a helper returns is Markdown-escaped, so
 * `content[]` reads back exactly what `structuredContent` carries.
 * @module services/nhtsa/format
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** The optional advisory flags NHTSA attaches to a recall, on every recall shape. */
export interface RecallAdvisoryFlags {
  overTheAirUpdate?: boolean | undefined;
  parkIt?: boolean | undefined;
  parkOutSide?: boolean | undefined;
}

/** An upstream string, escaped for `content[]`; absent or blank renders as "Not available". */
export function formatText(value?: string): string {
  return value ? escapeMarkdownInline(value) : 'Not available';
}

/** A crash-test rating as stars; a non-numeric rating ("Not Rated") is escaped as upstream text. */
export function formatStars(rating?: string): string {
  if (!rating) return 'Not available';
  const n = Number.parseInt(rating, 10);
  if (Number.isNaN(n)) return escapeMarkdownInline(rating);
  return `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))} (${n}/5)`;
}

/**
 * The `content[]` trailer line for an enrichment `notice`: a block quote of the escaped text,
 * every line quoted. Notices quote caller input (a make, a query), which the framework's default
 * notice line would render as Markdown; escaped, it reads back as `structuredContent.notice`.
 * Wired on every tool as `enrichmentTrailer: { notice: { render: renderNotice } }`.
 */
export function renderNotice(notice: string): string {
  return escapeMarkdownInline(notice)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** The investigation row fields the heading and dates lines print, on every investigation shape. */
export interface InvestigationRowText {
  closeDate?: string | undefined;
  investigationType?: string | undefined;
  investigationTypeName?: string | undefined;
  nhtsaId?: string | undefined;
  openDate?: string | undefined;
  status?: string | undefined;
  statusName?: string | undefined;
}

/** An investigation's `### id [status: name]` heading and its `**Type:**` line. */
export function formatInvestigationHeading(i: InvestigationRowText): string[] {
  const id = i.nhtsaId ? escapeMarkdownInline(i.nhtsaId) : 'Unknown ID';
  const status = i.status ? escapeMarkdownInline(i.status) : 'N/A';
  const statusName = i.statusName ? escapeMarkdownInline(i.statusName) : 'Unknown';
  const type = i.investigationType ? escapeMarkdownInline(i.investigationType) : 'N/A';
  return [
    `### ${id} [${status}: ${statusName}]`,
    `**Type:** ${type} — ${formatText(i.investigationTypeName)}`,
  ];
}

/** An investigation's `**Opened:**` line, with ` | **Closed:**` once it has closed. */
export function formatInvestigationDates(i: InvestigationRowText): string {
  const closed = i.closeDate ? ` | **Closed:** ${escapeMarkdownInline(i.closeDate)}` : '';
  return `**Opened:** ${formatText(i.openDate)}${closed}`;
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

/** The line pointing at the next page while matches remain past this one; undefined on the last. */
export function nextPageHint({
  offset,
  returned,
  totalCount,
}: {
  offset: number;
  returned: number;
  totalCount: number;
}): string | undefined {
  const next = offset + returned;
  return returned > 0 && next < totalCount
    ? `*Use offset=${next} to retrieve the next page.*\n`
    : undefined;
}
