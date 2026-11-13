import { useCallback, useMemo, useState } from 'react';
import { useInstanceEnv, useUpdateEnvironment } from '@seamnex/api-client';
import type { EnvValue, InstanceDetail } from '@seamnex/domain';
import { ENV_SOURCE_LABELS, OVERRIDE_CEILING_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Drawer,
  EmptyState,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  SkeletonLines,
  Tag,
  defineColumns,
  type Column,
} from '@seamnex/ui';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { AdminCredentialPanel } from './AdminCredentialPanel';
import { rawValue } from '../rawValue';

type EnvDraft = { name: string; original: string; value: string };

/**
 * A Radix tab panel unmounts when another tab is selected (PERF-08), and this panel owns the only
 * text input on the instance screen: a half-typed override used to disappear with no warning on an
 * accidental tab switch. The draft therefore lives outside the component tree — keyed per instance,
 * so two open instances never share one — and is cleared the moment it is saved or discarded. It is
 * not React state because the component that would hold it is exactly the one that is gone while
 * the tab is inactive.
 */
const drafts = new Map<string, EnvDraft>();

/**
 * Only the variable name, the source and the ceiling are row-derived; the "Change" affordance is
 * appended per render because it closes over the panel's draft setter (see the `useMemo` below).
 */
const envColumns = defineColumns<EnvValue>([
  {
    id: 'name',
    header: 'Variable',
    mono: true,
    cell: (row) => (
      <span className="flex items-center gap-1.5 text-meta font-medium text-text">
        {row.name}
        {row.drift ? (
          <Badge tone="caution" size="sm">
            drift
          </Badge>
        ) : null}
      </span>
    ),
  },
  {
    id: 'value',
    header: 'Resolved value',
    cell: (row) => (
      <span className="font-mono text-micro text-muted">
        {row.masked ? '••••••••' : (row.value ?? '—')}
      </span>
    ),
  },
  {
    id: 'source',
    header: 'Source',
    hideBelow: 'md',
    cell: (row) => <Tag>{ENV_SOURCE_LABELS[row.source]}</Tag>,
  },
  {
    id: 'ceiling',
    header: 'Ceiling',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="text-micro text-faint">{OVERRIDE_CEILING_LABELS[row.overrideCeiling]}</span>
    ),
  },
  {
    id: 'apply',
    header: 'Apply',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="text-micro text-faint">{row.requiresRecreate ? 'recreate' : 'restart'}</span>
    ),
  },
]);

const envRowKey = (row: EnvValue) => row.name;

export function EnvironmentTab({
  instance,
  canEdit,
}: {
  instance: InstanceDetail;
  canEdit: boolean;
}) {
  const env = useInstanceEnv(instance.id);
  const update = useUpdateEnvironment(instance.id);
  const [draft, setDraftState] = useState<EnvDraft | null>(() => drafts.get(instance.id) ?? null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /**
   * Stable per instance, because the columns array closes over it: `setDraft` is the only handler
   * this panel hands to a memoised column list, so it is a `useCallback` rather than a plain closure.
   * The write-through keeps the module-scope draft above in step with the component's copy.
   */
  const setDraft = useCallback(
    (next: EnvDraft | null) => {
      setDraftState(next);
      if (next === null) drafts.delete(instance.id);
      else drafts.set(instance.id, next);
    },
    [instance.id],
  );

  const dirty = draft !== null && draft.value !== draft.original;
  /**
   * Every dismissal path — the close control, Escape and a click on the overlay — runs through here.
   * The footer turns into the confirmation instead of a second dialog: stacking a `ConfirmDialog`
   * on top of this drawer would double the overlay and move focus twice for one decision.
   */
  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    setDraft(null);
  };

  // R2: the last column needs this panel's draft setter, so the array is memoised here rather than
  // hoisted — a stale closure that edits the wrong variable would be worse than a new identity.
  const columns = useMemo<Column<EnvValue>[]>(
    () => [
      ...envColumns,
      {
        id: 'edit',
        header: '',
        align: 'right',
        cell: (row) =>
          canEdit && row.overrideCeiling === 'profile_and_instance' ? (
            <Button
              size="sm"
              variant="quiet"
              onClick={() =>
                setDraft({
                  name: row.name,
                  original: rawValue(row.value, row.masked),
                  value: rawValue(row.value, row.masked),
                })
              }
            >
              Change
            </Button>
          ) : (
            <span className="text-micro text-faint">
              {row.overrideCeiling === 'none' ? 'locked' : 'read-only'}
            </span>
          ),
      },
    ],
    [canEdit, setDraft],
  );

  return (
    <div className="space-y-3">
      <Panel>
        {/* FR-1.24 – FR-1.28 — requirement ids, developer-only; they used to be the panel
            eyebrow. */}
        <PanelHeader
          title="Resolved environment"
          description="Projection of default → profile → instance → secret store. Secrets never re-display after entry."
        />
        <AsyncPanel
          query={env}
          loading={
            <div className="p-4">
              <SkeletonLines lines={6} />
            </div>
          }
          loadingLabel="Loading the resolved environment"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
          // The empty copy belongs to the region, not to `DataTable`: this panel renders its own
          // block instead of a table header when there is nothing to resolve.
          empty={(rows) =>
            rows.length === 0 && (
              <div className="p-4">
                <EmptyState
                  title="This entry declares no variables"
                  description="Nothing has to be resolved before the container starts. Add a variable to the catalog environment schema when the product needs configuration."
                />
              </div>
            )
          }
        >
          {(rows) => <DataTable columns={columns} rows={rows} rowKey={envRowKey} dense />}
        </AsyncPanel>
      </Panel>

      {/* ADR-BE-22: the token is not an environment variable, but it lives in the same store under
          the same capability — and this is the screen an operator opens to unblock a product. */}
      <AdminCredentialPanel instance={instance} canEdit={canEdit} />

      {update.isError ? <QueryError error={update.error} compact /> : null}
      {update.data ? (
        <Callout
          tone={update.data.requiresRecreate ? 'caution' : 'info'}
          title={update.data.requiresRecreate ? 'Recreate required' : 'Restart required'}
        >
          {update.data.note} {update.data.diff.length} variable(s) changed.
        </Callout>
      ) : null}

      <Drawer
        open={draft !== null}
        onOpenChange={(open) => (open ? undefined : requestClose())}
        title={`Change ${draft?.name ?? ''}`}
        description="An instance override is validated against the declared ceiling before it is rendered."
        footer={
          confirmDiscard ? (
            <>
              <span className="mr-auto text-meta text-muted">
                Discard the unapplied value for {draft?.name}?
              </span>
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  setDraft(null);
                }}
              >
                Discard
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={requestClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={update.isPending}
                onClick={() => {
                  if (!draft) return;
                  update.mutate({ [draft.name]: draft.value });
                  setConfirmDiscard(false);
                  setDraft(null);
                }}
              >
                Save and render diff
              </Button>
            </>
          )
        }
      >
        <div className="space-y-3">
          <label htmlFor="env-value" className="block text-meta font-medium text-muted">
            New value
          </label>
          <Input
            id="env-value"
            value={draft?.value ?? ''}
            onChange={(event) => {
              // Guarded rather than derived: the drawer only mounts while a draft exists, and a
              // conditional keeps the write from resurrecting one that was just discarded.
              if (draft) setDraft({ ...draft, value: event.target.value });
            }}
            autoComplete="off"
          />
          <InlineNote>
            The render diff is shown before apply. Secrets are masked and recorded only as a secret
            reference.
          </InlineNote>
        </div>
      </Drawer>
    </div>
  );
}
