import { join } from 'node:path';

/**
 * Where the executor keeps a render set's *runtime* files: the container-injection override and the
 * interpolation env file, both 0600, both outside the render set so no secret enters a stored
 * artefact.
 *
 * They are derived from the render set id, not from the instance, because two applied sets of the
 * same instance must not overwrite each other's secrets. Two paths that must agree — the executor
 * writes them before `compose up`, the restore has to pass the same two files or the product starts
 * without its credentials — so they are computed in one place rather than written twice.
 */
export function runtimeSecretsPaths(input: {
  readonly dataDir: string;
  readonly instanceId: string;
  readonly renderSetId: string;
}): { readonly override: string; readonly env: string } {
  const directory = join(input.dataDir, input.instanceId, 'runtime');
  return {
    override: join(directory, `${input.renderSetId}.secrets.yml`),
    env: join(directory, `${input.renderSetId}.env`),
  };
}
