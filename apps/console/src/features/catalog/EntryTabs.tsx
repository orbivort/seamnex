import type { CatalogEntry, EnvSchemaVar, ScaffoldDraft } from '@seamnex/domain';
import {
  CREDENTIAL_GRANULARITY_LABELS,
  OVERRIDE_CEILING_LABELS,
  TRIGGER_LABELS,
  isWorkflowEligible,
  isWriteEligible,
  writeIneligibilityReason,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  DefinitionList,
  EmptyState,
  InlineNote,
  Panel,
  PanelHeader,
  SkeletonLines,
  Tag,
  defineColumns,
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { AsyncPanel, QueryError, type AsyncQuery } from '@seamnex/shell';

/** The inventory row type, named once so the column array can live at module scope. */
type OperationRow = CatalogEntry['integration']['operationInventory'][number];

/**
 * Module scope: both arrays read only their row, so rebuilding them per render bought nothing and
 * cost every row a new set of cell closures.
 */
const OPERATION_COLUMNS = defineColumns<OperationRow>([
  {
    id: 'op',
    header: 'Operation',
    mono: true,
    cell: (row) => <span className="text-meta text-text">{row.id}</span>,
  },
  { id: 'label', header: 'Label', cell: (row) => <span>{row.label}</span> },
  {
    id: 'mode',
    header: 'Mode',
    cell: (row) => (
      <Badge tone={row.mode === 'write' ? 'caution' : 'info'} size="sm">
        {row.mode}
      </Badge>
    ),
  },
  {
    id: 'desc',
    header: 'Contract',
    hideBelow: 'lg',
    cell: (row) => <span className="text-meta text-muted">{row.description}</span>,
  },
]);

const ENV_VAR_COLUMNS = defineColumns<EnvSchemaVar>([
  {
    id: 'name',
    header: 'Variable',
    mono: true,
    cell: (row) => <span className="text-meta font-medium text-text">{row.name}</span>,
  },
  { id: 'type', header: 'Type', cell: (row) => <Tag mono>{row.type}</Tag> },
  {
    id: 'required',
    header: 'Required',
    cell: (row) =>
      row.required ? (
        <Badge tone="caution" size="sm">
          required
        </Badge>
      ) : (
        <span className="text-faint">optional</span>
      ),
  },
  {
    id: 'default',
    header: 'Default',
    hideBelow: 'md',
    cell: (row) =>
      row.secret ? (
        <span className="text-meta text-faint">stored as secret_ref</span>
      ) : (
        <span className="font-mono text-micro text-muted">{row.defaultValue ?? '—'}</span>
      ),
  },
  {
    id: 'options',
    header: 'Options',
    hideBelow: 'lg',
    cell: (row) =>
      row.options === undefined || row.options.length === 0 ? (
        <span className="text-faint">—</span>
      ) : (
        <span className="font-mono text-micro text-muted">{row.options.join(' · ')}</span>
      ),
  },
  {
    id: 'ceiling',
    header: 'Override ceiling',
    hideBelow: 'md',
    cell: (row) => (
      <Badge
        tone={
          row.overrideCeiling === 'none'
            ? 'danger'
            : row.overrideCeiling === 'profile_only'
              ? 'caution'
              : 'positive'
        }
        size="sm"
      >
        {OVERRIDE_CEILING_LABELS[row.overrideCeiling]}
      </Badge>
    ),
  },
  {
    id: 'purpose',
    header: 'Purpose',
    hideBelow: 'xl',
    cell: (row) => (
      <div className="max-w-md">
        <span className="text-meta leading-snug text-muted">{row.purpose}</span>
        {row.conditional ? (
          <span className="mt-0.5 block text-micro text-warning-strong">
            Condition: {row.conditional}
          </span>
        ) : null}
      </div>
    ),
  },
]);

const operationRowKey = (row: OperationRow) => row.id;
const envVarRowKey = (row: EnvSchemaVar) => row.name;

export function IntegrationTab({ entry }: { entry: CatalogEntry }) {
  const integration = entry.integration;
  const granularity = CREDENTIAL_GRANULARITY_LABELS[integration.credentialGranularity];

  return (
    <div className="space-y-3">
      {integration.stale ? (
        <Callout tone="caution" title="Metadata review is overdue">
          The registry returns this entry with a staleness flag. Verify authentication capability,
          API base URL and the operation inventory before workflows may target it.
        </Callout>
      ) : null}

      <Panel>
        {/* FR-2.14 — requirement id, developer-only; the panel header used to carry it as its
            eyebrow. */}
        <PanelHeader title="Verified integration facts" />
        <div className="p-4">
          <DefinitionList
            columns={2}
            items={[
              { label: 'API base URL', value: integration.apiBaseUrl, mono: true },
              { label: 'Authentication method', value: integration.authMethod },
              { label: 'Guarantee class (verified)', value: integration.guaranteeClassVerified },
              {
                label: 'Credential granularity',
                value: granularity.label,
                hint: granularity.description,
              },
              { label: 'Session maximum', value: `${integration.sessionMaxMinutes} minutes` },
              {
                label: 'Single logout',
                value: integration.sloSupported ? 'Supported' : 'Not supported',
              },
              { label: 'Verified by', value: integration.verifiedBy },
              { label: 'Verified at', value: formatDateTime(integration.verifiedAt) },
              { label: 'Next review', value: formatDateTime(integration.nextReviewAt) },
            ]}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow={`${integration.operationInventory.length} operations`}
          title="Operation inventory"
          description="Nodes the workflow builder may offer. Write operations require operation-scoped credentials."
        />
        {/* FR-2.14: the empty copy used to read "Verified metadata supersedes assumptions
            (FR-2.14). Until the inventory is recorded, …". */}
        <DataTable
          columns={OPERATION_COLUMNS}
          rows={integration.operationInventory}
          rowKey={operationRowKey}
          dense
          empty={
            <EmptyState
              title="No verified operations"
              description="Verified metadata supersedes assumptions. Until the inventory is recorded, the workflow builder cannot offer this product as a node."
            />
          }
        />
      </Panel>

      <Panel>
        <PanelHeader eyebrow="Triggers" title="Event and start modes" />
        <div className="flex flex-wrap gap-2 p-4">
          {integration.eventModes.map((event) => (
            <div
              key={`${event.mode}-${event.label}`}
              className="min-w-48 rounded-sm border border-line bg-panel-soft p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <Badge tone={event.mode === 'none' ? 'neutral' : 'accent'} size="sm">
                  {TRIGGER_LABELS[event.mode] ?? event.mode}
                </Badge>
                {event.minimumIntervalMinutes ? (
                  <span className="font-mono text-micro text-faint">
                    ≥ {event.minimumIntervalMinutes} min
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 text-meta text-text">{event.label}</p>
            </div>
          ))}
          {integration.eventModes.length === 0 ? (
            <InlineNote>
              This entry declares no event mechanism; workflows would fall back to polling.
            </InlineNote>
          ) : null}
        </div>
      </Panel>

      {/* The verdict, derived once from the recorded fact (C-11). `account` used to render nothing
          here while the credential broker refused it — the screen said one thing and the broker did
          another. */}
      {isWriteEligible(integration.credentialGranularity) ? null : (
        <Callout
          tone={integration.credentialGranularity === 'none' ? 'danger' : 'caution'}
          title="Write workflows are ineligible for this entry"
        >
          {writeIneligibilityReason(integration.credentialGranularity)}{' '}
          {isWorkflowEligible(integration.credentialGranularity)
            ? 'Workflows may still read from it.'
            : 'No workflow of any kind may target it, because there is no credential to broker.'}
        </Callout>
      )}
    </div>
  );
}

export function EnvTab({
  entryKey,
  query,
}: {
  entryKey: string;
  /**
   * The query itself, not a `loading`/`error`/`onRetry` triple: the three branches belong to
   * `AsyncPanel`, and handing it the query is what keeps the old data on screen when a refetch
   * fails (ERR-04).
   */
  query: AsyncQuery<EnvSchemaVar[]>;
}) {
  return (
    <Panel>
      {/* FR-1.24 — requirement id, developer-only; the panel header used to carry it as its
          eyebrow. */}
      <PanelHeader
        title="Declared environment schema"
        description="Validated before the container starts. Secrets are masked in the UI, job output, logs and audit records."
      />
      <AsyncPanel
        query={query}
        loading={
          <div className="p-4">
            <SkeletonLines lines={6} />
          </div>
        }
        loadingLabel="Loading the declared environment schema"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
      >
        {(vars) => {
          // F5: the declaration is a file, so say which one and which revision it came from. Without
          // this the screen shows *what* is declared and never *where*, and the operator has to
          // guess whether a reload has happened since the edit.
          const revision =
            vars.find(
              (variable) => typeof variable.revision === 'string' && variable.revision.length > 0,
            )?.revision ?? null;

          return (
            <>
              {vars.length > 0 ? (
                <div className="border-b border-line px-4 py-2">
                  <InlineNote>
                    Declared in <span className="font-mono">catalog/env/{entryKey}.json</span>
                    {revision === null
                      ? '· no repository revision recorded yet; reload to stamp one'
                      : ` · projected from revision ${revision.slice(0, 12)}`}
                  </InlineNote>
                </div>
              ) : null}
              <DataTable
                columns={ENV_VAR_COLUMNS}
                rows={vars}
                rowKey={envVarRowKey}
                dense
                empty={
                  <EmptyState
                    title="No declared variables"
                    description="This entry declares no variables in catalog/env, so nothing must be configured before its container starts."
                  />
                }
              />
            </>
          );
        }}
      </AsyncPanel>
    </Panel>
  );
}

export function ScaffoldTab({
  query,
  onConfirm,
  confirming,
  confirmError,
}: {
  query: AsyncQuery<ScaffoldDraft>;
  onConfirm: (draftId: string) => void;
  confirming: boolean;
  confirmError: unknown;
}) {
  return (
    <div className="space-y-3">
      {/* FR-1.17 (path 3) and FR-1.22: the callout used to read "Scaffolded source (FR-1.17
          path 3)" and "… before the entry becomes deployable (FR-1.22)." */}
      <Callout tone="info" title="Scaffolded source">
        No upstream Compose file or Dockerfile exists. The platform generates a reviewable draft;
        the operator confirms it before the entry becomes deployable.
      </Callout>

      <AsyncPanel
        query={query}
        loading={
          <Panel inset>
            <SkeletonLines lines={6} />
          </Panel>
        }
        loadingLabel="Loading the scaffold draft"
        renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
      >
        {(draft) => {
          const confirmed = draft.approvedBy !== null && draft.approvedBy !== undefined;

          return (
            <>
              <Panel>
                <PanelHeader
                  eyebrow={`Draft ${draft.draftId}`}
                  title="Generated artefacts"
                  description={
                    confirmed
                      ? `Approved by ${draft.approvedBy} · committed to the catalog repository`
                      : 'Pending operator review · nothing is committed until you confirm'
                  }
                  actions={
                    confirmed ? null : (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={confirming}
                        onClick={() => onConfirm(draft.draftId)}
                      >
                        {confirming ? 'Confirming…' : 'Confirm artefacts'}
                      </Button>
                    )
                  }
                />
                {confirmError ? (
                  <div className="p-4">
                    <QueryError error={confirmError} />
                  </div>
                ) : null}
                <div className="divide-y divide-line">
                  {draft.files.map((file) => (
                    <div key={file.path}>
                      <div className="flex items-center justify-between gap-2 bg-paper-deep px-3 py-1.5">
                        <span className="font-mono text-micro text-muted">{file.path}</span>
                        <Tag mono>{file.language}</Tag>
                      </div>
                      <pre className="scroll-slim log-surface max-h-72 overflow-auto overscroll-contain p-3">
                        {file.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel>
                <PanelHeader eyebrow="Policy" title="Validation diagnostics" />
                {draft.diagnostics.length === 0 ? (
                  <div className="px-4 py-3">
                    <InlineNote>
                      No diagnostics are recorded on the draft. Confirmation re-validates every
                      generated file against the compose policy before it is committed, so the
                      checks are shown here only when a draft carries its own results.
                    </InlineNote>
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {draft.diagnostics.map((check) => (
                      <li key={check.id} className="flex items-start gap-3 px-4 py-2.5">
                        <Badge
                          tone={
                            check.state === 'pass'
                              ? 'positive'
                              : check.state === 'warn'
                                ? 'caution'
                                : 'danger'
                          }
                          size="sm"
                        >
                          {check.state}
                        </Badge>
                        <div className="min-w-0">
                          <p className="text-meta font-medium text-text">{check.label}</p>
                          <p className="mt-0.5 text-meta leading-snug text-muted">{check.detail}</p>
                          {check.remediation ? (
                            <p className="mt-1 text-meta text-link">{check.remediation}</p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          );
        }}
      </AsyncPanel>
    </div>
  );
}
