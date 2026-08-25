/**
 * HTML escaping for the very small number of places the Worker emits HTML
 * directly: the /go fallback page, robots.txt/sitemap.xml, and Open Graph
 * metadata.
 *
 * The React app escapes everything automatically and `dangerouslySetInnerHTML`
 * is banned by lint, so this exists purely for server-rendered strings. It is
 * used even where the input is a constant, because "this one is safe" is how the
 * unsafe one gets added later.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Escape for an HTML text node or a double-quoted attribute value.
 *
 * Escapes more than the strict minimum (`/`, backtick and `=` as well) because
 * those three matter for unquoted attributes and for old-IE backtick parsing,
 * and over-escaping is never a correctness problem in these contexts.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.replace(/[&<>"'/`=]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Escape for XML text (sitemap.xml). No `/` escaping; XML has no need for it. */
export function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape a string for embedding inside a JSON-LD <script type="application/ld+json">
 * block.
 *
 * `</script>` inside a JSON string terminates the element in an HTML parser even
 * though it is valid JSON, which is a genuine XSS vector in structured-data
 * blocks. Unicode-escaping `<` and `>` prevents it while keeping the JSON valid.
 */
export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
