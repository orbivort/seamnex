import { Plus, Trash2 } from 'lucide-react';
import type { usePatchEnvProfile } from '@seamnex/api-client';
import type { EnvProfile } from '@seamnex/domain';
import { Button, Panel, PanelHeader, Select } from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { QueryError } from '@seamnex/shell';
import type { Declarations, ProfileValue } from './profile-declarations';
import { ProfileValueTable } from './profile-values';

/** One profile: its target, its values, and the delete that may be refused. */
export function SelectedProfile({
  profile,
  declarations,
  canManage,
  patch,
  onEdit,
  onRemoveValue,
  onDelete,
  removeError,
}: {
  profile: EnvProfile;
  declarations: Declarations;
  canManage: boolean;
  patch: ReturnType<typeof usePatchEnvProfile>;
  onEdit: (value: ProfileValue | null) => void;
  onRemoveValue: (varName: string) => void;
  onDelete: () => void;
  removeError: unknown;
}) {
  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader
          eyebrow={`Profile · ${profile.key}`}
          title={profile.name}
          description={`Changed by ${profile.updatedBy} ${formatRelative(profile.updatedAt)}.`}
          actions={
            <div className="flex items-center gap-2">
              <Select
                aria-label="Lifecycle target"
                value={profile.target}
                disabled={!canManage || patch.isPending}
                onChange={(event) =>
                  patch.mutate({
                    key: profile.key,
                    target: event.target.value as 'production' | 'staging',
                  })
                }
              >
                <option value="production">production</option>
                <option value="staging">staging</option>
              </Select>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus />}
                disabled={!canManage}
                onClick={() => onEdit(null)}
              >
                Add value
              </Button>
            </div>
          }
        />
        {patch.isError ? (
          <div className="px-4 pt-3">
            <QueryError error={patch.error} compact />
          </div>
        ) : null}
        <div className="mt-2">
          <ProfileValueTable
            profile={profile}
            declarations={declarations}
            canManage={canManage}
            onEdit={(value) => onEdit(value)}
            onRemove={onRemoveValue}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow="Danger zone"
          title="Delete this profile"
          description="Refused while an instance records it as its profile; the refusal names them."
        />
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <p className="max-w-prose text-meta text-muted">
            A profile that no instance uses can be removed. The key is not reusable for a different
            set of values: create a new profile instead of repurposing an old one.
          </p>
          <Button
            variant="danger"
            icon={<Trash2 />}
            disabled={!canManage}
            onClick={onDelete}
            title={canManage ? undefined : 'Your role may not delete profiles.'}
          >
            Delete profile
          </Button>
        </div>
        {removeError ? (
          <div className="px-4 pb-4">
            <QueryError error={removeError} compact />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
