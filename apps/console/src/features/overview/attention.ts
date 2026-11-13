import type { usePosture } from '@seamnex/api-client';
import type { Instance } from '@seamnex/domain';
import { formatRelative } from '@seamnex/utils';

export type Attention = {
  id: string;
  tone: 'danger' | 'caution' | 'info';
  title: string;
  detail: string;
  href: string;
  cta: string;
};

/** Lower is more urgent: the queue is read top-down by an operator with no time to spare. */
const TONE_RANK: Record<Attention['tone'], number> = { danger: 0, caution: 1, info: 2 };

export function buildAttention(
  instances: Instance[],
  posture: ReturnType<typeof usePosture>['data'],
): Attention[] {
  const items: Attention[] = [];

  instances
    .filter((instance) => instance.state === 'degraded')
    .forEach((instance) => {
      items.push({
        id: `degraded-${instance.id}`,
        tone: 'danger',
        title: `${instance.entryKey} ${instance.product} is degraded`,
        detail: instance.stateReason ?? 'Containers run but the application is not ready.',
        href: `/instances/${instance.id}`,
        cta: 'Inspect containers',
      });
    });

  instances
    .filter((instance) => instance.state === 'stopped' && instance.desiredState === 'stopped')
    .forEach((instance) => {
      items.push({
        id: `stopped-${instance.id}`,
        tone: 'info',
        title: `${instance.entryKey} ${instance.product} is intentionally stopped`,
        detail: instance.stateReason ?? 'The route is unpublished and the data is retained.',
        href: `/instances/${instance.id}`,
        cta: 'Review instance',
      });
    });

  posture?.unverifiedRestores.forEach((item) => {
    items.push({
      id: `restore-${item.instanceId}`,
      tone: 'caution',
      title: item.lastVerifiedAt
        ? `${item.product} restore evidence is overdue`
        : `${item.product} has no verified restore`,
      detail: item.lastVerifiedAt
        ? `Last passed ${formatRelative(item.lastVerifiedAt)}. A verified restore is required at least quarterly.`
        : 'A backup exists but no restore drill has passed. Required for every stateful deployment.',
      href: '/governance/recovery',
      cta: 'Schedule a drill',
    });
  });

  posture?.staleMetadata.forEach((item) => {
    items.push({
      id: `stale-${item.entryKey}`,
      tone: 'caution',
      title: `${item.entryKey} ${item.product} integration metadata is stale`,
      detail: `Verified ${formatRelative(item.verifiedAt)}; review is ${item.daysOverdue} days overdue.`,
      href: `/catalog/${item.entryKey}`,
      cta: 'Verify metadata',
    });
  });

  posture?.expiringCertificates
    .filter((certificate) => certificate.daysLeft <= 30)
    .forEach((certificate) => {
      items.push({
        id: `cert-${certificate.host}`,
        tone: 'caution',
        title: `Certificate for ${certificate.host} expires in ${certificate.daysLeft} days`,
        detail: 'ACME renewal is automatic, but a failed renewal removes the route.',
        href: '/governance/posture',
        cta: 'Open posture',
      });
    });

  /*
   * The panel promises an impact ranking, so the order is by severity rather than by the order the
   * sections happen to be computed in: a readiness failure outranks a missing restore drill, and an
   * intentional stop — which needs no operator at all — sorts last. `sort` is stable, so items of
   * the same tone keep the order above.
   */
  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}
