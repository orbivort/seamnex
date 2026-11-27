import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);

/**
 * Start the in-browser mock API. Static assets and fonts are passed through.
 *
 * The worker is fetched from the deployment base, and its scope is that directory: at `/seamnex/`
 * (GitHub Pages) a root-relative `/mockServiceWorker.js` is a 404 and nothing is intercepted.
 */
export async function startMockWorker(): Promise<void> {
  await worker.start({
    onUnhandledFrame: 'bypass',
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
