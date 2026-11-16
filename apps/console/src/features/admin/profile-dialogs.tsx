import { useState } from 'react';
import { useCreateEnvProfile, useRequestProfileChange } from '@seamnex/api-client';
import { Dialog, Field, Input, Select, Textarea } from '@seamnex/ui';
import { Button } from '@seamnex/ui';
import { QueryError } from '@seamnex/shell';

/** A new profile. The key is what an instance pins to, so it is validated before the round trip. */
export function CreateProfileDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const create = useCreateEnvProfile();
  const [draft, setDraft] = useState<{
    key: string;
    name: string;
    target: 'production' | 'staging';
  }>({ key: '', name: '', target: 'production' });

  // Every way out of this dialog drops the draft: a cancelled key must not reappear as a proposal.
  // Escape and the overlay reach it through `onOpenChange`, the footer through the same function.
  const close = (next = false) => {
    setDraft({ key: '', name: '', target: 'production' });
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New environment profile"
      description="The key is what an instance pins to, so it is immutable once used."
      footer={
        <>
          <Button variant="ghost" onClick={() => close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={create.isPending || draft.key === '' || draft.name === ''}
            onClick={() =>
              create.mutate(draft, {
                onSuccess: (created) => {
                  onOpenChange(false);
                  onCreated(created.key);
                },
              })
            }
          >
            {create.isPending ? 'Creating…' : 'Create profile'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {create.isError ? <QueryError error={create.error} compact /> : null}
        <Field
          label="Key"
          htmlFor="profile-key"
          required
          hint="2–32 characters: a lowercase letter, then lowercase letters, digits, dashes or underscores."
        >
          <Input
            id="profile-key"
            value={draft.key}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
        </Field>
        <Field label="Name" htmlFor="profile-name" required>
          <Input
            id="profile-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label="Target" htmlFor="profile-target">
          <Select
            id="profile-target"
            value={draft.target}
            onChange={(event) =>
              setDraft({ ...draft, target: event.target.value as 'production' | 'staging' })
            }
          >
            <option value="production">production</option>
            <option value="staging">staging</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * FR-1.26: the request path for a role that may read profiles but not write them.
 *
 * Filing the request is what makes the disabled action honest — a domain owner's refusal is then a
 * recorded decision in the governance queue rather than a control that does nothing.
 */
export function ProfileChangeRequestDialog({
  open,
  onOpenChange,
  profileKey,
  profileName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileKey: string;
  profileName: string;
}) {
  const requestChange = useRequestProfileChange();
  const [justification, setJustification] = useState('');

  // One exit for every path (footer, Escape, overlay): an abandoned justification is not a draft.
  const close = (next = false) => {
    setJustification('');
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Request a change to ${profileName}`}
      description="R1 decides the request; the justification is what they read. It is recorded in the audit trail either way."
      footer={
        <>
          <Button variant="ghost" onClick={() => close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={requestChange.isPending || justification.trim().length === 0}
            onClick={() =>
              requestChange.mutate(
                { key: profileKey, justification: justification.trim() },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            {requestChange.isPending ? 'Filing…' : 'File request'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {requestChange.isError ? <QueryError error={requestChange.error} compact /> : null}
        <Field
          label="What should change, and why"
          htmlFor="profile-request-justification"
          hint="Name the variable and the value you need; a request without a reason cannot be decided."
        >
          <Textarea
            id="profile-request-justification"
            rows={4}
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
