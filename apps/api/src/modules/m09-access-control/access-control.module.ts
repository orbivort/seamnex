import { Module } from '@nestjs/common';
import { ACCESS_CONTROL_SERVICE, MACHINE_CLIENT_SERVICE } from './access-control.contract';
import { PostgresAccessControlService } from './access-control.service';
import { MachineClientService } from './machine-client.service';
import { PdpService } from './pdp.service';
import { PolicyCompiler } from './policy.compiler';

/**
 * `PolicyCompiler` bootstraps the active `policy_version`; the PDP and the machine-client
 * authenticator are consumed by `common/identity` and the route table.
 *
 * Not global: the identity seam, the portal projection and the guard chain each declare the edge.
 * Being global hid the fact that the PDP is the most widely depended-on provider in the system.
 */
@Module({
  providers: [
    PolicyCompiler,
    PdpService,
    MachineClientService,
    { provide: ACCESS_CONTROL_SERVICE, useClass: PostgresAccessControlService },
    { provide: MACHINE_CLIENT_SERVICE, useExisting: MachineClientService },
  ],
  exports: [ACCESS_CONTROL_SERVICE, MACHINE_CLIENT_SERVICE, PdpService, PolicyCompiler],
})
export class AccessControlModule {}
