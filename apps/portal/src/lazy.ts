import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Every lazily loaded screen takes no props, so the helper can stay prop-agnostic. */
type ScreenComponent = ComponentType<Record<string, never>>;

const RETRY_DELAY_MS = 200;

/**
 * One retry before failing. A rejected `import()` is usually either a transient network blip —
 * which a retry fixes — or a chunk that a newer deployment replaced, which it cannot fix and
 * `ErrorBoundary` reports as `CHUNK_LOAD_FAILED`. The retry has to happen *inside* the loader:
 * `React.lazy` caches the first rejection, so retrying outside it would never re-run the import.
 */
async function loadWithRetry<M>(loader: () => Promise<M>): Promise<M> {
  try {
    return await loader();
  } catch {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, RETRY_DELAY_MS);
    });
    return loader();
  }
}

/**
 * `React.lazy` for a named screen export.
 *
 * Replaces the `lazy(() => import('./x').then((module) => ({ default: module.X })))` shape that
 * every route used to spell out, so the retry above cannot be forgotten on a new screen.
 */
export function lazyScreen<K extends string, M extends Record<K, ScreenComponent>>(
  loader: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K]> {
  return lazy(() => loadWithRetry(loader).then((module) => ({ default: module[name] })));
}
