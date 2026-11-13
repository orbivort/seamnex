import { useCallback, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useGroups, useUpdateGroupMapping } from '@seamnex/api-client';
import type { IdpGroup } from '@seamnex/domain';
import { PLATFORM_ROLES, ROLE_LABELS } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  Tag,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/** Hoisted: `DataTable` does not compare props, so identity stability is the call site's job. */
const rowKey = (row: IdpGroup): string => row.id;

export function GroupsPage() {
  const groups = useGroups();
  const update = useUpdateGroupMapping();
  const [editing, setEditing] = useState<IdpGroup | null>(null);
  const [role, setRole] = useState('R5');
  const [scopeType, setScopeType] = useState('platform');
  const [scopeLabel, setScopeLabel] = useState('Platform');
  const [propagate, setPropagate] = useState(false);

  /**
   * Stable, because the column array below closes over it. Every setter it touches is stable on its
   * own, so the identity only has to be created once per mount.
   */
  const openEditor = useCallback((group: IdpGroup) => {
    setEditing(group);
    setRole(group.mapping?.role ?? 'R5');
    setScopeType(group.mapping?.scopeType ?? 'platform');
    setScopeLabel(group.mapping?.scopeLabel ?? 'Platform');
    setPropagate(group.mapping?.propagateToProduct ?? false);
  }, []);

  /**
   * Memoised rather than hoisted: the last column opens an editor, so the array closes over
   * `openEditor`. With that callback stable, the memo actually holds — which is what ARCH-04 asks
   * for and what the old `useMemo(…, [openEditor])` could not deliver.
   */
  const columns = useMemo(
    () =>
      defineColumns<IdpGroup>([
        {
          id: 'group',
          header: 'Group',
          cell: (row) => (
            <div className="min-w-0">
              <span className="block font-mono text-meta font-medium text-text">{row.path}</span>
              <span className="block text-micro text-faint">{row.description}</span>
            </div>
          ),
        },
        {
          id: 'members',
          header: 'Members',
          align: 'right',
          mono: true,
          cell: (row) => row.memberCount,
        },
        {
          id: 'mapping',
          header: 'Durable mapping',
          hideBelow: 'md',
          cell: (row) =>
            row.mapping ? (
              <div className="flex flex-wrap gap-1">
                <Badge tone="accent" size="sm">
                  {row.mapping.role}
                </Badge>
                <Badge tone="neutral" size="sm">
                  {row.mapping.scopeType}
                </Badge>
                {row.mapping.propagateToProduct ? (
                  <Badge tone="caution" size="sm">
                    propagates
                  </Badge>
                ) : null}
              </div>
            ) : (
              <span className="text-micro text-warning-strong">unmapped</span>
            ),
        },
        {
          id: 'scope',
          header: 'Scope',
          hideBelow: 'lg',
          cell: (row) => (
            <span className="text-micro text-muted">{row.mapping?.scopeLabel ?? '—'}</span>
          ),
        },
        {
          id: 'updated',
          header: 'Updated',
          hideBelow: 'xl',
          cell: (row) => (
            <span className="text-micro text-faint">{formatRelative(row.updatedAt)}</span>
          ),
        },
        {
          // No row link: a group has no detail route, and the editor is a drawer rather than an
          // href. This button stays the row's keyboard path, so the row itself stays inert.
          id: 'edit',
          header: '',
          align: 'right',
          cell: (row) => (
            <Button size="sm" variant="quiet" onClick={() => openEditor(row)}>
              Edit mapping
            </Button>
          ),
        },
      ]),
    [openEditor],
  );

  return (
    <Page>
      {/* FR-2.4 — requirement id, developer-only; it used to be the page eyebrow and is not part
          of the rendered interface. */}
      <PageHeader
        title="Groups and role mappings"
        description="Directory groups map to platform roles and product propagation. Mapping rows are durable: the sync loop never rewrites them."
        meta={<Tag mono>p95 propagation target ≤ 5 min</Tag>}
      />

      {/* FR-2.4: mapping authority is durable. The body used to read "… can never clobber FR-2.4
          authority." */}
      <Callout tone="info" title="One source of truth">
        Sync writes users and groups only. Mapping changes happen exclusively through an audited
        administrator action, so a directory refresh can never clobber the mapping authority.
      </Callout>

      <Panel className="mt-3">
        <PanelHeader
          eyebrow="Groups"
          title="Directory groups"
          description="Each group carries at most one durable platform mapping."
        />
        {/*
          The empty copy stays a panel branch, not `DataTable`'s `empty` prop: it carries a refresh
          action, and a directory that mirrored nothing is a statement about the sync, not about a
          filtered table. `AsyncPanel` owns the three states around it (ARCH-03).
        */}
        <AsyncPanel
          query={groups}
          loading={
            <div className="p-4">
              <SkeletonLines lines={6} />
            </div>
          }
          loadingLabel="Loading directory groups"
          empty={(data) =>
            data.length === 0 && (
              <div className="p-4">
                <EmptyState
                  title="No directory groups"
                  description="Groups are mirrored from the identity provider. Run a sync cycle to pull the directory."
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void groups.refetch()}>
                      Refresh groups
                    </Button>
                  }
                />
              </div>
            )
          }
        >
          {(data) => <DataTable columns={columns} rows={data} rowKey={rowKey} dense />}
        </AsyncPanel>
      </Panel>

      <Drawer
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        title={editing ? `Mapping · ${editing.displayName}` : 'Mapping'}
        description="Changing a mapping is an audited administrator action; it propagates to products on the next sync cycle."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Save />}
              disabled={update.isPending || !editing}
              onClick={() => {
                if (!editing) return;
                update.mutate(
                  { id: editing.id, body: { role, scopeType, scopeLabel, propagate } },
                  { onSuccess: () => setEditing(null) },
                );
              }}
            >
              Save mapping
            </Button>
          </>
        }
      >
        {update.isError ? <QueryError error={update.error} compact /> : null}
        <div className="space-y-4">
          <Field label="Platform role" htmlFor="mapping-role">
            <Select
              id="mapping-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {PLATFORM_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option} · {ROLE_LABELS[option].name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope type" htmlFor="mapping-scope">
            <Select
              id="mapping-scope"
              value={scopeType}
              onChange={(event) => setScopeType(event.target.value)}
            >
              <option value="platform">Platform</option>
              <option value="domain">Domain</option>
              <option value="instance">Instance</option>
            </Select>
          </Field>
          <Field
            label="Scope label"
            htmlFor="mapping-label"
            hint="Human-readable target, e.g. Revenue & Customer or D03-01 Zammad."
          >
            <Input
              id="mapping-label"
              value={scopeLabel}
              onChange={(event) => setScopeLabel(event.target.value)}
            />
          </Field>
          <Checkbox
            id="mapping-propagate"
            label="Propagate the role into the product"
            description="The platform applies the mapped product role at deployment and on membership change."
            checked={propagate}
            onChange={(event) => setPropagate(event.target.checked)}
          />
          <Alert tone="caution" title="R1 cannot self-approve product authority">
            Standing authority covers the platform only. Access to business-product data is
            break-glass and time-boxed.
          </Alert>
        </div>
      </Drawer>
    </Page>
  );
}
