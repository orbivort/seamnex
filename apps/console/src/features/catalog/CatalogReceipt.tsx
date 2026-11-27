import type { CatalogReloadResult } from '@seamnex/domain';
import { Alert, Badge } from '@seamnex/ui';

/**
 * The reconciliation receipt, shared by a reload and a sync (ADR-BE-42 §10.4).
 *
 * One component rather than two blocks: a sync returns this receipt plus the provenance of the tree
 * it read, so a second renderer would be the place the two drifted apart. `source` is optional
 * because a plain reload has no fetch to describe.
 */
export function CatalogReceipt({
  data,
  mode,
  source,
}: {
  data: CatalogReloadResult;
  mode: 'reload' | 'sync';
  source?: { url: string; ref: string; commit: string };
}) {
  const environment = data.environment;
  const refused = environment?.refused ?? [];
  const invalid = data.invalid ?? [];
  const coverage = data.coverage;
  /*
   * S-1: a declaration with no entry document is a refusal, not a note — the product cannot be
   * deployed at all — so it makes the receipt partial for the same reason a refused environment file
   * does.
   */
  const partial = refused.length > 0 || invalid.length > 0 || (coverage?.refused.length ?? 0) > 0;
  const envChanges = environment?.applied ?? [];
  const reconciledChanges = data.reconciled.filter((item) => item.change !== 'unchanged');
  const nothingMoved = reconciledChanges.length === 0 && envChanges.length === 0 && !partial;
  const heading =
    mode === 'sync' ? 'Catalogue synced at revision' : 'Repository reloaded at revision';

  return (
    <Alert
      tone={partial ? 'caution' : 'positive'}
      title={
        partial
          ? `${heading} ${data.revision}, with changes refused`
          : `${heading} ${data.revision}`
      }
    >
      {/* A sync names the tree it came from. Without it the operator reads a delta with no way to
          say which tag produced it. */}
      {source === undefined ? null : (
        <span className="mb-1 block text-meta">
          Source <span className="font-mono">{source.url}</span> at{' '}
          <span className="font-mono">{source.ref}</span>, commit{' '}
          <span className="font-mono">{source.commit.slice(0, 12)}</span>.
        </span>
      )}
      <span className="block">
        {data.entries} entries reconciled: {data.added} added, {data.changed} changed,{' '}
        {data.removed} removed.
        {environment === undefined
          ? null
          : ` Environment: ${environment.added} added, ${environment.changed} changed, ${environment.removed} removed.`}{' '}
        The repository remains authoritative over the control-plane projection.
      </span>

      {/*
        S-1 / S-2 — the coverage verdict on the receipt. Deliberately beside the delta rather
        than on a separate screen: a reload that leaves three products undeployable reads as a
        success unless the receipt says how much of the catalogue is actually documented.
      */}
      {coverage === undefined ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-current/15 pt-2">
          <Badge tone="neutral" size="sm">
            {coverage.declaredEnvironments} declared
          </Badge>
          <Badge tone="positive" size="sm">
            {coverage.documentedEnvironments} documented
          </Badge>
          {coverage.refused.length === 0 ? null : (
            <Badge tone="danger" size="sm">
              {coverage.refused.length} refused
            </Badge>
          )}
          <Badge tone={coverage.floorMet ? 'positive' : 'caution'} size="sm">
            {coverage.nativeDeployments} native of {coverage.floor} required
          </Badge>
          <span className="text-micro">
            {coverage.deployments} deployments, shared instances counted once. The floor is S-2's;
            GET /posture serves the target in force.
          </span>
        </div>
      )}

      {coverage === undefined || coverage.refused.length === 0 ? null : (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {coverage.refused.map((item) => (
            <li key={item.key} className="text-meta">
              <span className="font-mono font-medium">{item.key}</span>
              <Badge tone="danger" size="sm">
                entry document missing
              </Badge>
              <span className="block leading-snug">Refused: {item.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {refused.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {refused.map((item) => (
            <li key={`${item.key}:${item.name ?? '*'}`} className="text-meta">
              <span className="font-mono font-medium">{item.key}</span>
              {item.name === null ? null : <span className="font-mono"> · {item.name}</span>}
              <span className="block leading-snug">
                File skipped, nothing was written: {item.reason}.
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {invalid.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {invalid.map((item) => (
            <li key={item.path} className="text-meta">
              <span className="font-mono font-medium">{item.path}</span>
              <span className="block leading-snug">
                Not applied, left as projected: {item.reason}.
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {nothingMoved ? (
        <span className="mt-1 block text-meta">
          No drift: every entry and environment schema already matched this revision.
        </span>
      ) : (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {reconciledChanges.map((item) => (
            <li key={item.key} className="flex items-start justify-between gap-3 text-meta">
              <span className="font-mono font-medium">{item.key}</span>
              <span className="min-w-0 flex-1 text-right">{item.detail}</span>
              <span className="shrink-0 font-mono label-caps">{item.change}</span>
            </li>
          ))}
          {envChanges.map((item) => (
            <li
              key={`env:${item.key}`}
              className="flex items-start justify-between gap-3 text-meta"
            >
              <span className="font-mono font-medium">{item.key}</span>
              <span className="min-w-0 flex-1 text-right">
                environment: {item.added} added, {item.changed} changed, {item.removed} removed
              </span>
              <span className="shrink-0 font-mono label-caps">env</span>
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
