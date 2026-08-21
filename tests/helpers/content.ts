/**
 * @fileoverview Assertions for MCP content blocks returned by formatters.
 * @module tests/helpers/content
 */

/** Returns the first block's text or fails when a formatter changes shape. */
export function firstText(blocks: readonly { type: string; text?: string }[]): string {
  const block = blocks[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new TypeError('Expected the first content block to be text');
  }
  return block.text;
}
