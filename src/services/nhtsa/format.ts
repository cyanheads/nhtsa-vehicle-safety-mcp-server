/**
 * @fileoverview Shared rendering helpers for NHTSA tool format() output.
 * Centralized so the standalone safety-ratings tool and the composite vehicle-safety
 * tool agree on star, rollover, and pluralization conventions.
 * @module services/nhtsa/format
 */

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
