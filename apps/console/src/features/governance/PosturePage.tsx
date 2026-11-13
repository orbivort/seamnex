import { Link } from 'react-router';
import { ArrowUpRight, Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import { usePosture } from '@seamnex/api-client';
import type { PostureSummary } from '@seamnex/domain';
import {
  Badge,
  Callout,
  DefinitionList,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  Stat,
} from '@seamnex/ui';
import { formatDate, formatDateTime } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';

/**
 * S-2 defines the floor per deployment, not per catalog entry: D5 and D6 share one ERPNext
 * deployment, so an entry count would credit that single deployment twice.
 */
const NATIVE_FLOOR_DEPLOYMENTS = 6;
const NATIVE_BASELINE_DEPLOYMENTS = 12;

type UnverifiedRestore = PostureSummary['unverifiedRestores'][number];

/** Never-verified first; otherwise the oldest drill first, which is the order renewal is due in. */
function restoreUrgency(item: UnverifiedRestore): number {
  return item.lastVerifiedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(item.lastVerifiedAt);
}

function certificateTone(daysLeft: number): 'danger' | 'caution' | 'neutral' {
  if (daysLeft <= 14) return 'danger';
  if (daysLeft <= 30) return 'caution';
  return 'neutral';
}

export function PosturePage() {
  const posture = usePosture();
  const data = posture.data;

  const ssoCovered = data ? data.sso.native + data.sso.forwardAuth : 0;
  const verifiedRestores = data ? data.totalInstances - data.unverifiedRestores.length : 0;
  const noDeployments = data?.totalInstances === 0;

  return (
    <Page>
      {/* FR-4.8 — requirement id, developer-only; it used to be the page eyebrow and is not part
          of the rendered interface. */}
      <PageHeader
        title="Security posture"
        description="SSO coverage, restore verification, certificate expiry and integration-metadata freshness in one board — the evidence an auditor asks for."
        actions={
          data ? (
            <>
              {/*
                These are two different guarantees. One badge called "coverage" used to show the
                restore ratio while the description promised SSO coverage, so a fleet with every
                deployment behind the IdP could read "0% coverage" (the restore figure).
              */}
              <Badge
                tone={
                  noDeployments
                    ? 'neutral'
                    : ssoCovered === data.totalInstances
                      ? 'positive'
                      : 'caution'
                }
                size="md"
              >
                SSO {ssoCovered}/{data.totalInstances}
              </Badge>
              <Badge
                tone={
                  noDeployments
                    ? 'neutral'
                    : data.unverifiedRestores.length === 0
                      ? 'positive'
                      : 'caution'
                }
                size="md"
              >
                Restores {verifiedRestores}/{data.totalInstances}
              </Badge>
            </>
          ) : (
            <Badge tone="neutral" size="md">
              {posture.isError ? 'posture unavailable' : 'loading'}
            </Badge>
          )
        }
      />

      {/*
        The whole board is one read, so it is one async region: a skeleton that matches the board's
        height, a problem panel only when there is nothing to show, and — when a *refetch* fails —
        the last board the API produced behind a caution banner instead of a blank page (ERR-04).
      */}
      <AsyncPanel
        query={posture}
        loading={
          <Panel inset>
            <SkeletonLines lines={8} />
          </Panel>
        }
        loadingLabel="Loading the security posture"
      >
        {(summary) => {
          const sortedRestores = [...summary.unverifiedRestores].sort(
            (a, b) => restoreUrgency(a) - restoreUrgency(b),
          );
          const sortedCertificates = [...summary.expiringCertificates].sort(
            (a, b) => a.daysLeft - b.daysLeft,
          );
          const sortedMetadata = [...summary.staleMetadata].sort(
            (a, b) => b.daysOverdue - a.daysOverdue,
          );
          const restoresVerified = summary.totalInstances - summary.unverifiedRestores.length;
          const covered = summary.sso.native + summary.sso.forwardAuth;
          const floorMet = summary.sso.native >= NATIVE_FLOOR_DEPLOYMENTS;
          /*
           * ADR-BE-22: a gated deployment whose credential the platform holds is still `fa_gate`,
           * so it must not be reported as "credential provisioned outside the platform". The count
           * is what tells an auditor how much of the gated fleet the relay actually carries.
           */
          const managed = summary.sso.platformManagedCredentials ?? 0;

          return (
            <div className="space-y-3">
              {/* Two-up from the narrowest width, like every other KPI row. */}
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <Panel inset>
                  <Stat
                    label="Native SSO"
                    value={summary.sso.native}
                    tone={summary.sso.native > 0 ? 'positive' : 'caution'}
                    hint="deployments authenticate directly against the IdP"
                  />
                </Panel>
                <Panel inset>
                  <Stat
                    label="Forward-auth SSO"
                    value={summary.sso.forwardAuth}
                    tone="accent"
                    hint="deployments via an identity header or delegated sign-in"
                  />
                </Panel>
                <Panel inset>
                  <Stat
                    label="Sign-in required"
                    value={summary.sso.signInRequired}
                    tone={summary.sso.signInRequired > 0 ? 'caution' : 'neutral'}
                    hint="deployments behind a proxy gate that is not single sign-on"
                  />
                </Panel>
                <Panel inset>
                  <Stat
                    label="Verified restores"
                    value={`${restoresVerified}/${summary.totalInstances}`}
                    tone={summary.unverifiedRestores.length === 0 ? 'positive' : 'caution'}
                    hint="deployments with a passed drill in the last quarter"
                  />
                </Panel>
              </div>

              {/* `items-start`, for the same reason as the overview: a one-line panel was being
                  stretched to the height of the panel beside it. */}
              <SplitLayout ratio="even" className="items-start">
                <Panel>
                  <PanelHeader eyebrow="Recovery" title="Instances without a verified restore" />
                  {sortedRestores.length === 0 ? (
                    <p className="flex items-center gap-2 px-4 py-4 text-body text-muted">
                      <ShieldCheck className="size-4 text-success" aria-hidden /> Every stateful
                      deployment has a verified restore.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {sortedRestores.map((item) => (
                        <li
                          key={item.instanceId}
                          className="flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0">
                            <Link
                              to={`/instances/${item.instanceId}`}
                              aria-label={`Inspect ${item.product}`}
                              className="text-body font-medium text-text hover:underline"
                            >
                              {item.product}
                            </Link>
                            <p className="truncate font-mono text-micro text-faint">
                              {item.instanceId}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <Badge tone="caution" size="sm">
                              {item.lastVerifiedAt ? 'overdue' : 'no drill'}
                            </Badge>
                            <p className="mt-0.5 text-micro text-faint">
                              {item.lastVerifiedAt
                                ? `last passed ${formatDate(item.lastVerifiedAt)}`
                                : 'never verified'}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel>
                  <PanelHeader eyebrow="Certificates" title="TLS expiry" />
                  {sortedCertificates.length === 0 ? (
                    <p className="px-4 py-4 text-body text-muted">
                      No certificate was reported inside the renewal window. The edge renews
                      certificates automatically, so an entry appears here only when a renewal is
                      due.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {sortedCertificates.map((certificate) => (
                        <li
                          key={certificate.host}
                          className="flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <span className="min-w-0 truncate font-mono text-meta text-text">
                            {certificate.host}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <Badge tone={certificateTone(certificate.daysLeft)} size="sm">
                              {certificate.daysLeft <= 0
                                ? 'expired'
                                : `${certificate.daysLeft} days`}
                            </Badge>
                            <span
                              className="text-micro text-faint"
                              title={`Expires ${formatDateTime(certificate.expiresAt)}`}
                            >
                              {formatDate(certificate.expiresAt)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </SplitLayout>

              {/* `items-start`, for the same reason as the overview: a one-line panel was being
                  stretched to the height of the panel beside it. */}
              <SplitLayout ratio="even" className="items-start">
                <Panel>
                  {/* FR-2.15 — requirement id, developer-only; the panel header used to carry it
                      as its eyebrow. */}
                  <PanelHeader
                    title="Stale integration metadata"
                    description="Older than one quarter; returned with a staleness flag."
                  />
                  {sortedMetadata.length === 0 ? (
                    <p className="px-4 py-4 text-body text-muted">
                      No entry is overdue for review.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {sortedMetadata.map((item) => (
                        <li
                          key={item.entryKey}
                          className="flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-body font-medium text-text">
                              {item.entryKey} · {item.product}
                            </p>
                            <p className="text-micro text-faint">
                              verified {formatDate(item.verifiedAt)}
                            </p>
                          </div>
                          <Link
                            to={`/catalog/${item.entryKey}`}
                            className="inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-link hover:underline"
                          >
                            {item.daysOverdue} {item.daysOverdue === 1 ? 'day' : 'days'} overdue{' '}
                            <ArrowUpRight className="size-3" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel>
                  <PanelHeader eyebrow="Summary" title="What this board proves" />
                  <div className="p-4">
                    <DefinitionList
                      columns={1}
                      items={[
                        {
                          label: 'SSO coverage',
                          value: `${covered} of ${summary.totalInstances} deployments`,
                          hint:
                            summary.sso.totalEntries === summary.totalInstances
                              ? undefined
                              : `${summary.sso.totalEntries} catalog entries; shared deployments are counted once`,
                        },
                        {
                          label: 'Platform-managed credentials',
                          value: `${managed} of ${summary.sso.signInRequired} gated deployments`,
                          hint:
                            managed === 0
                              ? 'no relayed sign-in is provisioned'
                              : 'a per-user account created and rotated by the sign-in relay',
                        },
                        {
                          label: 'Instances without health check',
                          value: String(summary.instancesWithoutHealthCheck),
                          hint: 'no readiness observation recorded',
                        },
                        { label: 'Generated', value: formatDateTime(summary.generatedAt) },
                      ]}
                    />
                    {summary.missingHealthChecks.length > 0 ? (
                      <div className="mt-3 border-t border-line pt-3">
                        <p className="label-caps-sans mb-1.5">No health check observed</p>
                        <ul className="divide-y divide-line">
                          {summary.missingHealthChecks.map((item) => (
                            <li
                              key={item.instanceId}
                              className="flex items-center justify-between gap-3 py-1.5"
                            >
                              <Link
                                to={`/instances/${item.instanceId}`}
                                aria-label={`Inspect ${item.product}`}
                                className="min-w-0 truncate text-body text-text hover:underline"
                              >
                                {item.product}
                              </Link>
                              <span className="shrink-0 font-mono text-micro text-faint">
                                {item.instanceId}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <Callout
                      tone={floorMet ? 'positive' : 'caution'}
                      title={`Native floor (S-2): ${summary.sso.native} of ${NATIVE_FLOOR_DEPLOYMENTS} required`}
                      className="mt-3"
                    >
                      At least {NATIVE_FLOOR_DEPLOYMENTS} of the {NATIVE_BASELINE_DEPLOYMENTS}{' '}
                      baseline deployments must authenticate natively, counted per deployment so the
                      shared ERPNext instance is not counted twice. This fleet has{' '}
                      {summary.totalInstances} deployments, {summary.sso.native} of them native. A
                      failure becomes a recorded owner decision, never a silent re-baseline.
                    </Callout>
                    <div className="mt-3 flex items-start gap-2 text-meta leading-relaxed text-muted">
                      {summary.sso.signInRequired > 0 ? (
                        <ShieldAlert
                          className="mt-0.5 size-4 shrink-0 text-warning-strong"
                          aria-hidden
                        />
                      ) : (
                        <Info className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
                      )}
                      <p className="min-w-0">
                        {managed > 0
                          ? `${managed} of ${summary.sso.signInRequired} gated deployments sign you in with a platform-managed credential, created per person and rotated with the access that justified it. That is a password relay, not single sign-on: the tile still says “sign-in required” and no surface may call it SSO.`
                          : 'A product labelled “sign-in required” is not single sign-on: its credential is provisioned outside the platform, and the portal says so before launch.'}
                      </p>
                    </div>
                  </div>
                </Panel>
              </SplitLayout>
            </div>
          );
        }}
      </AsyncPanel>
    </Page>
  );
}
