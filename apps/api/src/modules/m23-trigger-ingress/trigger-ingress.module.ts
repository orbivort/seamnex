import { Module } from '@nestjs/common';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { TRIGGER_INGRESS_SERVICE } from './trigger-ingress.contract';
import { PostgresTriggerIngressService } from './trigger-ingress.service';

/** M23 - trigger endpoints and signed deliveries (4E.5). The signing secret is M15's. */
@Module({
  imports: [SecretsModule],
  providers: [{ provide: TRIGGER_INGRESS_SERVICE, useClass: PostgresTriggerIngressService }],
  exports: [TRIGGER_INGRESS_SERVICE],
})
export class TriggerIngressModule {}
