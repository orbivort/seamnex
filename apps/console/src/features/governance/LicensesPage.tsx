import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { toProblem, useLicenses, useSetHostedService } from '@seamnex/api-client';
import { canMutate, type LicenseRecord } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  defineColumns,
} from '@seamnex/ui';
import { formatDate } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';
import { useSession } from '../../session';

/** Resale and hosted-service limits describe the same act: offering the product to third parties. */
function isBlocked(record: LicenseRecord): boolean {
  return record.resaleRestricted || record.hostedServiceRestricted;
}

const rowKey = (row: LicenseRecord): string => row.instanceId;

/**
 * Every row in this register describes one deployment, and that deployment has a screen. The
 * licence terms are the row's identity, so its cell is the anchor — the same destination the patch
 * register and the overview already link to, which keeps three registers over the same rows behaving
 * the same way (A11Y-04: one keyboard stop per row, native open-in-new-tab).
 */
function renderLicenseLink(row: LicenseRecord, className: string, children: ReactNode): ReactNode {
  return (
    <Link to={`/instances/${row.instanceId}`} className={className}>
      {children}
    </Link>
  );
}

/**
 * FR-1.14 / AC-44: the register is a gate — a restricted licence refuses hosted-service mode with a reason.
 *
 * "Hosted service" is a licensing posture, not a power switch: it records whether this instance is
 * offered to third parties as a service (C-3). The state is always spelled out; the button only
 * changes it.
 */
function HostedServiceCell({ record, canManage }: { record: LicenseRecord; canManage: boolean }) {
  const setHosted = useSetHostedService(record.instanceId);
  const problem = setHosted.error ? toProblem(setHosted.error) : null;
  const blocked = isBlocked(record);
  const action = record.hostedService ? 'Disable' : 'Enable';
  const explanation = record.hostedService
    ? `Records ${record.product} as internal use only again. Customers and third parties are no longer offered this instance.`
    : `Records ${record.product} as offered to third parties as a hosted service. A licence that restricts resale or hosted-service provision refuses this change.`;

  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={
          record.hostedService
            ? 'text-micro font-semibold whitespace-nowrap text-warning-strong'
            : 'text-micro whitespace-nowrap text-faint'
        }
      >
        {record.hostedService ? 'offered as hosted service' : 'internal use only'}
      </span>
      <Button
        size="sm"
        variant={record.hostedService ? 'secondary' : 'quiet'}
        disabled={!canManage || setHosted.isPending}
        aria-busy={setHosted.isPending ? true : undefined}
        aria-describedby={problem ? `hosted-${record.instanceId}` : undefined}
        // Every row has an "Enable" button; the product name is what makes the name unique.
        aria-label={`${action} hosted-service flag for ${record.product}: ${explanation}`}
        title={
          canManage
            ? explanation
            : 'Changing hosted-service mode needs the license.manage capability (R1).'
        }
        onClick={() => setHosted.mutate(!record.hostedService)}
      >
        {setHosted.isPending ? 'Saving…' : action}
      </Button>
      {blocked && !record.hostedService ? (
        <span
          className="max-w-[210px] truncate text-right text-micro text-warning-strong"
          title={`${record.licenseId} does not permit resale or hosted-service provision`}
        >
          blocked by {record.licenseId}
        </span>
      ) : null}
      {problem ? (
        <span
          id={`hosted-${record.instanceId}`}
          role="alert"
          className="max-w-[210px] text-right text-micro leading-snug text-danger"
        >
          {problem.detail}
        </span>
      ) : null}
    </div>
  );
}

export function LicensesPage() {
  const { session } = useSession();
  const licenses = useLicenses();
  const rows = licenses.data ?? [];
  const canManage = canMutate(session.role, 'license.manage');

  /**
   * Memoised, not hoisted: the hosted-service cell needs `canManage`, which comes from the session.
   * A boolean is a real dependency, so the array is rebuilt only when the role changes.
   */
  const columns = useMemo(
    () =>
      defineColumns<LicenseRecord>([
        {
          id: 'entry',
          header: 'Key',
          width: '52px',
          cell: (row) => (
            <span className="font-mono text-micro font-semibold text-muted">{row.entryKey}</span>
          ),
        },
        {
          id: 'product',
          header: 'Product',
          // The anchor supplied by `renderLicenseLink` carries the type styles, so the cell must
          // not add a second set on top of them.
          primary: true,
          cell: (row) => row.product,
        },
        {
          id: 'license',
          header: 'License',
          mono: true,
          cell: (row) => <span className="text-micro text-muted">{row.licenseId}</span>,
        },
        {
          id: 'obligations',
          header: 'Obligations',
          hideBelow: 'lg',
          cell: (row) =>
            row.obligations.length === 0 ? (
              <span className="text-micro text-warning-strong">None recorded</span>
            ) : (
              <ul className="max-w-md space-y-0.5">
                {row.obligations.map((obligation) => (
                  <li key={obligation} className="text-micro leading-snug text-muted">
                    · {obligation}
                  </li>
                ))}
              </ul>
            ),
        },
        {
          id: 'restrictions',
          header: 'Restrictions',
          hideBelow: 'md',
          cell: (row) => (
            <div className="flex flex-wrap gap-1">
              {row.resaleRestricted ? (
                <Badge tone="danger" size="sm">
                  no resale
                </Badge>
              ) : null}
              {row.hostedServiceRestricted ? (
                <Badge tone="caution" size="sm">
                  no hosted service
                </Badge>
              ) : null}
              {!row.resaleRestricted && !row.hostedServiceRestricted ? (
                // No obligations and no review means no term is on file at all: the gate will
                // refuse, so "none" would overstate what the platform knows.
                row.status === 'review_required' && row.obligations.length === 0 ? (
                  <span className="text-micro text-faint">not assessed</span>
                ) : (
                  <span className="text-micro text-faint">none</span>
                )
              ) : null}
            </div>
          ),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (row) => (
            <Badge tone={row.status === 'cleared' ? 'positive' : 'caution'} size="sm">
              {row.status === 'cleared' ? 'cleared' : 'review required'}
            </Badge>
          ),
        },
        {
          id: 'reviewed',
          header: 'Reviewed',
          hideBelow: 'xl',
          cell: (row) =>
            row.reviewedAt === null ? (
              <span className="text-micro font-medium text-warning-strong">Not reviewed</span>
            ) : (
              <div className="leading-tight">
                <span className="block text-micro text-muted">{formatDate(row.reviewedAt)}</span>
                {row.reviewedBy === null ? null : (
                  <span className="block text-micro text-faint">{row.reviewedBy}</span>
                )}
              </div>
            ),
        },
        {
          id: 'hosted',
          header: 'Hosted service',
          hideBelow: 'lg',
          align: 'right',
          cell: (row) => <HostedServiceCell record={row} canManage={canManage} />,
        },
      ]),
    [canManage],
  );

  return (
    <Page>
      {/* FR-1.14 · C-3 — requirement ids, developer-only; they used to be the page eyebrow and are
          not part of the rendered interface. */}
      <PageHeader
        title="License register"
        description="License identifier and obligations per instance, with restrictions that block resale or hosted-service provision. The register is a release gate, not an optional report."
        meta={
          <>
            <Badge tone="accent" size="sm">
              {rows.length} instances
            </Badge>
            <Badge tone="caution" size="sm">
              {rows.filter((row) => row.status === 'review_required').length} require review
            </Badge>
            <Badge tone="danger" size="sm">
              {rows.filter((row) => row.resaleRestricted).length} resale-restricted
            </Badge>
            <Badge tone="caution" size="sm">
              {rows.filter((row) => row.hostedServiceRestricted).length} hosted-service blocked
            </Badge>
          </>
        }
      />

      <Callout tone="info" title="Release gate, not a report" className="mb-3">
        A licence that restricts resale or hosted-service provision blocks that configuration. The
        refusal names the licence and the reason, and is recorded in the audit trail.
      </Callout>

      {!canManage ? (
        <Callout tone="info" title="Read-only register" className="mb-3">
          R2 can audit licence terms and restrictions; changing hosted-service mode needs the
          platform administrator (the <span className="font-mono text-meta">license.manage</span>{' '}
          capability).
        </Callout>
      ) : null}

      <Panel>
        <PanelHeader
          eyebrow="Register"
          title="Recorded licenses"
          description="Reviewed by the auditor; licence terms are verified against the upstream LICENSE file before procurement. The hosted-service flag records whether an instance is offered to third parties as a service (C-3), not whether it is running."
        />
        {/*
          A register that keeps its rows through a failed refetch: the licence terms on screen are
          still the last thing the API said, and a background failure must not delete a release
          gate an operator is reading (ERR-04).
        */}
        <AsyncPanel
          query={licenses}
          loading={
            <div className="p-4">
              <SkeletonLines lines={7} />
            </div>
          }
          loadingLabel="Loading the license register"
        >
          {(data) => (
            <DataTable
              columns={columns}
              rows={data}
              rowKey={rowKey}
              dense
              renderRowLink={renderLicenseLink}
              rowTone={(row) => (row.status === 'review_required' ? 'caution' : 'default')}
              empty={
                <EmptyState
                  title="No licensed deployments"
                  description="The register lists every deployed instance. Deploy a catalog entry and its licence identifier, obligations and restrictions appear here."
                />
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}
