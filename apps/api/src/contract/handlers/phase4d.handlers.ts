import { Inject, Injectable } from '@nestjs/common';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import { RegistryFeedService } from '../../modules/m12-integration-registry/registry-feed.service';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4D handler group.
 *
 * The workstream's writes (identity client, route, checks) are driven by the deploy pipeline and the
 * gate, so the one operation the console needs from 4D is the registry feed: the canvas discovers
 * operations per target instead of an author typing a URL (CL-07, FR-5.2).
 */
@Injectable()
export class Phase4DHandlers implements OperationGroup {
  readonly tag = 'phase-4d';

  constructor(@Inject(RegistryFeedService) private readonly registry: RegistryFeedService) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [
        key('GET', '/registry/operations'),
        async (input) => {
          const target = input.query.target;
          if (typeof target !== 'string' || target.length === 0) {
            throw new AppError({
              code: 'VALIDATION_FAILED',
              status: 422,
              detail: 'The `target` query parameter is required.',
              remediation: 'Pass the instance id, slug or catalog entry key.',
            });
          }
          return body(await this.registry.operations(target));
        },
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}
