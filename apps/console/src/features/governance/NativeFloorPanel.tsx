import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toProblem, useRecordNativeFloorDecision, useRegistry } from '@seamnex/api-client';
import {
  GUARANTEE_CLASS_LABELS,
  NATIVE_BASELINE_DEPLOYMENTS,
  NATIVE_FLOOR_DEPLOYMENTS,
  type PostureSummary,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  Panel,
  PanelHeader,
  Textarea,
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { useCapabilities } from '../../use-capabilities';

/**
 * S-2 — the native floor, as served data.
 *
 * The numbers used to be two literals in this screen, which meant the badge, the caption and the
 * acceptance evidence each had their own idea of the target and none of them could be wrong out loud.
 * `sso.nativeFloor` is the floor in force (lowered only by a recorded decision) and `sso.ownerDecision`
 * is that decision, so the block cannot claim a target the platform is not measuring against.
 */
export function NativeFloorPanel({ sso }: { sso: PostureSummary['sso'] }) {
  const registry = useRegistry();
  const record = useRecordNativeFloorDecision();
  const { mutable } = useCapabilities();
  const canDecide = mutable.has('settings.manage');

  const [open, setOpen] = useState(false);
  const [floor, setFloor] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const floorInForce = sso.nativeFloor?.floor ?? NATIVE_FLOOR_DEPLOYMENTS;
  const baseline = sso.nativeFloor?.baseline ?? NATIVE_BASELINE_DEPLOYMENTS;
  const met = sso.nativeFloor?.met ?? sso.native >= floorInForce;
  const shortfall = sso.nativeFloor?.shortfall ?? Math.max(0, floorInForce - sso.native);
  const deployments = sso.native + sso.forwardAuth + sso.signInRequired;
  const decision = sso.ownerDecision ?? null;

  /**
   * The deployments that are not native — the gap the floor is measured against.
   *
   * Read from the registry rather than counted from the posture payload, because "4 short" without
   * names sends an operator to the catalogue to work out which four. A shared deployment appears
   * once: D5 and D6 are one ERPNext instance.
   */
  const nonNative = useMemo(() => {
    const seen = new Set<string>();
    const rows: { instanceId: string; product: string; guaranteeClass: string }[] = [];
    for (const entry of registry.data ?? []) {
      if (entry.guaranteeClass === 'native' || seen.has(entry.instanceId)) continue;
      seen.add(entry.instanceId);
      rows.push({
        instanceId: entry.instanceId,
        product: entry.product,
        guaranteeClass: entry.guaranteeClass,
      });
    }
    return rows;
  }, [registry.data]);

  const percent = (value: number): number =>
    deployments === 0 ? 0 : Math.round((value / deployments) * 100);

  const parsedFloor = Number.parseInt(floor, 10);
  const floorError =
    !Number.isInteger(parsedFloor) || parsedFloor < 0 || parsedFloor >= floorInForce
      ? `Enter a whole number between 0 and ${Math.max(0, floorInForce - 1)}.`
      : null;
  const reasonError =
    reason.trim().length < 20 ? 'State what is being accepted in at least 20 characters.' : null;
  const problem = record.error ? toProblem(record.error) : null;

  const submit = () => {
    setTouched(true);
    if (floorError !== null || reasonError !== null) return;
    record.mutate(
      { floor: parsedFloor, reason: reason.trim() },
      {
        onSuccess: () => {
          setOpen(false);
          setFloor('');
          setReason('');
        },
      },
    );
  };

  return (
    <Panel>
      <PanelHeader
        eyebrow="S-2"
        title="Native floor"
        description="Deployments that authenticate directly against the identity provider, counted per deployment so a shared instance is not counted twice."
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro text-muted">
              {sso.native} of {floorInForce} required
            </span>
            <Badge tone={met ? 'positive' : 'caution'} size="sm">
              {met ? 'met' : `${shortfall} short`}
            </Badge>
            {canDecide ? (
              <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
                Record a decision
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="space-y-3 p-4">
        {/* Segmented bar: the three classes partition the deployments, so the widths add up. */}
        <div
          className="flex h-1.5 w-full overflow-hidden rounded-sm bg-panel-soft"
          role="img"
          aria-label={`${sso.native} native, ${sso.forwardAuth} forward-auth, ${sso.signInRequired} sign-in required of ${deployments} deployments`}
        >
          <span className="bg-success" style={{ width: `${percent(sso.native)}%` }} />
          <span className="bg-primary" style={{ width: `${percent(sso.forwardAuth)}%` }} />
          <span className="bg-warning" style={{ width: `${percent(sso.signInRequired)}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-muted">
          <Legend className="bg-success" label={`native ${sso.native}`} />
          <Legend className="bg-primary" label={`forward-auth ${sso.forwardAuth}`} />
          <Legend className="bg-warning" label={`sign-in required ${sso.signInRequired}`} />
          <span className="text-faint">
            {baseline} baseline deployments
            {sso.totalEntries === deployments
              ? ''
              : ` · ${sso.totalEntries} catalog entries, shared deployments counted once`}
          </span>
        </div>

        {decision === null ? null : (
          <Callout tone="neutral" title={`Floor lowered to ${decision.floor} by recorded decision`}>
            {decision.reason} — recorded by {decision.recordedBy} on{' '}
            {formatDateTime(decision.recordedAt)}. A lower floor is only ever a decision, never a
            re-baseline.
          </Callout>
        )}

        {met ? (
          <p className="text-body text-muted">
            The floor is met: {sso.native} deployments authenticate natively.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-body text-muted">
              {shortfall} more native {shortfall === 1 ? 'deployment is' : 'deployments are'}{' '}
              required. These deployments are not native today:
            </p>
            {registry.isError ? (
              <p className="text-meta text-faint">
                The registry could not be read, so the deployments cannot be named here.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-sm border border-line">
                {nonNative.slice(0, 8).map((item) => (
                  <li
                    key={item.instanceId}
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <Link
                      to={`/instances/${item.instanceId}`}
                      className="min-w-0 truncate text-body text-text hover:underline"
                    >
                      {item.product}
                    </Link>
                    <span className="shrink-0 text-micro text-faint">
                      {GUARANTEE_CLASS_LABELS[
                        item.guaranteeClass as keyof typeof GUARANTEE_CLASS_LABELS
                      ]?.label ?? item.guaranteeClass}
                    </span>
                  </li>
                ))}
                {nonNative.length > 8 ? (
                  <li className="px-3 py-1.5 text-micro text-faint">
                    … and {nonNative.length - 8} more
                  </li>
                ) : null}
                {nonNative.length === 0 ? (
                  <li className="px-3 py-1.5 text-micro text-faint">
                    No non-native deployment was reported.
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Record an owner decision that lowers the floor"
        description="S-2 permits a lower floor only as a recorded decision. The row and its audit entry are written together, and GET /posture serves the new target from then on."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={record.isPending}>
              {record.isPending ? 'Recording…' : 'Record decision'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Floor"
            htmlFor="native-floor"
            required
            hint={`Must be lower than the current floor of ${floorInForce}.`}
          >
            <Input
              id="native-floor"
              type="number"
              min={0}
              max={Math.max(0, floorInForce - 1)}
              value={floor}
              onChange={(event) => setFloor(event.target.value)}
              invalid={touched && floorError !== null}
            />
          </Field>
          {touched && floorError !== null ? (
            <p role="alert" className="text-meta font-medium text-danger">
              {floorError}
            </p>
          ) : null}
          <Field
            label="Reason"
            htmlFor="native-floor-reason"
            required
            hint="What is being accepted by lowering the target, and for how long."
          >
            <Textarea
              id="native-floor-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              invalid={touched && reasonError !== null}
            />
          </Field>
          {touched && reasonError !== null ? (
            <p role="alert" className="text-meta font-medium text-danger">
              {reasonError}
            </p>
          ) : null}
          {problem ? (
            <div
              role="alert"
              className="rounded-sm border border-danger-border bg-danger-soft px-3.5 py-3"
            >
              <p className="text-body font-semibold text-danger-strong">{problem.title}</p>
              <p className="mt-1 text-body leading-snug text-muted">{problem.detail}</p>
            </div>
          ) : null}
        </div>
      </Dialog>
    </Panel>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-sm ${className}`} aria-hidden />
      {label}
    </span>
  );
}
