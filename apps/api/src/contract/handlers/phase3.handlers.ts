import { Inject, Injectable } from '@nestjs/common';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import {
  IDENTITY_SYNC_SERVICE,
  type IdentitySyncService,
} from '../../modules/m08-identity-sync/identity-sync.contract';
import type { OperationHandler, OperationInput, OperationResult } from '../operation-handler';
import type { OperationGroup } from '../operation-handlers';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * The two Phase 3 mutations that close EX-1/AC-12: offboarding and a forced sync cycle.
 *
 * They live in their own group so the Phase 2 handler set stays a read surface plus one durable
 * mapping write, and the diff for this phase is reviewable in one place.
 */
@Injectable()
export class Phase3Handlers implements OperationGroup {
  readonly tag = 'phase-3';

  constructor(@Inject(IDENTITY_SYNC_SERVICE) private readonly identity: IdentitySyncService) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [
        key('POST', '/admin/users/:id/disable'),
        async (input) =>
          this.body(await this.identity.disableUser(input.params.id ?? '', actorOf(input))),
      ],
      [
        key('POST', '/admin/identity-sync/run'),
        async (input) => this.body(await this.identity.runSync(actorOf(input))),
      ],
    ]);
  }

  private body(value: unknown): OperationResult {
    return { kind: 'body', body: value };
  }
}

function actorOf(input: OperationInput): string {
  return input.context.subject.idpId;
}
