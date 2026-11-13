import { Module } from '@nestjs/common';
import { PortalBffModule } from '../m10-portal-bff/portal-bff.module';
import { FORWARD_AUTH_SERVICE } from './forward-auth.contract';
import { CachedForwardAuthService } from './forward-auth.service';

/**
 * M11 - forward-auth decisions (4D.4). Stateless: the only state it touches is the Redis session and
 * its own 60 s decision cache.
 */
@Module({
  imports: [PortalBffModule],
  providers: [{ provide: FORWARD_AUTH_SERVICE, useClass: CachedForwardAuthService }],
  // Only the token is exported: `CachedForwardAuthService` is bound to it, and exporting a class
  // that is not itself a provider makes Nest refuse to instantiate the module at boot.
  exports: [FORWARD_AUTH_SERVICE],
})
export class ForwardAuthModule {}
