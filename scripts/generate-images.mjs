/**
 * Writes `apps/api/src/common/docker/images.generated.ts` from `docker/images.json`.
 *
 * The module is committed because the API image copies source, not the `docker/` tree; generating it
 * at build time would need `docker/images.json` in the build context and one more COPY to keep the
 * runtime working. `pnpm check:images:offline` compares the committed file with what this produces,
 * so a manifest edit that skips this command fails the gate rather than shipping a stale pin.
 *
 *   pnpm images:generate
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GENERATED_MODULE, loadImageManifest, renderModule } from './image-manifest.mjs';

const root = resolve(import.meta.dirname, '..');

try {
  const manifest = loadImageManifest(root);
  writeFileSync(join(root, GENERATED_MODULE), renderModule(manifest.controlPlane));
  console.log(
    `[images] wrote ${GENERATED_MODULE} from ${Object.keys(manifest.controlPlane).length} ` +
      'control-plane pin(s)',
  );
} catch (error) {
  console.error(`[images] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
