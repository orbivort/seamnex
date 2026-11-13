import { http } from 'msw';
import { adminHandlers } from './admin';
import { authHandlers } from './auth';
import { catalogHandlers } from './catalog';
import { governanceHandlers } from './governance';
import { instanceHandlers } from './instances';
import { jobHandlers } from './jobs';
import { phase4Handlers } from './phase4';
import { portalHandlers } from './portal';
import { privacyHandlers } from './privacy';
import { recoveryHandlers } from './recovery';
import { registryHandlers } from './registry';
import { workflowHandlers } from './workflows';
import { problem } from './utils';

export const handlers = [
  ...authHandlers,
  /**
   * Phase 4 first: its static segments (`/instances/preview`, `/instances/:id/triggers`,
   * `/workflows/:id/nodes`, `/break-glass-sessions/:id/reveal`) would otherwise be swallowed by the
   * later `:id/:action` handlers. Order is the only precedence mechanism MSW offers.
   */
  ...phase4Handlers,
  ...portalHandlers,
  ...catalogHandlers,
  ...instanceHandlers,
  ...jobHandlers,
  ...workflowHandlers,
  ...governanceHandlers,
  ...adminHandlers,
  ...registryHandlers,
  ...recoveryHandlers,
  ...privacyHandlers,
  http.all('/api/v1/*', ({ request }) => {
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
