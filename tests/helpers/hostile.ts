/**
 * @fileoverview The upstream-text fixture the #59 Markdown-escaping tests share.
 * @module tests/helpers/hostile
 */

/**
 * An upstream value holding every Markdown-active form #59 names — emphasis, a code span, an
 * underscore, raw HTML, a link, an entity, a line-leading marker, and a closing heading run —
 * tagged with its field so a value rendered under the wrong label shows.
 */
export const hostile = (lead: '- ' | '# ' | '1. ', field: string) =>
  `${lead}${field} *em* \`code\` _u_ <tag> [x](y) &amp; ###`;
