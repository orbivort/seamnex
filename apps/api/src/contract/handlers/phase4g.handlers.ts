import { Inject, Injectable } from '@nestjs/common';
import type { NativeFloorDecisionRequest, TrustedRegistryUpdate } from '@seamnex/domain';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import { GovernanceWritesService } from '../../modules/m18-governance/governance-writes.service';
import {
  UPSTREAM_OBSERVER,
  type UpstreamObserver,
} from '../../modules/m18-governance/governance.contract';
import {
  TRUSTED_REGISTRY_SERVICE,
  type TrustedRegistryService,
} from '../../modules/m02-source-resolver/source-resolver.contract';
import {
  IMAGE_SCAN_SERVICE,
  type ImageScanService,
} from '../../modules/m05-executor/executor.contract';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4G handler group: the three controls the compliance review found asserted rather than enforced —
 * image trust and scanning (NFR-4.16, NFR-4.6), the native floor (S-2) and upstream observation
 * (FR-2.12).
 *
 * Every handler here answers with the resulting state, not `204`. For an allow-list revision that is
 * the whole point: an operator who adds a namespace has to see the new version and hash, because
 * that revision is the evidence that the change was made. The group owns no SQL: the tables stay with
 * M02, M05 and M18, and this file only connects a declared operation to the module that owns it.
 */
@Injectable()
export class Phase4GHandlers implements OperationGroup {
  readonly tag = 'phase-4g';

  constructor(
    @Inject(GovernanceWritesService) private readonly governance: GovernanceWritesService,
    @Inject(UPSTREAM_OBSERVER) private readonly upstream: UpstreamObserver,
    @Inject(TRUSTED_REGISTRY_SERVICE) private readonly registries: TrustedRegistryService,
    @Inject(IMAGE_SCAN_SERVICE) private readonly scans: ImageScanService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;

    return new Map<string, OperationHandler>([
      [
        /*
         * NFR-4.6 / S-10 — the retained report for the digest the screen is showing. The digest is a
         * query parameter rather than part of the path because it contains a colon and identifies an
         * image, not an instance.
         */
        key('GET', '/instances/:id/image-scan'),
        async (input) => {
          const digest = input.query.digest;
          if (digest === undefined || digest.trim().length === 0) {
            throw new AppError({
              code: 'VALIDATION_FAILED',
              status: 422,
              detail: 'The `digest` query parameter names which image the report belongs to.',
              remediation: 'Send the digest exactly as the image list shows it (`sha256:…`).',
              fieldErrors: [
                { field: 'digest', code: 'required', message: 'A digest is required.' },
              ],
            });
          }
          return body(await this.scans.report(param(input, 'id'), digest));
        },
      ],
      [
        /*
         * FR-2.12 — the same pass the scheduler runs, on demand, so an operator can prove the feeds
         * work without waiting six hours. The actor is the caller: this is a user-triggered
         * observation and the audit row must say so.
         */
        key('POST', '/patch-register/observe'),
        async (input) => body(await this.upstream.observe({ type: 'user', id: actor(input) })),
      ],
      [
        /* S-2 — a decision recorded here is the only way the served floor can be lower than 6. */
        key('POST', '/posture/native-floor/decision'),
        async (input) =>
          body(
            await this.governance.recordNativeFloorDecision(
              input.body as NativeFloorDecisionRequest,
              actor(input),
            ),
          ),
      ],
      [
        /* NFR-4.16 — the list the pull/build guard is reading, as an operator can see it. */
        key('GET', '/security/trusted-registries'),
        async () => body(await this.registries.state()),
      ],
      [
        /*
         * NFR-4.16 — one audited revision per change. The capability (`settings.manage`) is R1 only,
         * which is what "maintained by the platform owner" means as an enforced rule rather than a
         * sentence in a document.
         */
        key('POST', '/security/trusted-registries'),
        async (input) =>
          body(
            await this.registries.update({
              actorId: actor(input),
              update: input.body as TrustedRegistryUpdate,
            }),
          ),
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

function param(input: { params: Readonly<Record<string, string>> }, name: string): string {
  const value = input.params[name];
  if (value === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `Missing path parameter ${name}.`,
    });
  }
  return value;
}
