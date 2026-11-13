import type { ReactNode } from 'react';
import type { CatalogEntry, EnvPlan, EnvSchemaVar } from '@seamnex/domain';
import { ENV_SOURCE_LABELS, OVERRIDE_CEILING_LABELS } from '@seamnex/domain';
import {
  Callout,
  Checkbox,
  Field,
  Grid,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  Select,
  Tag,
} from '@seamnex/ui';
import type { WizardValues } from './types';

/**
 * A requirement note states what the deployment needs; it is not a verdict on what the operator
 * typed. Red is the validation channel here — the `Field` error, the block banner and
 * `resolved.error` — so painting an untouched required field in `text-danger` read as "already
 * rejected" before anything had been entered. `warning-strong` is also how the catalog schema
 * table states the same condition, so both views of one variable agree.
 */
const REQUIREMENT_NOTE = 'mt-0.5 block text-micro text-warning-strong';

export function EnvironmentStep({
  entry,
  vars,
  values,
  errors,
  onChange,
  plan,
  importControl,
}: {
  entry: CatalogEntry;
  vars: EnvSchemaVar[];
  values: WizardValues;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardValues>) => void;
  plan?: EnvPlan;
  importControl?: ReactNode;
}) {
  // Counted from the resolved plan, not from the wizard state: a stored secret has no value here to
  // count, and a variable with no value at all is exactly what the operator needs to notice.
  const unresolvedCount =
    plan?.values.filter((item) => item.value === null && !item.masked).length ?? 0;
  return (
    <div className="space-y-3">
      <Callout tone="info" title="Values are validated before the container starts">
        Precedence: catalog default → environment profile → instance override → secret store.
        Variables capped at “Locked” reject both profile and instance values.
      </Callout>

      <Panel>
        <PanelHeader
          eyebrow={`Step 3 · ${vars.length} declared variables`}
          title={`Environment for ${entry.product}`}
          description="Secrets are write-only: once saved they are masked in the UI, logs, job output and audit records."
          actions={importControl}
        />
        {vars.length === 0 ? (
          <div className="p-4">
            <InlineNote>
              This entry declares no environment variables, so there is nothing to resolve before
              the container starts.
            </InlineNote>
          </div>
        ) : null}
        <Grid cols={2} className="gap-4 p-4">
          {vars.map((variable) => {
            // FR-1.26: only profile_and_instance variables may be set for this instance.
            const locked = variable.overrideCeiling !== 'profile_and_instance';
            const value = values.env[variable.name] ?? '';
            const resolved = plan?.values.find((item) => item.name === variable.name);
            // A masked value has no readable value by construction; an *unmasked* null is a variable
            // nothing supplied, which is what the operator needs to see before confirming.
            const unresolved =
              resolved !== undefined && resolved.value === null && !resolved.masked;
            // The plan answers each variable with its own error; the wizard only rendered the
            // browser-side check, so a value the API had already refused looked accepted. A plan
            // verdict outranks the static requirement note below: both said "enter a value", and
            // printing the same demand in two colours read as two different faults. The plan sends
            // an empty string for the variables it accepted, which is not a verdict.
            const planError =
              resolved?.error && !errors[`env.${variable.name}`] ? resolved.error : undefined;
            const hint = (
              <span className="block">
                {/* A boolean's purpose is already the checkbox's own label; repeating it here printed
                    the same paragraph twice. */}
                {variable.type === 'boolean' ? null : (
                  <span className="block">{variable.purpose}</span>
                )}
                {/* The declared format, before the operator types instead of after the API refuses
                    the value: `rule` makes this sentence enforceable, so it is worth showing. */}
                {variable.constraint && variable.type !== 'boolean' ? (
                  <span className="mt-0.5 block text-micro text-faint">{variable.constraint}</span>
                ) : null}
                {variable.conditional ? (
                  <span className={REQUIREMENT_NOTE}>{variable.conditional}</span>
                ) : null}
                {resolved ? (
                  <span className="mt-0.5 block font-mono text-micro">
                    resolves to{' '}
                    {resolved.masked
                      ? '••••••••'
                      : resolved.value === null
                        ? 'not set'
                        : resolved.value === ''
                          ? 'empty'
                          : resolved.value}{' '}
                    {/* "not set · catalog default" claimed a default that the catalog does not
                        declare: the source layer answered `null`, which is the opposite. */}
                    ·{' '}
                    {resolved.value === null && resolved.source === 'default'
                      ? 'no catalog default declared'
                      : ENV_SOURCE_LABELS[resolved.source].toLowerCase()}
                  </span>
                ) : null}
                {unresolved && variable.required && planError === undefined ? (
                  <span className={REQUIREMENT_NOTE}>
                    Required for this deployment, and nothing resolves it: enter a value before
                    continuing.
                  </span>
                ) : null}
                {unresolved &&
                !variable.required &&
                variable.conditional &&
                planError === undefined ? (
                  <span className={REQUIREMENT_NOTE}>
                    No value resolved, and the condition above makes it required for this
                    deployment.
                  </span>
                ) : null}
                {planError === undefined ? null : (
                  <span className="mt-0.5 block text-micro text-danger">{planError}</span>
                )}
              </span>
            );
            return (
              <Field
                key={variable.name}
                label={variable.name}
                required={variable.required}
                htmlFor={`env-${variable.name}`}
                hint={hint}
                error={errors[`env.${variable.name}`]}
                optionalLabel={
                  variable.secret
                    ? 'secret'
                    : variable.overrideCeiling === 'none'
                      ? 'locked'
                      : variable.overrideCeiling === 'profile_only'
                        ? 'profile only'
                        : OVERRIDE_CEILING_LABELS[variable.overrideCeiling]
                }
              >
                {variable.type === 'boolean' ? (
                  <Checkbox
                    id={`env-${variable.name}`}
                    label={variable.purpose}
                    checked={value === 'true'}
                    disabled={locked}
                    onChange={(event) =>
                      onChange({
                        env: {
                          ...values.env,
                          [variable.name]: event.target.checked ? 'true' : 'false',
                        },
                      })
                    }
                  />
                ) : variable.type === 'enum' ? (
                  <Select
                    id={`env-${variable.name}`}
                    value={value}
                    disabled={locked}
                    onChange={(event) =>
                      onChange({ env: { ...values.env, [variable.name]: event.target.value } })
                    }
                  >
                    <option value="">Choose…</option>
                    {(variable.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`env-${variable.name}`}
                    type={
                      variable.secret ? 'password' : variable.type === 'integer' ? 'number' : 'text'
                    }
                    value={value}
                    disabled={locked}
                    invalid={Boolean(errors[`env.${variable.name}`])}
                    placeholder={
                      variable.secret
                        ? // The platform does not generate these values, and the field is required:
                          // "Generated and stored by the platform" next to "A value is required."
                          // told the operator to do nothing and wait.
                          'Enter a value; stored write-only in the secret store'
                        : (variable.defaultValue ?? '')
                    }
                    autoComplete="off"
                    onChange={(event) =>
                      onChange({ env: { ...values.env, [variable.name]: event.target.value } })
                    }
                  />
                )}
              </Field>
            );
          })}
        </Grid>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <InlineNote>
            Conditional requirements are declared per variable above. Required, type, ceiling and
            declared format rules are evaluated by the API before the container starts; a
            conditionally required variable with no value is reported here, not enforced.
          </InlineNote>
          <Tag mono>
            {Object.values(values.env).filter(Boolean).length} set · {unresolvedCount} unresolved
          </Tag>
        </div>
      </Panel>
    </div>
  );
}
