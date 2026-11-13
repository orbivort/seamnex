import { Module } from '@nestjs/common';
import { AccessControlModule } from '../m09-access-control/access-control.module';
import { RelayModule } from '../m24-sign-in-relay/relay.module';
import { PORTAL_BFF_SERVICE } from './portal-bff.contract';
import { PostgresPortalBffService } from './portal-bff.service';
import { SESSION_READER, SESSION_SERVICE } from './session.contract';
import { RedisSessionService } from './session.service';
import { SessionStore } from './session.store';

/**
 * The session is a cross-cutting credential, and that is exactly why this module is *not* global:
 * the identity resolver, the sync worker (session kill on disable), the forward-auth gateway and
 * the auth handlers each state the edge. A global made those four look like they had no dependency
 * on M10 at all, which is how a review of the graph could not answer "who reads sessions?".
 */
@Module({
  // The projection needs the subject's grants; the session service needs the settings it caches and
  // the relay it invalidates on sign-out (ADR-BE-22).
  imports: [AccessControlModule, RelayModule],
  providers: [
    SessionStore,
    { provide: SESSION_SERVICE, useClass: RedisSessionService },
    // M11's dependency: the interface, not the store class. `useExisting` keeps one instance and
    // one Redis connection behind both tokens.
    { provide: SESSION_READER, useExisting: SessionStore },
    { provide: PORTAL_BFF_SERVICE, useClass: PostgresPortalBffService },
  ],
  exports: [PORTAL_BFF_SERVICE, SESSION_SERVICE, SESSION_READER],
})
export class PortalBffModule {}
