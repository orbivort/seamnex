import { Inject, Injectable } from '@nestjs/common';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import {
  STATUS_HEALTH_SERVICE,
  type StatusHealthService,
} from '../../modules/m06-status-health/status-health.contract';
import {
  NOTIFICATION_SERVICE,
  type AlertChannelInput,
  type NotificationService,
} from '../../modules/m20-notification/notification.contract';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4B handler group: container logs without shell access, alert-channel settings and test delivery.
 *
 * `GET /admin/settings/alerts` and its `PUT` were declared in Phase 2 and never mounted a handler;
 * they are the settings surface for this workstream, so they land here rather than being deferred
 * again. `POST /admin/settings/alerts/:id/test` is CL-06: a saved channel that cannot deliver is a
 * silent gap until an incident proves it.
 */
@Injectable()
export class Phase4BHandlers implements OperationGroup {
  readonly tag = 'phase-4b';

  constructor(
    @Inject(STATUS_HEALTH_SERVICE) private readonly status: StatusHealthService,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [
        key('GET', '/instances/:id/containers/:cid/logs'),
        async (input) =>
          body(await this.status.containerLogs(param(input, 'id'), param(input, 'cid'), 200)),
      ],
      [key('GET', '/admin/settings/alerts'), async () => body(await this.notifications.channels())],
      [
        key('PUT', '/admin/settings/alerts'),
        async (input) => {
          const channels = input.body as AlertChannelInput[];
          return body(await this.notifications.replaceChannels(channels, actor(input)));
        },
      ],
      [
        key('POST', '/admin/settings/alerts/:id/test'),
        async (input) => {
          const result = await this.notifications.testChannel(param(input, 'id'));
          return body({
            channelId: param(input, 'id'),
            ok: result.ok,
            detail: result.detail,
            deliveredAt: result.deliveredAt,
          });
        },
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

function actor(input: { context: { subject: { idpId: string } } }): string {
  return input.context.subject.idpId;
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
