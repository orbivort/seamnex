import type { AdmissionOutcome, CatalogEntry } from '@seamnex/domain';
import { Button, Callout, Field, Grid, Input, Panel, PanelHeader, SplitLayout } from '@seamnex/ui';
import type { WizardValues } from './types';

export function ResourcesStep({
  entry,
  values,
  verdict,
  onChange,
  reserveText,
  capacityError,
  serverRefusal,
  onRetryCapacity,
  errors,
}: {
  entry: CatalogEntry;
  values: WizardValues;
  verdict: AdmissionOutcome | null;
  onChange: (patch: Partial<WizardValues>) => void;
  /** Sourced from the capacity payload so the number can never disagree with admission. */
  reserveText?: string;
  /** Why the capacity read failed. Without it the panel showed a spinner that never resolved. */
  capacityError?: string;
  /**
   * The server's own refusal, when `POST /instances/preview` disagrees with the local arithmetic.
   * The panel used to show only the browser's verdict, so it could report "Admissible" for a plan
   * the control plane had already refused.
   */
  serverRefusal?: string;
  onRetryCapacity?: () => void;
  /**
   * `errors.resources` was collected and then never rendered: the step blocked "Next" and said
   * nothing, which reads as a broken button. A shape below the catalog minimum, or a blank CPU, is
   * now visible on the field it disqualifies.
   */
  errors?: Record<string, string>;
}) {
  const fits = verdict ? verdict.admissible : null;

  return (
    <SplitLayout ratio="content">
      <Panel>
        {/* FR-1.9 — requirement id, developer-only; the eyebrow keeps its step number only. */}
        <PanelHeader
          eyebrow="Step 4"
          title="Resources and admission"
          description="Per-instance limits are enforced. A deployment that would breach the host, including the platform reserve, is refused before it starts."
        />
        <Grid cols={3} className="gap-4 p-4">
          <Field label="CPU (vCPU)" htmlFor="cpu" hint={`Catalog default ${entry.resources.cpu}`}>
            <Input
              id="cpu"
              type="number"
              min={0.25}
              step={0.25}
              invalid={Boolean(errors?.resources)}
              value={values.resources.cpu}
              onChange={(event) =>
                onChange({ resources: { ...values.resources, cpu: Number(event.target.value) } })
              }
            />
          </Field>
          <Field
            label="Memory (MB)"
            htmlFor="memory"
            hint={`Catalog default ${entry.resources.memoryMb}`}
          >
            <Input
              id="memory"
              type="number"
              min={256}
              step={256}
              invalid={Boolean(errors?.resources)}
              value={values.resources.memoryMb}
              onChange={(event) =>
                onChange({
                  resources: { ...values.resources, memoryMb: Number(event.target.value) },
                })
              }
            />
          </Field>
          <Field
            label="Disk (MB)"
            htmlFor="disk"
            hint={`Catalog default ${entry.resources.diskMb}`}
          >
            <Input
              id="disk"
              type="number"
              min={1024}
              step={1024}
              value={values.resources.diskMb}
              onChange={(event) =>
                onChange({ resources: { ...values.resources, diskMb: Number(event.target.value) } })
              }
            />
          </Field>
        </Grid>
        {errors?.resources ? (
          <p className="px-4 pb-4 text-micro text-danger" role="alert">
            {errors.resources}
          </p>
        ) : null}
      </Panel>

      <div className="space-y-3">
        <Panel>
          <PanelHeader
            eyebrow="Verdict"
            title={
              serverRefusal !== undefined
                ? 'Refused by the control plane'
                : fits === null
                  ? 'Checking capacity'
                  : fits
                    ? 'Admissible'
                    : 'Insufficient capacity'
            }
          />
          <div className="space-y-2 p-4 text-body text-muted">
            {verdict ? (
              <>
                <p>
                  Requested:{' '}
                  <span className="font-mono text-text">
                    {values.resources.cpu} vCPU · {(values.resources.memoryMb / 1024).toFixed(1)} GB
                    · {(values.resources.diskMb / 1024).toFixed(0)} GB
                  </span>
                </p>
                <p>
                  Admissible limit:{' '}
                  <span className="font-mono text-text">
                    {verdict.limits.cpu.toFixed(1)} vCPU ·{' '}
                    {(verdict.limits.memoryMb / 1024).toFixed(1)} GB ·{' '}
                    {(verdict.limits.diskMb / 1024).toFixed(0)} GB
                  </span>
                </p>
                <p>
                  Used after this request:{' '}
                  <span className="font-mono text-text">
                    {verdict.used.cpu.toFixed(1)} vCPU · {(verdict.used.memoryMb / 1024).toFixed(1)}{' '}
                    GB · {(verdict.used.diskMb / 1024).toFixed(0)} GB
                  </span>
                </p>
                <p className="text-micro leading-relaxed text-faint">{verdict.detail}</p>
              </>
            ) : capacityError ? (
              <div className="space-y-2">
                <p role="alert" className="text-danger">
                  The capacity snapshot could not be read: {capacityError}
                </p>
                <p className="text-micro text-faint">
                  Nothing has been deployed. Admission cannot be decided without a measurement, so
                  the deploy action stays disabled.
                </p>
                {onRetryCapacity ? (
                  <Button variant="secondary" onClick={onRetryCapacity}>
                    Retry capacity
                  </Button>
                ) : null}
              </div>
            ) : (
              <p>Loading capacity snapshot…</p>
            )}
            {verdict && !verdict.admissible ? (
              <p role="alert" className="text-danger">
                {verdict.headline}. Shortfall: {verdict.shortfall.join(', ')}. Reduce resources or
                free capacity.
              </p>
            ) : null}
            {verdict?.admissible && serverRefusal === undefined ? (
              <p className="text-success">{verdict.headline}</p>
            ) : null}
            {serverRefusal !== undefined ? (
              <p role="alert" className="text-danger">
                The control plane refuses this plan: {serverRefusal}
              </p>
            ) : null}
            {verdict ? <p className="text-micro text-faint">{verdict.reserveNote}</p> : null}
          </div>
        </Panel>

        <Callout tone="info" title="Platform reserve">
          {reserveText ??
            'The control plane, identity provider and observability reserve host capacity; admission uses the live reservation reported by the capacity API.'}
        </Callout>
      </div>
    </SplitLayout>
  );
}
