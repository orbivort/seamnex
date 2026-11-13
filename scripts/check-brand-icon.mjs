/**
 * Brand-icon gate.
 *
 * The tab icon is inlined in each app's `index.html`, so it is the one piece of brand identity that
 * no component renders and no unit test can see. That is exactly how the console came to ship a
 * "C" chip while the portal shipped "SN": two literals, no owner, no assertion.
 *
 * Three invariants, each with a silent failure mode:
 *  - both apps declare the same icon, byte for byte — one platform, one tab icon;
 *  - the monogram reads "SN" and nothing else — a wrong letter is invisible inside a 300-character
 *    data URI, which is why it survived review;
 *  - every colour in it resolves to a brand token — `#0f766e` sat in these files reading as "close
 *    enough" to the brand teal forever, and no diff would ever call it out.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

const APPS = [
  { name: 'console', html: resolve(root, 'apps/console/index.html') },
  { name: 'portal', html: resolve(root, 'apps/portal/index.html') },
];

/** The colours the mark is allowed to use: the chip fill, its edge, and the type on it. */
const MARK_TOKENS = ['--color-mark-ink-fill', '--color-mark-ink-edge', '--color-ink-text'];

/** The monogram every surface of the product carries. */
const MONOGRAM = 'SN';

const problems = [];
const icons = [];

/** Tokens as declared, so the icon cannot invent a colour the design system does not own. */
const tokens = new Map();
const tokenCss = readFileSync(resolve(root, 'packages/ui/src/styles/tokens.css'), 'utf8');
for (const match of tokenCss.matchAll(/^\s*(--[a-z-]+):\s*(#[0-9a-fA-F]{3,8});/gm)) {
  tokens.set(match[1], match[2].toLowerCase());
}

const allowedColours = new Map();
for (const token of MARK_TOKENS) {
  const value = tokens.get(token);
  if (value === undefined) {
    problems.push(`packages/ui/src/styles/tokens.css: ${token} is not declared`);
  } else {
    allowedColours.set(value, token);
  }
}

for (const app of APPS) {
  const html = readFileSync(app.html, 'utf8');
  const links = html.match(/<link\b[^>]*\brel="icon"[^>]*>/g) ?? [];

  if (links.length !== 1) {
    problems.push(
      `apps/${app.name}/index.html: found ${links.length} rel="icon" links, expected 1`,
    );
    continue;
  }

  const href = /href="([^"]+)"/.exec(links[0])?.[1];
  if (href === undefined) {
    problems.push(`apps/${app.name}/index.html: the rel="icon" link has no href`);
    continue;
  }

  if (!href.startsWith('data:image/svg+xml,')) {
    problems.push(
      `apps/${app.name}/index.html: the icon must be an inline SVG data URI (found "${href}")`,
    );
    continue;
  }

  const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
  const text = /<text\b[^>]*>([^<]*)<\/text>/.exec(svg)?.[1];

  if (text !== MONOGRAM) {
    problems.push(
      `apps/${app.name}/index.html: the icon monogram is "${text ?? ''}", expected "${MONOGRAM}"`,
    );
  }

  for (const colour of new Set(svg.match(/#[0-9a-fA-F]{6}/g) ?? [])) {
    if (!allowedColours.has(colour.toLowerCase())) {
      problems.push(
        `apps/${app.name}/index.html: the icon uses ${colour}, which is not one of ${MARK_TOKENS.join(', ')}`,
      );
    }
  }

  icons.push({ name: app.name, href });
}

if (icons.length === APPS.length) {
  const [first, ...rest] = icons;
  for (const icon of rest) {
    if (icon.href !== first.href) {
      problems.push(
        `apps/${icon.name}/index.html: the icon differs from apps/${first.name}/index.html — one platform, one tab icon`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('The tab icon is brand identity: one mark, brand tokens, in every app.');
  console.error('Found:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nSee the brand tier in packages/ui/src/styles/tokens.css.');
  process.exitCode = 1;
} else {
  console.log(
    `brand icon check passed: ${icons.length} apps carry the same "${MONOGRAM}" mark, built only from ${MARK_TOKENS.join(', ')}`,
  );
}
