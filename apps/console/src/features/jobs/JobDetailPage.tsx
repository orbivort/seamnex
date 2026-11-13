import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { useInstance, useInstancePlan, useJob, useLifecycleAction } from '@seamnex/api-client';
import {
  canMutate,
  INSTANCE_STATE_LABELS,
  JOB_KIND_LABELS,
  lifecycleAvailability,
} from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Page,
  PageHeader,
  Panel,
  SkeletonLines,
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { apiMode } from '../../api-mode';
import { useSession } from '../../session';
import { JobProgressPanel } from './JobProgressPanel';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const job = useJob(id);
  const { session } = useSession();
  const [confirming, setConfirming] = useState(false);

  /**
   * FR-1.7 / AC-06: "a failure triggers a **surfaced** rollback that restores service". The upgrade
   * dialog promises a one-step rollback, but this page — where a failed upgrade lands — offered only
   * "Open instance", so recovery was two navigations deep and the promise had nothing behind it.
   *
   * The same query is reused for the availability verdict: `rollbackAvailable` is false when the
   * instance has no retained predecessor, and the button then explains itself instead of queueing a
   * job whose only outcome is "no previous render set".
   */
  const failedUpgrade = job.data?.kind === 'upgrade' && job.data.state === 'failed';
  const instanceId = failedUpgrade ? (job.data?.instanceId ?? '') : '';
  const instance = useInstance(instanceId);
  const plan = useInstancePlan(instanceId, failedUpgrade ? 'rollback' : null);
  const lifecycle = useLifecycleAction();

  const instanceState = instance.data?.state;
  const stateAllows =
    instanceState === undefined ? false : lifecycleAvailability(instanceState).rollback;
  const permitted = canMutate(session.role, 'instance.lifecycle');
  const rollbackAvailable = plan.data?.rollbackAvailable === true;
  const canRollback = permitted && stateAllows && rollbackAvailable;
  const blockedReason = !permitted
    ? 'Rolling back requires the platform administrator role.'
    : instanceState === undefined
      ? 'Waiting for the instance state.'
      : !stateAllows
        ? `Not available from ${INSTANCE_STATE_LABELS[instanceState]}.`
        : !rollbackAvailable
          ? 'No previous render set is retained for this instance; the pre-upgrade backup can restore data instead.'
          : null;

  return (
    <Page>
      <Link
        to="/jobs"
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Jobs
      </Link>

      <PageHeader
        eyebrow={
          <>
            <span className="font-mono text-faint label-caps">
              {job.data ? JOB_KIND_LABELS[job.data.kind] : 'Job'}
            </span>
            <Badge tone="neutral" size="sm">
              {id}
            </Badge>
          </>
        }
        title={job.data?.label ?? 'Job detail'}
        description={job.data?.summary}
        meta={
          job.data ? (
            <>
              <span className="text-meta text-muted">requested by {job.data.requestedBy}</span>
              <span className="font-mono text-micro text-faint">
                {formatDateTime(job.data.createdAt)}
              </span>
              <span className="font-mono text-micro text-faint">30-day retention</span>
            </>
          ) : null
        }
      />

      {/*
        The panel below owns its own loading and error surface for the job it renders, but this
        region still needs the three branches: without them the page header renders against an
        undefined job and the panel is mounted with an empty id.
      */}
      <AsyncPanel
        query={job}
        loading={
          <Panel inset>
            <SkeletonLines lines={6} />
          </Panel>
        }
        loadingLabel="Loading the job"
        renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
      >
        {(data) => (
          <JobProgressPanel
            jobId={data.id}
            onRetried={(newJobId) => navigate(`/jobs/${newJobId}`, { replace: true })}
          />
        )}
      </AsyncPanel>

      {failedUpgrade ? (
        <Alert
          tone="danger"
          title="Upgrade failed — the previous version can be restored"
          className="mt-3"
          action={
            <Button
              size="sm"
              variant="danger"
              icon={<RotateCcw />}
              disabled={!canRollback || lifecycle.isPending}
              onClick={() => setConfirming(true)}
            >
              Roll back
            </Button>
          }
        >
          <p>
            The rollback restores the previously running render set and re-checks readiness. It is
            recorded in the audit log; the pre-upgrade backup is kept either way.
          </p>
          {blockedReason ? <p className="mt-1.5 text-micro">{blockedReason}</p> : null}
        </Alert>
      ) : null}
      {lifecycle.isError ? <QueryError error={lifecycle.error} compact /> : null}

      {/* Only true of a mock build. Telling an operator on the live stack that the log in front of
          them is simulated undermines every other statement on the page. */}
      {apiMode === 'mock' ? (
        <p className="mt-3 text-meta leading-relaxed text-faint">
          Logs are simulated. In production they stream from the executor through SSE, with secrets
          masked at the source and a 30-day retention window.
        </p>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setConfirming(false))}
          title="Roll back this instance?"
          description="The previously running render set is restored and readiness is re-checked. The failed render set is retained, so the upgrade can be retried."
          confirmLabel="Roll back"
          tone="danger"
          busy={lifecycle.isPending}
          onConfirm={() => {
            lifecycle.mutate(
              { id: instanceId, action: 'rollback' },
              {
                onSuccess: (accepted) => {
                  setConfirming(false);
                  navigate(`/jobs/${accepted.jobId}`);
                },
              },
            );
          }}
        />
      ) : null}
    </Page>
  );
}
