import { Module } from '@nestjs/common';
import { IntegrationModule } from '../modules/m07-integration/integration.module';
import { GovernanceModule } from '../modules/m18-governance/governance.module';
import { RelayModule } from '../modules/m24-sign-in-relay/relay.module';
import { WorkflowModule } from '../modules/m13-workflow/workflow.module';
import { JobService } from './job.service';
import { JobQueryService } from './job-query.service';
import { JobStreamService } from './job-stream';
import { JobWorker } from './job.worker';
import { PipelineRegistry } from './pipeline-registry';
import { SchedulerService } from './scheduler.service';
import { SyntheticPipeline } from './synthetic-pipeline';

/**
 * No controller: `GET /jobs/:id/stream` and the rest of the job surface are mounted by the
 * contract route table (deliverable 2.1), which dispatches into this module's services. Keeping a
 * controller here as well would mount the same route twice.
 *
 * `PipelineRegistry` is exported because the modules that own job kinds (M05 deploy, M16 backup and
 * restore) register their stage lists at boot. The worker itself knows nothing about deployment.
 *
 * `IntegrationModule` is imported for one caller: the scheduler re-applies the IdP's membership of
 * each instance network, because that membership is Docker state and is lost whenever either
 * container is recreated.
 */
@Module({
  // `GovernanceModule` is imported for the break-glass sweep: the scheduler runs it, M18 owns the
  // table and the statement, so the scheduler calls `GOVERNANCE_WRITES` instead of UPDATE-ing it.
  // `WorkflowModule` is imported for the execution mirror (ADR-BE-12 D9): the scheduler owns the
  // cadence, the workflow module owns the n8n client and the run rows it settles.
  imports: [IntegrationModule, GovernanceModule, RelayModule, WorkflowModule],
  providers: [
    JobService,
    JobQueryService,
    JobStreamService,
    PipelineRegistry,
    SyntheticPipeline,
    JobWorker,
    SchedulerService,
  ],
  exports: [
    JobService,
    JobQueryService,
    JobStreamService,
    PipelineRegistry,
    JobWorker,
    SchedulerService,
  ],
})
export class JobsModule {}
