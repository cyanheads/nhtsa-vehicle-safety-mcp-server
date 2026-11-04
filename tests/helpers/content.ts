/**
 * @fileoverview Assertions for MCP content blocks returned by formatters and tool calls.
 * @module tests/helpers/content
 */

import MarkdownIt, { type Token } from 'markdown-it';

const commonmark = new MarkdownIt('commonmark');

/** Returns the first block's text or fails when a formatter changes shape. */
export function firstText(blocks: readonly { type: string; text?: string }[]): string {
  const block = blocks[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new TypeError('Expected the first content block to be text');
  }
  return block.text;
}

/** The text an inline token reads as; markup tokens contribute nothing. */
function inlineText(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'code_inline':
    case 'html_inline':
    case 'image':
      return token.content;
    case 'softbreak':
    case 'hardbreak':
      return '\n';
    default:
      return '';
  }
}

/**
 * The text a CommonMark reader sees in the text blocks of `content[]`, one line per block-level
 * element. Error and enrichment-trailer lines carry Markdown escapes and code spans
 * (`nhtsa\_x`, `` `query` ``); parsing reads them back, so an assertion compares the value a
 * caller sees rather than its encoding.
 */
export function readerText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .flatMap((markdown) => commonmark.parse(markdown, {}))
    .flatMap((token) => {
      if (token.type === 'inline') return [(token.children ?? []).map(inlineText).join('')];
      if (token.type === 'fence' || token.type === 'code_block') return [token.content];
      return [];
    })
    .join('\n');
}
