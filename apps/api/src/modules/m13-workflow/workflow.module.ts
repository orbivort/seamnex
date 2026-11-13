import { Module } from '@nestjs/common';
import { WORKFLOW_SERVICE } from './workflow.contract';
import { PostgresWorkflowService } from './workflow.service';
import { N8nClient } from './n8n.client';
import { RunMirrorService } from './run-mirror.service';
import { WorkflowAuthoringService } from './authoring.service';
import { FieldDiscoveryService } from './field-discovery.service';
import { FieldSnapshotRepository } from './field-snapshot.repository';
import { WorkflowSampleService } from './sample.service';
import { CredentialBrokerModule } from '../m14-credential-broker/credential-broker.module';
import { WorkflowEgressModule } from '../m25-workflow-egress/workflow-egress.module';

@Module({
  // M25 owns the only hardened path to a product, so field discovery reads the schema through it
  // rather than opening a second outbound client in this module.
  imports: [CredentialBrokerModule, WorkflowEgressModule],
  providers: [
    N8nClient,
    RunMirrorService,
    WorkflowAuthoringService,
    FieldSnapshotRepository,
    FieldDiscoveryService,
    WorkflowSampleService,
    { provide: WORKFLOW_SERVICE, useClass: PostgresWorkflowService },
  ],
  exports: [WORKFLOW_SERVICE, WorkflowAuthoringService, RunMirrorService],
})
export class WorkflowModule {}
