import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import {
  useCatalog,
  useDeleteEnvProfile,
  useEnvProfiles,
  useEnvSchemas,
  useInstances,
  usePatchEnvProfile,
  useReplaceEnvProfileValues,
} from '@seamnex/api-client';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  Tag,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useCapabilities } from '../../use-capabilities';
import { declarationsOf, type ProfileValue } from './profile-declarations';
import { CreateProfileDialog, ProfileChangeRequestDialog } from './profile-dialogs';
import { SelectedProfile } from './profile-panel';
import { ProfileValueEditor } from './profile-values';

/**
 * FR-1.26 / AC-51 — the environment profiles R1 owns.
 *
 * A profile is not a settings bag: it is a named lifecycle value set an instance pins itself to, and
 * each value is subject to the ceiling the variable's declaration imposes. The screen answers three
 * questions the deploy wizard cannot — which variables a profile may set, which entries declare each
 * one, and what happens if the profile is deleted while an instance still uses it.
 */
export function EnvironmentProfilesPage() {
  const profiles = useEnvProfiles();
  const catalog = useCatalog();
  const { held, mutable } = useCapabilities();
  const canManage = mutable.has('profile.manage');
  const canRequest = held.has('profile.request');

  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('profile') ?? profiles.data?.[0]?.key ?? '';
  const selected = (profiles.data ?? []).find((profile) => profile.key === selectedKey) ?? null;

  const keys = useMemo(() => (catalog.data ?? []).map((entry) => entry.key), [catalog.data]);
  const schemas = useEnvSchemas(keys);
  // Derived on every render on purpose: the union is a few hundred entries, and memoising it would
  // need a dependency array built from the answers it is derived from.
  const declarations = declarationsOf(
    keys,
    schemas.map((query) => query.data),
  );

  const [editing, setEditing] = useState<{ value: ProfileValue | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = usePatchEnvProfile();
  const remove = useDeleteEnvProfile();
  const replaceValues = useReplaceEnvProfileValues();
  const usedBy = useInstances({}, { enabled: confirmDelete && selected !== null });
  const users = selected
    ? (usedBy.data ?? []).filter((instance) => instance.profileKey === selected.key)
    : [];

  const select = (key: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('profile', key);
      return next;
    });
    setEditing(null);
  };

  /**
   * Removing a value is a value write, not a profile delete: the endpoint replaces the whole list,
   * so the removal is expressible without a fifth operation.
   */
  const removeValue = (varName: string) => {
    if (selected === null) return;
    replaceValues.mutate({
      key: selected.key,
      values: selected.values
        .filter((row) => row.varName !== varName)
        .map((row) => ({ varName: row.varName, value: row.value, secretRef: row.secretRef })),
    });
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Environment profiles"
        description="Named, reusable overridable sets of values scoped to a deployment target. Precedence is catalog default → profile → instance override → secret store, and the declaration's ceiling decides which of those may set a variable."
        meta={
          <>
            <Tag mono>{profiles.data?.length ?? 0} profiles</Tag>
            {canManage ? null : (
              <Badge tone="caution" size="sm">
                read-only for your role
              </Badge>
            )}
          </>
        }
        actions={
          <Button
            variant="primary"
            icon={<Plus />}
            disabled={!canManage}
            title={
              canManage
                ? 'Create a profile'
                : 'Your role may not write profiles; file a change request instead.'
            }
            onClick={() => setCreating(true)}
          >
            New profile
          </Button>
        }
      />

      {canManage ? null : (
        <Callout tone="info" title="Profiles are an administrator surface">
          {canRequest
            ? 'Your role may read profiles and file a change request; R1 decides it in the governance queue.'
            : 'Reading a profile requires catalog access; writing one requires the profile-management right (R1).'}
          {canRequest ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={selected === null}
                onClick={() => setRequestOpen(true)}
              >
                Request a profile change
              </Button>
            </div>
          ) : null}
        </Callout>
      )}

      <AsyncPanel
        query={profiles}
        loading={
          <div className="p-4">
            <SkeletonLines lines={6} />
          </div>
        }
        loadingLabel="Loading environment profiles"
        empty={(data) =>
          data.length === 0 && (
            <div className="p-4">
              <EmptyState
                title="No environment profile"
                description="Nothing can be deployed until at least one profile exists: the environment has no middle layer between the catalog defaults and the instance."
                action={
                  canManage ? (
                    <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                      Create the first profile
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )
        }
      >
        {(data) => (
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
            <Panel>
              <PanelHeader eyebrow="Profiles" title="Lifecycle value sets" />
              <ul className="divide-y divide-line">
                {data.map((profile) => {
                  const active = profile.key === selectedKey;
                  return (
                    <li key={profile.key}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => select(profile.key)}
                        className={`flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors ${
                          active ? 'bg-primary-soft/60' : 'hover:bg-panel-soft'
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-body font-semibold text-text">{profile.name}</span>
                          <Badge
                            tone={profile.target === 'production' ? 'accent' : 'neutral'}
                            size="sm"
                          >
                            {profile.target}
                          </Badge>
                        </span>
                        <span className="font-mono text-micro text-faint">{profile.key}</span>
                        <span className="text-micro text-muted">
                          {profile.values.length} value(s) · {profile.updatedBy} ·{' '}
                          {formatRelative(profile.updatedAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            {selected === null ? (
              <Panel inset>
                <EmptyState
                  title="Select a profile"
                  description="Profiles are listed on the left; the values, ceilings and the entries that declare each variable appear here."
                />
              </Panel>
            ) : (
              <SelectedProfile
                profile={selected}
                declarations={declarations}
                canManage={canManage}
                patch={patch}
                onEdit={(value) => setEditing({ value })}
                onRemoveValue={removeValue}
                onDelete={() => setConfirmDelete(true)}
                removeError={
                  remove.isError ? remove.error : replaceValues.isError ? replaceValues.error : null
                }
              />
            )}
          </div>
        )}
      </AsyncPanel>

      {selected !== null && editing !== null ? (
        <ProfileValueEditor
          profile={selected}
          declarations={declarations}
          editing={editing.value}
          canManage={canManage}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <CreateProfileDialog open={creating} onOpenChange={setCreating} onCreated={select} />

      {selected === null ? null : (
        <ProfileChangeRequestDialog
          open={requestOpen}
          onOpenChange={setRequestOpen}
          profileKey={selected.key}
          profileName={selected.name}
        />
      )}

      {selected === null ? null : (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${selected.name}?`}
          description={
            users.length > 0
              ? `${users.length} instance(s) still deploy with ${selected.key}: ${users
                  .map((instance) => instance.slug)
                  .join(', ')}. The API refuses this delete until they move to another profile.`
              : `No instance records ${selected.key} as its profile. The delete is permanent and is audited.`
          }
          confirmLabel="Delete profile"
          requireText={selected.key}
          consequence={
            <Callout tone="danger" title="The values are removed with the profile">
              Every variable that only this profile supplied falls back to its catalog default on
              the next resolution.
            </Callout>
          }
          busy={remove.isPending}
          onConfirm={() =>
            remove.mutate(selected.key, {
              onSuccess: () => {
                setConfirmDelete(false);
                setEditing(null);
              },
            })
          }
        />
      )}

      {remove.isError ? (
        <div className="mt-3">
          <QueryError error={remove.error} compact />
        </div>
      ) : null}
    </Page>
  );
}
