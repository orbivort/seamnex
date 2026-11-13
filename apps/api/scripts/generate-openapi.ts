/**
 * Regenerates `docs/openapi.json` from `API_OPERATIONS`.
 *
 * The document is generated, never hand-edited (ADR-BE-01). Run it whenever the contract changes
 * and commit the result with the change that caused it:
 *
 *   pnpm openapi:generate
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '@seamnex/domain';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', '..', '..', 'docs', 'openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');
console.log(`wrote ${target}`);
