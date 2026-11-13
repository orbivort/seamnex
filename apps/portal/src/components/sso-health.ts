import type { SsoHealth } from '@seamnex/domain';
import { formatRelative } from '@seamnex/utils';

/**
 * One sentence for an unproven sign-in path.
 *
 * "Unverified" alone is not actionable: a check that passed two days ago and a check that failed an
 * hour ago are the same boolean and mean different things to the person about to click Open. The
 * API decides *why* (it is the only side that knows the evidence window) and this renders it.
 */
export function describeSsoHealth(health: SsoHealth, fallbackCheckedAt: string): string {
  const when = formatRelative(health.checkedAt ?? fallbackCheckedAt);
  switch (health.reason) {
    case 'ok':
      return `The last end-to-end check passed ${when}.`;
    case 'stale':
      return `The last end-to-end check passed ${when} — ${health.detail} — but that is outside the evidence window, so the platform no longer counts it as proof. Re-run verification to refresh it.`;
    case 'failed':
      return `The last end-to-end check failed ${when}: ${health.detail}`;
    case 'never_checked':
      return 'No end-to-end sign-in check has run for this product yet.';
  }
}
