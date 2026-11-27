import { useCallback, useMemo, useState } from 'react';
import { openInstanceExport, useInstanceExports } from '@seamnex/api-client';
import type { InstanceDetail, InstanceExport } from '@seamnex/domain';
import { can } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  InlineNote,
  Panel,
  PanelHeader,
  SkeletonLines,
  defineColumns,
  type Column,
} from '@seamnex/ui';
import { formatBytes, formatRelative, saveBlob } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../../session';

const exportRowKey = (row: InstanceExport) => row.exportId;

const CONTENT_LABELS: Record<InstanceExport['includes'][number], string> = {
  database: 'database',
  volumes: 'volumes',
  definition: 'definition',
  environment: 'environment',
};

/**
 * What the archive holds, named by the capture rather than by the button that produced it.
 *
 * This is the whole point of the tab: an operator who reads "database" here has a dump in the file,
 * and one who reads "secrets" under *Not included* knows what must be supplied again.
 */
const exportColumns = defineColumns<InstanceExport>([
  {
    id: 'exportedAt',
    header: 'Exported',
    cell: (row) => (
      <div className="flex flex-col">
        <span className="text-micro text-text">{formatRelative(row.exportedAt)}</span>
        <span className="font-mono text-micro text-faint">{row.exportId}</span>
      </div>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    hideBelow: 'md',
    cell: (row) => (
      <span className="font-mono text-micro text-muted">{formatBytes(row.bytes)}</span>
    ),
  },
  {
    id: 'contents',
    header: 'Contents',
    cell: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.includes.length === 0 ? (
          <span className="text-micro text-warning-strong">nothing captured</span>
        ) : (
          row.includes.map((item) => (
            <Badge key={item} tone="info" size="sm">
              {CONTENT_LABELS[item]}
            </Badge>
          ))
        )}
      </div>
    ),
  },
  {
    id: 'excluded',
    header: 'Not included',
    hideBelow: 'lg',
    cell: (row) =>
      row.excluded.length === 0 ? (
        <span className="text-micro text-faint">—</span>
      ) : (
        <span
          className="text-micro text-muted"
          title={row.excluded.map((e) => `${e.item}: ${e.reason}`).join('\n')}
        >
          {row.excluded.map((entry) => entry.item).join(', ')}
        </span>
      ),
  },
  {
    id: 'checksum',
    header: 'Checksum',
    hideBelow: 'md',
    mono: true,
    cell: (row) => (
      <span className="text-micro text-faint" title={row.sha256}>
        {row.sha256.slice(0, 12)}…
      </span>
    ),
  },
]);

/**
 * FR-1.13 / AC-20 — the exports an instance has on disk, and the way to take one away.
 *
 * The tab exists because the archive is the deliverable: an operator who cannot find and download it
 * has a promise, not an exit strategy. It is rendered only for a role that may export
 * (`instance.lifecycle`, R1-only), which is also what the read requires — a domain owner opening the
 * instance must not fire a query that is a guaranteed refusal.
 */
export function ExportsTab({ instance }: { instance: InstanceDetail }) {
  const { session } = useSession();
  const exports = useInstanceExports(instance.id, {
    enabled: can(session.role, 'instance.lifecycle'),
  });
  const canDownload = can(session.role, 'instance.lifecycle');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  /**
   * One download at a time, and the body is read before the save so a failed transfer leaves no
   * half-written file with a plausible name.
   */
  const download = useCallback(
    async (row: InstanceExport): Promise<void> => {
      setBusyId(row.exportId);
      setError(null);
      try {
        const handle = await openInstanceExport(instance.id, row.exportId);
        const blob = await handle.response.blob();
        saveBlob(handle.fileName, blob);
      } catch (caught) {
        setError(caught);
      } finally {
        setBusyId(null);
      }
    },
    [instance.id],
  );

  const columns = useMemo<Column<InstanceExport>[]>(
    () => [
      ...exportColumns,
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (row) =>
          canDownload ? (
            <Button
              size="sm"
              variant="quiet"
              disabled={busyId !== null}
              onClick={() => void download(row)}
            >
              {busyId === row.exportId ? 'Downloading…' : 'Download'}
            </Button>
          ) : (
            <span className="text-micro text-faint">admin only</span>
          ),
      },
    ],
    [busyId, canDownload, download],
  );

  return (
    <Panel>
      <PanelHeader
        title="Data export"
        description="A plain .tar.gz holding the product's database dumps, its data volumes and the definition that was applied, plus a read-me for restoring them without this platform. Use Export in the actions above to produce one."
      />
      {error !== null ? (
        <div className="p-3">
          <QueryError error={error} compact />
        </div>
      ) : null}
      <AsyncPanel
        query={exports}
        loading={
          <div className="p-4">
            <SkeletonLines lines={4} />
          </div>
        }
        loadingLabel="Loading the exports"
        renderError={(queryError, retry) => (
          <div className="p-4">
            <QueryError error={queryError} onRetry={retry} />
          </div>
        )}
        empty={(rows) =>
          rows.length === 0 && (
            <div className="p-4">
              <EmptyState
                title="No export yet"
                description="Export in the actions above captures the database, the volumes and the applied definition into one archive. It appears here, with what it contains, when the job finishes."
              />
            </div>
          )
        }
      >
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={exportRowKey} dense />}
      </AsyncPanel>
      <InlineNote>
        Archives are unencrypted files on the platform host and are not pruned automatically.
        Download one, then remove it from the host when the business has its copy — a plaintext copy
        of the whole dataset should not outlive its purpose.
      </InlineNote>
    </Panel>
  );
}
