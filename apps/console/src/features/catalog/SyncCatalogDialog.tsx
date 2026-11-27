import { useEffect, useRef, useState } from 'react';
import { toProblem } from '@seamnex/api-client';
import type { useSyncCatalog } from '@seamnex/api-client';
import type { CatalogRepositoryView } from '@seamnex/domain';
import { Button, Checkbox, Dialog, Field, Input } from '@seamnex/ui';

type SyncMutation = ReturnType<typeof useSyncCatalog>;

/**
 * ADR-BE-42 §10.4 — the console half of the fetch.
 *
 * Three deliberate choices:
 *
 *   - **The field is a ref, never a URL.** The source is deployment configuration, so this dialog
 *     cannot make the control plane reach a host an operator typed.
 *   - **Confirmation is explicit.** A sync reconciles the whole tree, so it can remove entries the
 *     tag no longer declares. That is not a one-click action.
 *   - **A refusal is reported as a refusal.** The code, the detail (which carries the git tail) and
 *     the remediation are shown; the page then reports separately whether the tree is mixed, because
 *     only `GET /catalog/repository` can answer that.
 */
export function SyncCatalogDialog({
  open,
  onOpenChange,
  repository,
  sync,
  onSynced,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: CatalogRepositoryView;
  sync: SyncMutation;
  /** The page owns the receipt, so it has to know which action produced the one on screen. */
  onSynced: () => void;
}) {
  const [ref, setRef] = useState(repository.source.ref ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const wasOpen = useRef(open);
  const problem = sync.error ? toProblem(sync.error) : null;

  /*
   * One attempt per opening. The dialog stays mounted between openings (the page owns `open`), so
   * without this a refusal from the previous attempt was still on screen the next time the dialog
   * appeared — reading as a fresh failure — and an acknowledgement given for that attempt carried
   * over, turning a write that may remove entries into a one-click action. The field is re-seeded
   * from the source's recorded ref for the same reason: the tree may have moved on since.
   */
  useEffect(() => {
    if (open && !wasOpen.current) {
      setRef(repository.source.ref ?? '');
      setAcknowledged(false);
      // Only a refusal is cleared: resetting unconditionally would also drop the successful
      // receipt the page is still showing, and would disturb a sync that is still in flight.
      if (sync.error) sync.reset();
    }
    wasOpen.current = open;
  }, [open, repository.source.ref, sync]);

  const trimmed = ref.trim();
  const ready = trimmed.length > 0 && acknowledged;
  // `host` never carries a scheme (ADR-BE-42 §10.3), and it is deployment configuration rather
  // than operator input, so prefixing `https://` here cannot point the browser anywhere new.
  const sourceHost = repository.source.host;
  const sourceUrl = sourceHost === null ? null : `https://${sourceHost}`;

  const submit = () => {
    if (!ready) return;
    sync.mutate(
      { ref: trimmed },
      {
        onSuccess: () => {
          setAcknowledged(false);
          onSynced();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sync the catalogue from its source"
      description="Fetch a tagged revision, swap it into the working tree and reconcile the projection in one step. A tag that no longer declares a product removes it."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready || sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Tag or commit"
          htmlFor="catalog-sync-ref"
          required
          hint={
            <>
              Source{' '}
              {sourceUrl === null ? (
                'not configured'
              ) : (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open ${sourceHost} in a new tab`}
                  className="font-medium"
                >
                  {sourceHost}
                </a>
              )}
              {'. Tags look like catalog-YYYY.MM.<patch>.'}
            </>
          }
        >
          <Input
            id="catalog-sync-ref"
            value={ref}
            autoComplete="off"
            maxLength={255}
            placeholder="catalog-2026.11.0"
            onChange={(event) => setRef(event.target.value)}
          />
        </Field>

        <div className="text-meta text-muted">
          {repository.commit === null ? (
            <span>No sync has been recorded for this tree.</span>
          ) : (
            <span>
              Last synced commit{' '}
              <span className="font-mono">{repository.commit.sha.slice(0, 12)}</span>, recorded{' '}
              {repository.commit.recordedAt.slice(0, 10)}.
            </span>
          )}
        </div>

        <Checkbox
          label="I understand a sync can remove entries"
          description="The tag is the catalogue: a product the tag does not declare is reconciled as removed unless an instance still holds it."
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />

        {problem === null ? null : (
          <div
            role="alert"
            className="rounded-sm border border-danger-border bg-danger-soft px-3.5 py-3"
          >
            <p className="text-body font-semibold text-danger-strong">{problem.title}</p>
            <p className="mt-1 text-body leading-snug text-muted">{problem.detail}</p>
            {problem.remediation === undefined ? null : (
              <p className="mt-1 text-meta leading-snug text-muted">{problem.remediation}</p>
            )}
            <p className="mt-2 text-meta leading-snug text-muted">
              Nothing is reported as changed unless the reload completed. If the swap stopped
              between renames this page shows a mixed-tree banner naming the repair.
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
