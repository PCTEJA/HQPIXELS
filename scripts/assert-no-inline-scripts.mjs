/**
 * CI gate: the built HTML must contain no inline <script> and no inline event
 * handler attributes.
 *
 * This is what makes the nonce-free `script-src 'self'` policy safe. If a future
 * dependency or plugin starts injecting an inline bootstrap script, the CSP would
 * silently block it (broken app) or someone would "fix" it by adding
 * 'unsafe-inline' (broken security). Failing the build instead forces the real
 * conversation.
 *
 * Usage: node scripts/assert-no-inline-scripts.mjs [distDir]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.argv[2] ?? join(repoRoot, 'dist', 'client');

if (!existsSync(distDir)) {
  console.error(`Build output not found at ${distDir}. Run the build first.`);
  process.exit(1);
}

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

const files = htmlFiles(distDir);
if (files.length === 0) {
  console.error(`No HTML files found under ${distDir}.`);
  process.exit(1);
}

let violations = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');

  // <script> with a body and no src attribute.
  const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const tag of scriptTags) {
    const openTag = tag.slice(0, tag.indexOf('>') + 1);
    const body = tag.slice(openTag.length, tag.lastIndexOf('</script'));
    const hasSrc = /\bsrc\s*=/i.test(openTag);
    // A JSON-LD block is data, not executable script, and CSP does not apply
    // script-src to it.
    const isJsonLd = /type\s*=\s*["']application\/(ld\+json|json)["']/i.test(openTag);

    if (!hasSrc && body.trim() !== '' && !isJsonLd) {
      violations += 1;
      console.error(`INLINE SCRIPT in ${file}:\n  ${openTag}${body.trim().slice(0, 160)}`);
    }
  }

  // Inline event handlers (onclick=, onload=, ...).
  const handlers = html.match(/\son[a-z]+\s*=\s*["'][^"']*["']/gi) ?? [];
  for (const handler of handlers) {
    violations += 1;
    console.error(`INLINE EVENT HANDLER in ${file}: ${handler.trim().slice(0, 120)}`);
  }

  // javascript: URLs.
  if (/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(html)) {
    violations += 1;
    console.error(`javascript: URL in ${file}`);
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} CSP violation(s) in built HTML.\n` +
      "The Content-Security-Policy uses script-src 'self' with no nonce and no\n" +
      "'unsafe-inline'. Inline script would be blocked at runtime. Move the code\n" +
      'into a module under src/ instead of relaxing the policy.',
  );
  process.exit(1);
}

console.log(`No inline scripts or handlers in ${files.length} HTML file(s).`);
