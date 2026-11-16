import { Module } from '@nestjs/common';
import { OBSERVABILITY_SERVICE } from './observability.contract';
import { PostgresObservabilityService } from './observability.service';

/**
 * M21 — observability fabric (FR-2.6, AC-45, FR-4.6).
 *
 * No module imports: the service reads only its own tables (`observability_profile`), the read
 * models it is allowed to read (`catalog_entry`, `instance`, `instance_usage_sample`) through the
 * pool, and configuration. `module-boundaries.json` already declares that shape, so this module
 * adds no edge to the graph — which is why the scheduler calls `reconcile()` through the exported
 * token rather than the other way round.
 */
@Module({
  providers: [
    PostgresObservabilityService,
    { provide: OBSERVABILITY_SERVICE, useExisting: PostgresObservabilityService },
  ],
  exports: [OBSERVABILITY_SERVICE, PostgresObservabilityService],
})
export class ObservabilityModule {}
