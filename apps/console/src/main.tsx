import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { readSession } from './session';
import { applySessionTransport } from './api-mode';
import { prepareMockPlatform, revealBootFailure } from './bootstrap';
import { preloadCriticalRoutes } from './lazy-routes';
import './index.css';

/**
 * The document paints before anything is awaited.
 *
 * `index.html` carries the splash markup, so the very first frame is the product rather than a
 * white page; the mock platform and the server session are awaited inside `SessionGate`, which
 * runs after React owns the document. Nothing here may `await` before `createRoot`.
 */
function start(): void {
  const container = document.getElementById('root');
  if (!container) throw new Error('Root container is missing from index.html');

  const session = readSession();
  // The transport is rebuilt before React renders, so the first request already carries the role.
  applySessionTransport(session);
  // Started, not awaited: the gate awaits it once React is mounted.
  void prepareMockPlatform(session.scenario);

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // After the first paint, not before: the chunks an operator is most likely to open next are
  // warmed once the browser is idle, so the initial render never competes with them.
  preloadCriticalRoutes();
}

try {
  start();
} catch (error) {
  revealBootFailure(error);
}
