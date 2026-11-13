import { ShieldCheck } from 'lucide-react';
import { useDrift } from '@seamnex/api-client';
import type { InstanceDetail } from '@seamnex/domain';
import { Badge, EmptyState, Panel, PanelHeader, SkeletonLines } from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

export function DriftTab({ instance }: { instance: InstanceDetail }) {
  const drift = useDrift(instance.id);
  return (
    <Panel>
      {/* FR-1.29 — requirement id, developer-only; it used to be the panel eyebrow. */}
      <PanelHeader
        title="Environment drift"
        description="Variables observed in the running container that differ from the declared definition, or that are set but undeclared."
      />
      {/* A list panel, not a table: there is no header row to preserve, so the empty copy is the
          async region's own branch rather than a sibling block. */}
      <AsyncPanel
        query={drift}
        loading={
          <div className="p-4">
            <SkeletonLines lines={4} />
          </div>
        }
        loadingLabel="Loading the drift report"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
        empty={(records) =>
          records.length === 0 && (
            <EmptyState
              compact
              icon={<ShieldCheck className="size-5" />}
              title="No drift detected"
              description="The running environment matches the last applied render set."
            />
          )
        }
      >
        {(records) => (
          <ul className="divide-y divide-line">
            {records.map((record) => (
              <li
                key={record.id}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="font-mono text-meta font-medium text-text">{record.varName}</p>
                  <p className="mt-0.5 text-meta text-muted">
                    declared <span className="font-mono">{record.declared ?? 'absent'}</span> ·
                    observed <span className="font-mono">{record.observed ?? 'absent'}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={record.kind === 'mismatch' ? 'caution' : 'info'} size="sm">
                    {record.kind}
                  </Badge>
                  <span className="text-micro text-faint">{formatRelative(record.detectedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AsyncPanel>
    </Panel>
  );
}
