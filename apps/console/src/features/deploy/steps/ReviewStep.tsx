import type { CatalogEntry, EnvSchemaVar } from '@seamnex/domain';
import { PACKAGING_LABELS } from '@seamnex/domain';
import {
  Badge,
  Callout,
  DefinitionList,
  InlineNote,
  Panel,
  PanelHeader,
  SplitLayout,
} from '@seamnex/ui';
import type { PreflightCheck, WizardValues } from './types';

export function ReviewStep({
  entry,
  values,
  vars,
  checks,
  unresolved,
  warnings,
  routeHost,
}: {
  entry: CatalogEntry;
  values: WizardValues;
  vars: EnvSchemaVar[];
  checks: PreflightCheck[];
  /**
   * Declared variables the resolved plan could not answer. The summary used to say "N field(s) need
   * attention" without naming one, so the operator had to hunt through seventeen inputs.
   */
  unresolved?: string[];
  /**
   * `POST /instances/preview` returns warnings that are not admission failures — a missing scaffold
   * approval, a reserved slug. They were computed and thrown away, so the operator confirmed a plan
   * whose known caveats had never been shown.
   */
  warnings?: string[];
  /** The API's own answer for the published host; the review must not restate a guess. */
  routeHost?: string;
}) {
  const overridden = vars.filter((variable) => {
    const current = values.env[variable.name] ?? '';
    return current !== '' && current !== (variable.defaultValue ?? '');
  });
  const blocked = checks.some((check) => !check.ok);

  return (
    <SplitLayout ratio="content">
      <Panel>
        <PanelHeader
          eyebrow="Step 5"
          title="Review and deploy"
          description="Nothing is applied until you confirm. The plan is immutable and auditable."
        />
        <div className="p-4">
          <DefinitionList
            columns={2}
            items={[
              { label: 'Catalog entry', value: `${entry.key} · ${entry.product}` },
              // `.seamnex.local` was a second source of truth for the ingress zone: on a host configured
              // with `SEAMNEX_INGRESS_DOMAIN=localhost` the review promised a host the route projection
              // would never publish, and the operator's browser could not resolve it either way.
              {
                label: 'Route',
                value: routeHost ?? 'Resolved by the API — no preview yet',
                mono: true,
                hint: 'The edge, not the wizard, supplies the scheme and port the portal opens.',
              },
              { label: 'Profile', value: values.profileKey },
              { label: 'Source path', value: PACKAGING_LABELS[entry.packaging] },
              {
                label: 'Resources',
                value: `${values.resources.cpu} vCPU · ${(values.resources.memoryMb / 1024).toFixed(1)} GB · ${(values.resources.diskMb / 1024).toFixed(0)} GB`,
              },
              { label: 'License', value: entry.licenseId },
            ]}
          />

          <div className="mt-4">
            <p className="mb-1 font-mono text-faint label-caps">
              Environment overrides ({overridden.length})
            </p>
            {/* "No overrides: catalog defaults and the selected profile are used" was shown for a
                plan with eight unanswered required variables — the opposite of what it said. */}
            {(unresolved ?? []).length > 0 ? (
              <Callout
                tone="caution"
                title={`${unresolved?.length} required value(s) are still unanswered`}
              >
                <ul className="list-disc space-y-1 pl-4 font-mono text-micro">
                  {(unresolved ?? []).map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
                <p className="mt-1.5 text-meta">
                  The catalog declares no default for them, so the install cannot complete until
                  they are supplied on the environment step.
                </p>
              </Callout>
            ) : overridden.length === 0 ? (
              <InlineNote>
                No overrides: catalog defaults and the selected profile are used.
              </InlineNote>
            ) : (
              <ul className="divide-y divide-line rounded-sm border border-line">
                {overridden.map((variable) => (
                  <li
                    key={variable.name}
                    className="flex items-center justify-between gap-3 px-2.5 py-1.5"
                  >
                    <span className="font-mono text-micro text-muted">{variable.name}</span>
                    <span className="font-mono text-micro text-text">
                      {variable.secret ? '••••••••' : values.env[variable.name]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(warnings ?? []).length > 0 ? (
            <div className="mt-4">
              <Callout tone="caution" title="Before you confirm">
                <ul className="list-disc space-y-1 pl-4">
                  {(warnings ?? []).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}

          <div className="mt-4">
            <Callout tone="caution" title="Environment changes apply on recreate">
              A restart is not sufficient for variables marked recreate. The platform records the
              render diff and the change in the audit log.
            </Callout>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader eyebrow="Pre-flight" title="Validation summary" />
        <ul className="divide-y divide-line">
          {checks.map((check) => (
            <li key={check.label} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block text-body text-text">{check.label}</span>
                <span className="mt-0.5 block text-micro leading-snug text-faint">
                  {check.detail}
                </span>
                {check.action && !check.ok ? (
                  <button
                    type="button"
                    className="mt-1 text-micro font-medium text-link underline underline-offset-2"
                    onClick={check.action.onClick}
                  >
                    {check.action.label}
                  </button>
                ) : null}
              </span>
              <Badge tone={check.ok ? 'positive' : check.pending ? 'neutral' : 'danger'} size="sm">
                {check.ok ? 'pass' : check.pending ? 'pending' : 'fail'}
              </Badge>
            </li>
          ))}
        </ul>
        {blocked ? (
          <div className="p-3">
            <Callout tone="danger" title="Pre-flight will refuse this plan">
              Resolve the checks that have not passed above; the deploy action stays disabled until
              every check passes.
            </Callout>
          </div>
        ) : null}
      </Panel>
    </SplitLayout>
  );
}
