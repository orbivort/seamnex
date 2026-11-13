import { Link, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { PACKAGING_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  Page,
  PageHeader,
  Panel,
  SkeletonLines,
  Stepper,
  type Step,
} from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';
import { JobProgressPanel } from '../jobs/JobProgressPanel';
import { EnvImportControl } from './steps/EnvImportControl';
import { EnvironmentStep } from './steps/EnvironmentStep';
import { InstanceStep } from './steps/InstanceStep';
import { ResourcesStep } from './steps/ResourcesStep';
import { ReviewStep } from './steps/ReviewStep';
import { SourceStep } from './steps/SourceStep';
import { problemText, STEPS, useDeployWizard } from './use-deploy-wizard';

/**
 * Reads the entry key and hands the wizard a fresh instance for each one.
 *
 * The remount is the reset: changing the entry has to discard the slug, the profile and every
 * typed override, and `key` does that on the first render instead of an effect that clears state
 * one frame after the new product's values have already been painted.
 */
export function DeployWizardPage() {
  const { entryKey = '' } = useParams();
  return <DeployWizard key={entryKey} entryKey={entryKey} />;
}

function DeployWizard({ entryKey }: { entryKey: string }) {
  const {
    entry,
    profiles,
    capacity,
    deploy,
    plan,
    preview,
    vars,
    values,
    update,
    errors,
    step,
    setStep,
    next,
    back,
    submit,
    verdict,
    checks,
    blocked,
    failing,
    waiting,
    unresolvedFields,
    exception,
    routeHost,
    jobId,
    setJobId,
  } = useDeployWizard(entryKey);

  if (entry.isPending) {
    return (
      <Panel inset>
        <SkeletonLines lines={8} />
      </Panel>
    );
  }
  if (entry.isError) return <QueryError error={entry.error} onRetry={() => void entry.refetch()} />;

  const steps: Step[] = STEPS.map((item, index) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    state: index < step ? 'complete' : index === step ? 'current' : 'upcoming',
  }));

  return (
    <Page>
      <Link
        to={`/catalog/${entryKey}`}
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> {entry.data.key} {entry.data.product}
      </Link>

      <PageHeader
        eyebrow="Deployment"
        title={`Deploy ${entry.data.product}`}
        description="One operator action, no shell work. Pre-flight refuses unknown entries, unpinned images, unresolved sources, invalid environment values and insufficient capacity."
        meta={
          <>
            <Badge tone="accent" size="sm">
              {PACKAGING_LABELS[entry.data.packaging]}
            </Badge>
            <Badge tone="neutral" size="sm">
              {entry.data.key} · {entry.data.domain}
            </Badge>
            <span className="font-mono text-micro text-faint">target ≤ 30 min median</span>
          </>
        }
      />

      {jobId ? (
        <div className="space-y-3">
          {/* A retry is a new job; following it keeps the console honest about which run it shows. */}
          <JobProgressPanel jobId={jobId} onRetried={setJobId} />
          <p className="text-meta text-faint">
            The steps run against Docker through the scoped socket proxy. The instance is not
            reported ready until every container runs and all blocking integration checks pass.
          </p>
        </div>
      ) : (
        <>
          <Panel className="mb-3" inset>
            <Stepper
              steps={steps}
              onSelect={(id) => setStep(STEPS.findIndex((item) => item.id === id))}
            />
          </Panel>

          {step === 0 ? (
            <InstanceStep
              entry={entry.data}
              values={values}
              errors={errors}
              profiles={profiles.data ?? []}
              {...(routeHost === undefined ? {} : { routeHost })}
              onChange={update}
            />
          ) : null}
          {step === 1 ? <SourceStep entry={entry.data} exception={exception} /> : null}
          {step === 2 ? (
            <EnvironmentStep
              entry={entry.data}
              vars={vars}
              values={values}
              errors={errors}
              onChange={update}
              {...(plan.data ? { plan: plan.data } : {})}
              importControl={
                <EnvImportControl
                  entryKey={entryKey}
                  onApply={(imported) => update({ env: { ...values.env, ...imported } })}
                />
              }
            />
          ) : null}
          {step === 3 ? (
            <ResourcesStep
              entry={entry.data}
              values={values}
              verdict={verdict}
              onChange={update}
              errors={errors}
              {...(capacity.data
                ? {
                    reserveText: `${capacity.data.platformReserve.cpuCores} vCPU, ${(capacity.data.platformReserve.memoryMb / 1024).toFixed(0)} GB memory and ${(capacity.data.platformReserve.diskMb / 1024).toFixed(0)} GB disk are held back for the control plane, identity provider and observability.`,
                  }
                : {})}
              {...(capacity.isError ? { capacityError: problemText(capacity.error) } : {})}
              {...(preview.data !== undefined && !preview.data.admissible
                ? { serverRefusal: `${preview.data.headline}. ${preview.data.detail}` }
                : {})}
              onRetryCapacity={() => void capacity.refetch()}
            />
          ) : null}
          {step === 4 ? (
            <ReviewStep
              entry={entry.data}
              values={values}
              vars={vars}
              checks={checks}
              unresolved={unresolvedFields}
              warnings={preview.data?.warnings ?? []}
              {...(routeHost === undefined ? {} : { routeHost })}
            />
          ) : null}

          {deploy.isError ? (
            <div className="mt-3">
              <QueryError error={deploy.error} compact />
            </div>
          ) : null}

          {blocked && step < STEPS.length - 1 ? (
            <p
              id="deploy-blocked"
              className={`mt-3 text-micro ${failing.length > 0 ? 'text-danger' : 'text-muted'}`}
            >
              {/* The sentence used to read "Pre-flight is blocking deployment: slug is free and
                  valid; environment resolves without errors", which named the failing checks by
                  their *pass* condition and read as its own contradiction. It then named *pending*
                  checks as unsatisfied too, so the first step claimed a failure no read had found. */}
              {failing.length > 0
                ? `Pre-flight is blocking this deployment. Not yet satisfied: ${failing.join('; ')}.`
                : `Pre-flight is still resolving: ${waiting.join('; ')}.`}{' '}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => setStep(STEPS.length - 1)}
              >
                Open the validation summary
              </button>
              .
            </p>
          ) : null}

          {/* A submit-time refusal is a field error, and the fields live on earlier steps. Without
              this, a click that failed validation on the review step changed nothing on screen and
              read as a dead button. */}
          {step === STEPS.length - 1 && Object.keys(errors).length > 0 ? (
            <p className="mt-3 text-micro text-danger" role="alert">
              {Object.values(errors).join(' ')}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <Button variant="ghost" icon={<ArrowLeft />} disabled={step === 0} onClick={back}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              <span className="font-mono text-micro text-faint">
                step {step + 1} / {STEPS.length}
              </span>
              {step < STEPS.length - 1 ? (
                <Button variant="primary" trailing={<ArrowRight />} onClick={next}>
                  Continue
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Rocket />}
                  disabled={deploy.isPending || blocked}
                  onClick={submit}
                  aria-describedby={
                    blocked && step < STEPS.length - 1 ? 'deploy-blocked' : undefined
                  }
                >
                  {deploy.isPending ? 'Starting deployment…' : 'Deploy instance'}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
