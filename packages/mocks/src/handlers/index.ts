import { http } from 'msw';
import { adminHandlers } from './admin';
import { authHandlers } from './auth';
import { catalogHandlers } from './catalog';
import { governanceHandlers } from './governance';
import { instanceHandlers } from './instances';
import { jobHandlers } from './jobs';
import { observabilityHandlers } from './observability';
import { phase4Handlers } from './phase4';
import { portalHandlers } from './portal';
import { privacyHandlers } from './privacy';
import { recoveryHandlers } from './recovery';
import { registryHandlers } from './registry';
import { securityHandlers } from './security';
import { workflowHandlers } from './workflows';
import { problem } from './utils';

/**
 * Every path below carries a leading wildcard before its `/api/v1` segment.
 *
 * A handler path that starts with a slash is resolved against the current document, so it only
 * matches the origin root. The same bundle is also served from a deployment base — GitHub Pages
 * publishes a project site at `/<repository>/`, and the transport then asks for `<base>api/v1/...`
 * so the request stays inside the service worker's scope. The wildcard matches the base (and, in
 * development, the bare origin), so one handler list serves both without knowing which prefix it
 * is mounted under. MSW documents this form as "match any origin".
 */
export const handlers = [
  ...authHandlers,
  /**
   * Phase 4 first: its static segments (`/instances/preview`, `/instances/:id/triggers`,
   * `/workflows/:id/nodes`, `/break-glass-sessions/:id/reveal`) would otherwise be swallowed by the
   * later `:id/:action` handlers. Order is the only precedence mechanism MSW offers.
   */
  ...phase4Handlers,
  ...portalHandlers,
  // `/instances/:id/image-scan` is a static suffix under `:id`, so it is registered before the
  // broader instance handlers for the same reason the phase-4 group is.
  ...securityHandlers,
  ...catalogHandlers,
  ...instanceHandlers,
  ...observabilityHandlers,
  ...jobHandlers,
  ...workflowHandlers,
  ...governanceHandlers,
  ...adminHandlers,
  ...registryHandlers,
  ...recoveryHandlers,
  ...privacyHandlers,
  http.all('*/api/v1/*', ({ request }) => {
    const url = new URL(request.url);
    return problem(
      404,
      'ENDPOINT_NOT_MOCKED',
      'Endpoint not implemented in the prototype',
      `${request.method} ${url.pathname} has no mock handler.`,
      'This is a frontend prototype: only the endpoints used by the prototype screens are simulated.',
    );
  }),
];
