import type { NodeFields } from '@seamnex/domain';
import { Badge, Button, InlineNote } from '@seamnex/ui';

/**
 * What the right pane says about the target, once the ledger is filled.
 *
 * Three facts, in the order an author needs them: is this list trustworthy, are the product's
 * required fields covered, and what exactly will be sent. The preview is the answer to "did I map
 * the right thing?" that the old editor never gave — it showed names, never the resulting body.
 */
export function TargetCoverage({
  fields,
  fieldsError,
  loading,
  refreshing,
  onRefresh,
  required,
  covered,
  missing,
  preview,
  mapped,
}: {
  fields: NodeFields | undefined;
  fieldsError: string | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  required: number;
  covered: number;
  missing: readonly string[];
  preview: string;
  mapped: number;
}) {
  /*
   * `null` means "still reading". Without the explicit `loading` the unbound node — whose query is
   * disabled and will never answer — rendered "reading schema…" for as long as the drawer stayed
   * open, which is the one thing this panel must not do: claim work that is not happening.
   */
  const status =
    fields?.status ?? (fieldsError !== null ? 'unavailable' : loading ? null : 'unavailable');
  const detail =
    fields?.detail ??
    fieldsError ??
    (loading ? null : 'Bind an operation to this node before its fields can be read.');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-faint label-caps">Target fields</p>
        <div className="flex items-center gap-1.5">
          {status === 'available' ? (
            <Badge tone="positive" size="sm">
              schema read
            </Badge>
          ) : status === null ? (
            <Badge tone="neutral" size="sm">
              reading schema…
            </Badge>
          ) : (
            <Badge tone="caution" size="sm">
              manual entry
            </Badge>
          )}
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {status === 'available' ? (
        <p className="text-micro text-muted">
          {required === 0
            ? `${mapped} field${mapped === 1 ? '' : 's'} mapped. This operation marks no field as required.`
            : `${covered} of ${required} required fields mapped${missing.length === 0 ? '' : ` — still missing: ${missing.join(', ')}`}.`}
        </p>
      ) : status === null ? null : (
        <InlineNote>
          {detail ??
            'The product did not publish a field list, so target names are not checked. Manual entry still works.'}
        </InlineNote>
      )}

      <details className="rounded-xs border border-line bg-panel-soft" open={mapped > 0}>
        <summary className="cursor-pointer px-2 py-1.5 font-mono text-micro text-muted label-caps">
          Request body preview
        </summary>
        <pre className="scroll-slim max-h-40 overflow-auto px-2 pb-2 font-mono text-micro leading-relaxed text-text">
          {mapped === 0 ? '{}' : preview}
        </pre>
      </details>
    </div>
  );
}
