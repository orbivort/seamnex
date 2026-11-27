import { useMemo, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { useReplaceEnvProfileValues } from '@seamnex/api-client';
import type { EnvProfile } from '@seamnex/domain';
import { OVERRIDE_CEILING_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Field,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  Select,
  defineColumns,
} from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';
import {
  ceilingOf,
  ceilingTone,
  type Declarations,
  type ProfileValue,
} from './profile-declarations';

/**
 * The value table: one row per variable, with the fact an operator needs to explain a resolution.
 *
 * A `none` row is inert on purpose — the API refuses a profile value for it (AC-51), so the action
 * is absent rather than present-and-failing.
 */
export function ProfileValueTable({
  profile,
  declarations,
  canManage,
  onEdit,
  onRemove,
}: {
  profile: EnvProfile;
  declarations: Declarations;
  canManage: boolean;
  onEdit: (value: ProfileValue) => void;
  onRemove: (varName: string) => void;
}) {
  const columns = useMemo(
    () =>
      defineColumns<ProfileValue>([
        {
          id: 'variable',
          header: 'Variable',
          cell: (row) => {
            const declared = declarations.get(row.varName);
            const ceiling = ceilingOf(declared);
            // Three keys and a count: the base variables are declared by nearly every entry, and a
            // cell that lists twenty keys is a cell nobody reads.
            const keys = (declared ?? []).map((item) => item.entryKey);
            const shown = keys.slice(0, 3).join(', ');
            const rest = keys.length - Math.min(keys.length, 3);
            return (
              <div className="min-w-0">
                <span className="block font-mono text-meta font-medium text-text">
                  {row.varName}
                </span>
                <span className="block text-micro text-faint" title={keys.join(', ')}>
                  {declared === undefined
                    ? 'No entry declares this variable'
                    : `Declared by ${shown}${rest > 0 ? ` +${rest} more` : ''}`}
                </span>
                {ceiling === 'none' ? (
                  <span className="mt-0.5 block text-micro text-warning-strong">
                    Declared as not overridable; the API refuses this value.
                  </span>
                ) : null}
              </div>
            );
          },
        },
        {
          id: 'ceiling',
          header: 'Ceiling',
          hideBelow: 'md',
          cell: (row) => {
            const ceiling = ceilingOf(declarations.get(row.varName));
            return ceiling === null ? (
              <Badge tone="danger" size="sm">
                undeclared
              </Badge>
            ) : (
              <Badge tone={ceilingTone(ceiling)} size="sm">
                {OVERRIDE_CEILING_LABELS[ceiling]}
              </Badge>
            );
          },
        },
        {
          id: 'value',
          header: 'Resolved value',
          cell: (row) =>
            row.secretRef === null ? (
              <span className="font-mono text-micro text-text">{row.value ?? '—'}</span>
            ) : (
              <span className="font-mono text-micro text-muted">•••••••• · {row.secretRef}</span>
            ),
        },
        {
          id: 'actions',
          header: '',
          align: 'right',
          cell: (row) => {
            const locked = ceilingOf(declarations.get(row.varName)) === 'none';
            return (
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={!canManage || locked}
                  onClick={() => onEdit(row)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={!canManage}
                  onClick={() => onRemove(row.varName)}
                  aria-label={`Remove ${row.varName}`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            );
          },
        },
      ]),
    [declarations, canManage, onEdit, onRemove],
  );

  return (
    <DataTable
      columns={columns}
      rows={[...profile.values]}
      rowKey={(row) => row.varName}
      dense
      empty={
        <InlineNote>
          This profile sets no values. Every variable resolves from its catalog default.
        </InlineNote>
      }
    />
  );
}

/**
 * Add or change one value.
 *
 * The write replaces the profile's whole value list — that is what makes a removal expressible — so
 * the editor sends the existing rows plus (or minus) this one, and never a partial patch the server
 * would have to merge.
 */
export function ProfileValueEditor({
  profile,
  declarations,
  editing,
  canManage,
  onClose,
}: {
  profile: EnvProfile;
  declarations: Declarations;
  /** The row being changed, or `null` when adding a new variable. */
  editing: ProfileValue | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const replace = useReplaceEnvProfileValues();
  const candidates = useMemo(() => {
    const taken = new Set(profile.values.map((value) => value.varName));
    return [...declarations.entries()]
      .filter(([name]) => name === editing?.varName || !taken.has(name))
      .map(([name, declared]) => ({ name, declared }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [declarations, profile.values, editing]);

  const [varName, setVarName] = useState(editing?.varName ?? candidates[0]?.name ?? '');
  const [value, setValue] = useState(editing?.value ?? '');
  const [secretRef, setSecretRef] = useState(editing?.secretRef ?? '');

  const declared = declarations.get(varName) ?? [];
  const isSecret = declared.some((item) => item.secret);
  const ceiling = ceilingOf(declared);
  const locked = ceiling === 'none';
  const fieldErrors = replace.error
    ? ((replace.error as { fieldErrors?: { field: string; message: string }[] }).fieldErrors ?? [])
    : [];
  const errorFor = (field: string) => fieldErrors.find((issue) => issue.field === field)?.message;

  const save = () => {
    const next = profile.values.filter((row) => row.varName !== editing?.varName);
    next.push({
      varName,
      value: isSecret ? null : value,
      secretRef: isSecret ? secretRef : null,
    });
    replace.mutate({ key: profile.key, values: next }, { onSuccess: () => onClose() });
  };

  return (
    <Panel className="mt-3">
      <PanelHeader
        eyebrow={editing === null ? 'Add a value' : `Edit ${editing.varName}`}
        title="Profile value"
        description="The ceiling comes from the variable's declaration; a value above it is refused, not silently dropped."
      />
      <div className="space-y-3 p-4">
        {replace.isError ? <QueryError error={replace.error} compact /> : null}

        {/*
          The server's rejection names the variable, and the control the operator has to change is the
          value beside it — so the message is anchored there once, not repeated under the picker as a
          second alert a screen reader would read twice.
        */}
        <Field label="Variable" htmlFor="profile-value-name">
          <Select
            id="profile-value-name"
            value={varName}
            disabled={!canManage || editing !== null}
            onChange={(event) => {
              setVarName(event.target.value);
              setValue('');
              setSecretRef('');
            }}
          >
            {candidates.length === 0 ? (
              <option value="">No declared variable is available</option>
            ) : null}
            {candidates.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} ·{' '}
                {OVERRIDE_CEILING_LABELS[ceilingOf(candidate.declared) ?? 'none']}
              </option>
            ))}
          </Select>
        </Field>

        {locked ? (
          <Callout tone="danger" title="This variable cannot be set from a profile">
            Every entry that declares {varName} caps it at <span className="font-mono">none</span>.
            Change the declaration in the catalog, not the profile.
          </Callout>
        ) : isSecret ? (
          <Field
            label="Secret reference"
            htmlFor="profile-value-secret"
            hint="Name of a stored secret, e.g. secret://platform/smtp-relay. The value itself never leaves the secret store."
            error={errorFor(varName)}
          >
            <Input
              id="profile-value-secret"
              value={secretRef}
              disabled={!canManage}
              onChange={(event) => setSecretRef(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="Value" htmlFor="profile-value-plain" error={errorFor(varName)}>
            <Input
              id="profile-value-plain"
              value={value}
              disabled={!canManage}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Save />}
            disabled={!canManage || replace.isPending || varName === '' || locked}
            onClick={save}
          >
            {replace.isPending ? 'Saving…' : 'Save value'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
