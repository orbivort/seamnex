import { useState } from 'react';
import { useRequestableProducts, useRequestAccess } from '@seamnex/api-client';
import { can, GUARANTEE_CLASS_LABELS } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Select,
  SkeletonLines,
  Textarea,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { QueryError } from '@seamnex/shell';
import { useSession } from '../../session';

/**
 * FR-3.13: an end user asks for a product they do not hold yet. Unentitled products stay
 * absent from the launcher (FR-3.5), so the request surface lists them explicitly and the
 * request lands in the same queue a second party decides in the console.
 */
export function RequestAccessButton() {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [entryKey, setEntryKey] = useState('');
  const [justification, setJustification] = useState('');
  const requestable = useRequestableProducts(open);
  const request = useRequestAccess();

  if (!can(session.role, 'access.request')) return null;

  const products = requestable.data ?? [];
  const selectable = products.filter((product) => !product.requested);

  const close = () => {
    setOpen(false);
    setEntryKey('');
    setJustification('');
    request.reset();
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Request access
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title="Request access"
        description="The request goes to the domain owner of the product. Approval adds you to the directory group, and the platform grants the product role within one sync cycle."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              {request.data ? 'Close' : 'Cancel'}
            </Button>
            {request.data ? null : (
              <Button
                variant="primary"
                disabled={request.isPending || entryKey === '' || justification.trim().length < 10}
                onClick={() => request.mutate({ entryKey, justification: justification.trim() })}
              >
                {request.isPending ? 'Sending…' : 'Send request'}
              </Button>
            )}
          </>
        }
      >
        {request.data ? (
          <Alert tone="positive" title={`Request ${request.data.id} is open`}>
            {request.data.target}.{' '}
            {request.data.decidedBy === null ? 'Awaiting a decision from the domain owner.' : ''}{' '}
            The request is in the audit trail with your justification.
          </Alert>
        ) : (
          <div className="space-y-3">
            {request.isError ? <QueryError error={request.error} compact /> : null}

            {requestable.isPending ? <SkeletonLines lines={4} /> : null}
            {requestable.isError ? (
              <QueryError error={requestable.error} onRetry={() => void requestable.refetch()} />
            ) : null}

            {requestable.isSuccess && selectable.length === 0 ? (
              <EmptyState
                title="Nothing left to request"
                description="Either every product is already entitled to you, or a request is already open. A decision arrives within one sync cycle of approval."
              />
            ) : null}

            {selectable.length > 0 ? (
              <Field
                label="Product"
                required
                htmlFor="request-product"
                hint="Only products your role may request are listed. Availability is not affected by requesting."
              >
                <Select
                  id="request-product"
                  value={entryKey}
                  onChange={(event) => setEntryKey(event.target.value)}
                >
                  <option value="">Choose a product…</option>
                  {selectable.map((product) => (
                    <option key={product.entryKey} value={product.entryKey}>
                      {product.entryKey} · {product.product} — {product.domain}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {entryKey === '' ? null : (
              <div className="rounded-sm border border-line bg-panel-soft p-3">
                {products
                  .filter((product) => product.entryKey === entryKey)
                  .map((product) => (
                    <div key={product.entryKey} className="space-y-1">
                      <p className="text-body text-text">{product.description}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={GUARANTEE_CLASS_LABELS[product.guaranteeClass].tone} size="sm">
                          {GUARANTEE_CLASS_LABELS[product.guaranteeClass].label}
                        </Badge>
                        <Badge tone="neutral" size="sm">
                          role: {product.productRole}
                        </Badge>
                        <span className="text-micro text-faint">owner {product.owner}</span>
                        {product.requested && product.requestedAt !== null ? (
                          <span className="text-micro text-warning-strong">
                            requested {formatRelative(product.requestedAt)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
              </div>
            )}

            <Field
              label="Justification"
              required
              htmlFor="request-justification"
              hint="The domain owner decides on this text, and it is retained in the audit record."
              error={
                justification.length > 0 && justification.trim().length < 10
                  ? 'Use at least 10 characters.'
                  : undefined
              }
            >
              <Textarea
                id="request-justification"
                rows={4}
                value={justification}
                placeholder="Need read access to the supplier contract archive for the Q4 renewal review."
                onChange={(event) => setJustification(event.target.value)}
              />
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
