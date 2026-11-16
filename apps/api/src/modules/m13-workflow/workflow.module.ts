import { Module } from '@nestjs/common';
import { WORKFLOW_SERVICE } from './workflow.contract';
import { PostgresWorkflowService } from './workflow.service';
import { N8nClient } from './n8n.client';
import { RunMirrorService } from './run-mirror.service';
import { WorkflowAuthoringService } from './authoring.service';
import { FieldDiscoveryService } from './field-discovery.service';
import { FieldSnapshotRepository } from './field-snapshot.repository';
import { WorkflowSampleService } from './sample.service';
import { WORKFLOW_AUTHORITY } from './workflow-authority.contract';
import { PostgresWorkflowAuthority } from './workflow-authority.service';
import { CredentialBrokerModule } from '../m14-credential-broker/credential-broker.module';
import { WorkflowEgressModule } from '../m25-workflow-egress/workflow-egress.module';
import { AccessControlModule } from '../m09-access-control/access-control.module';
import { GovernanceModule } from '../m18-governance/governance.module';
import { NotificationModule } from '../m20-notification/notification.module';

@Module({
  // M25 owns the only hardened path to a product, so field discovery reads the schema through it
  // rather than opening a second outbound client in this module.
  //
  // m09 supplies the live role bindings and m18 the break-glass read: FR-5.9's rule needs both, and
  // neither module depends on this one, so the edges are one-way.
  //
  // M20 delivers the failure alert FR-5.8 asks for. It is imported here, not globally, so the edge is
  // declared: the mirror raises the alert through the interface, and a process that does not host
  // delivery simply does not raise one (ADR-BE-30).
  imports: [
    CredentialBrokerModule,
    WorkflowEgressModule,
    AccessControlModule,
    GovernanceModule,
    NotificationModule,
  ],
  providers: [
    N8nClient,
    RunMirrorService,
    WorkflowAuthoringService,
    FieldSnapshotRepository,
    FieldDiscoveryService,
    WorkflowSampleService,
    { provide: WORKFLOW_AUTHORITY, useClass: PostgresWorkflowAuthority },
    { provide: WORKFLOW_SERVICE, useClass: PostgresWorkflowService },
  ],
  exports: [WORKFLOW_SERVICE, WORKFLOW_AUTHORITY, WorkflowAuthoringService, RunMirrorService],
})
export class WorkflowModule {}
