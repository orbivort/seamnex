import { useState } from 'react';
import { toProblem, usePutWorkflowTrigger } from '@seamnex/api-client';
import type { Tone, Workflow, WorkflowTriggerUpdate } from '@seamnex/domain';
import { TRIGGER_LABELS } from '@seamnex/domain';
import {
  Alert,
  Button,
  Field,
  Grid,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  Select,
} from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';

const TYPES: readonly Workflow['trigger']['type'][] = ['webhook', 'schedule', 'poll', 'manual'];

/**
 * FR-5.4: the trigger is part of the definition, not a creation-time choice.
 *
 * Every mode the schema declares is editable here, with the parameters the compiler actually reads:
 * `schedule` needs a cron expression and a timezone, `poll` needs the minimum interval a product with
 * no event mechanism is read on, `webhook` needs nothing because the endpoint is registered against
 * its instance, and `manual` starts nothing on its own. The fields that do not apply are not
 * rendered as disabled inputs — they are absent, so an operator cannot believe a value is in effect.
 */
export function WorkflowTriggerPanel({
  workflow,
  canWrite,
}: {
  workflow: Workflow;
  canWrite: boolean;
}) {
  const save = usePutWorkflowTrigger(workflow.id);
  const [type, setType] = useState(workflow.trigger.type);
  const [cron, setCron] = useState(workflow.trigger.cron ?? '');
  const [timezone, setTimezone] = useState(workflow.trigger.timezone ?? 'UTC');
  const [interval, setInterval] = useState(
    workflow.trigger.minimumIntervalMinutes === null ||
      workflow.trigger.minimumIntervalMinutes === undefined
      ? ''
      : String(workflow.trigger.minimumIntervalMinutes),
  );
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);

  /*
   * State is seeded once, at mount, and never re-seeded in an effect: the workspace polls while a
   * run is in flight, and an effect keyed on the definition would overwrite what the operator is
   * typing on every refetch. The panel is remounted per workflow (the page keys it by workflow id),
   * which is the only time a re-seed is correct; after a save the fields already hold what was sent,
   * and the "In effect" column below reads the definition the server returned.
   */
  const minutes = Number.parseInt(interval, 10);
  const cronProblem = type === 'schedule' && cron.trim().length === 0;
  const intervalProblem = type === 'poll' && !(Number.isInteger(minutes) && minutes > 0);
  const unchanged =
    type === workflow.trigger.type &&
    (type !== 'schedule' ||
      (cron.trim() === (workflow.trigger.cron ?? '') &&
        timezone.trim() === (workflow.trigger.timezone ?? 'UTC'))) &&
    (type !== 'poll' || String(workflow.trigger.minimumIntervalMinutes ?? '') === interval);
  const blocked = save.isPending || !canWrite || cronProblem || intervalProblem || unchanged;

  const submit = () => {
    setNotice(null);
    const update: WorkflowTriggerUpdate =
      type === 'schedule'
        ? { type, cron: cron.trim(), timezone: timezone.trim() === '' ? 'UTC' : timezone.trim() }
        : type === 'poll'
          ? { type, minimumIntervalMinutes: minutes }
          : { type, cron: null, minimumIntervalMinutes: null };
    save.mutate(update, {
      onSuccess: (savedWorkflow) => {
        setNotice({
          tone: 'positive',
          text: `Trigger saved as version ${savedWorkflow.version}. Validate, then re-activate, so the compiled definition carries it.`,
        });
      },
    });
  };

  const failure = save.error ? toProblem(save.error) : null;

  return (
    <Panel>
      {/* The requirement id was the eyebrow, which is a note to us and noise to an operator. */}
      <PanelHeader eyebrow="Starting mode" title="Trigger" />
      <Grid cols={2} className="p-4">
        <div className="space-y-3">
          <Field
            label="Mode"
            htmlFor="workflow-trigger-type"
            required
            hint="How a run starts. Changing it writes a new definition version."
          >
            <Select
              id="workflow-trigger-type"
              value={type}
              disabled={!canWrite || save.isPending}
              onChange={(event) => setType(event.target.value as Workflow['trigger']['type'])}
            >
              {TYPES.map((option) => (
                <option key={option} value={option}>
                  {TRIGGER_LABELS[option] ?? option}
                </option>
              ))}
            </Select>
          </Field>

          {type === 'schedule' ? (
            <div className="space-y-3">
              <Field
                label="Cron expression"
                htmlFor="workflow-trigger-cron"
                required
                error={cronProblem ? 'A scheduled workflow needs a cron expression.' : undefined}
                hint="Five fields, evaluated in the timezone below. For example 0 2 * * * is 02:00 daily."
              >
                <Input
                  id="workflow-trigger-cron"
                  value={cron}
                  spellCheck={false}
                  className="font-mono"
                  invalid={cronProblem}
                  disabled={!canWrite || save.isPending}
                  onChange={(event) => setCron(event.target.value)}
                />
              </Field>
              <Field
                label="Timezone"
                htmlFor="workflow-trigger-timezone"
                hint="IANA name, for example Europe/Berlin. The engine evaluates the cron here, not in UTC."
              >
                <Input
                  id="workflow-trigger-timezone"
                  value={timezone}
                  spellCheck={false}
                  className="font-mono"
                  disabled={!canWrite || save.isPending}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {type === 'poll' ? (
            <Field
              label="Minimum interval"
              htmlFor="workflow-trigger-interval"
              required
              error={
                intervalProblem ? 'State the interval in whole minutes, at least 1.' : undefined
              }
              hint="Minutes between polls. Use this for a product that publishes no event, so nothing can push a delivery."
            >
              <Input
                id="workflow-trigger-interval"
                type="number"
                min={1}
                step={1}
                value={interval}
                invalid={intervalProblem}
                disabled={!canWrite || save.isPending}
                onChange={(event) => setInterval(event.target.value)}
              />
            </Field>
          ) : null}

          {notice ? <Alert tone={notice.tone} title={notice.text} /> : null}
          {failure ? (
            <Alert tone="danger" title={failure.title}>
              {failure.detail} {failure.remediation}
            </Alert>
          ) : null}
          {save.isError && failure === null ? <QueryError error={save.error} compact /> : null}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={blocked}
              onClick={submit}
              title={!canWrite ? 'workflow.author is required to change the trigger' : undefined}
            >
              {save.isPending ? 'Saving…' : 'Save trigger'}
            </Button>
            {!canWrite ? (
              <span className="text-meta text-faint">Read only: workflow.author is required.</span>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <p className="font-mono text-faint label-caps">In effect</p>
          <p className="text-meta text-text">
            {TRIGGER_LABELS[workflow.trigger.type] ?? workflow.trigger.type} ·{' '}
            <span className="font-mono text-micro text-muted">{workflow.trigger.config}</span>
          </p>
          {/*
            The explanation describes the *selected* mode while the line above describes the stored
            one. Without this note, picking Schedule left "Manual · Manual" beside a paragraph about
            crons, which reads as a contradiction rather than as a preview.
          */}
          {unchanged ? null : (
            <p className="text-micro font-medium text-warning-strong">
              {type === workflow.trigger.type
                ? 'Unsaved change: the parameters above apply once you save.'
                : `Unsaved change: saving switches this workflow from ${
                    TRIGGER_LABELS[workflow.trigger.type] ?? workflow.trigger.type
                  } to ${TRIGGER_LABELS[type] ?? type}.`}
            </p>
          )}
          <p className="text-meta leading-relaxed text-muted">{EXPLANATION[type]}</p>
          <InlineNote>
            The trigger travels with the definition: a change creates a new version, and the running
            one keeps its own until you activate the new version.
          </InlineNote>
        </div>
      </Grid>
    </Panel>
  );
}

/** What will actually happen, per mode — the consequence, not a restatement of the label. */
const EXPLANATION: Record<Workflow['trigger']['type'], string> = {
  webhook:
    'The workflow starts when a signed event is delivered to its endpoint. Register the endpoint on the source instance, then sign each request body with the secret shown once at registration.',
  schedule:
    'The execution engine fires the cron expression in the timezone above, whether or not anyone is signed in. No event is needed from the product.',
  poll: 'The execution engine reads the product on the interval above. This is the mode for a product that publishes no event — nothing has to be pushed for the workflow to run.',
  manual:
    'Nothing starts this workflow on its own. Runs are started from this screen with Run now, and every run is recorded.',
};
