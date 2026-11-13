import { ChevronRight } from 'lucide-react';
import type { InstanceDetail } from '@seamnex/domain';
import {
  Callout,
  DefinitionList,
  KeyValueRows,
  Panel,
  PanelHeader,
  SplitLayout,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';

export function OverviewTab({ instance }: { instance: InstanceDetail }) {
  return (
    <SplitLayout ratio="content">
      <div className="space-y-3">
        <Panel>
          <PanelHeader eyebrow="Definition" title="Instance facts" />
          <div className="p-4">
            <DefinitionList
              columns={2}
              items={[
                { label: 'Catalog entry', value: `${instance.entryKey} · ${instance.product}` },
                { label: 'Domain', value: instance.domain },
                { label: 'Route', value: instance.route.host, mono: true },
                {
                  label: 'Published',
                  value: instance.route.published ? 'Yes' : 'No — route unpublished',
                },
                { label: 'Publish model', value: instance.route.publishModel },
                {
                  label: 'TLS',
                  value: instance.route.tlsMode === 'acme' ? 'ACME wildcard' : 'Internal CA',
                },
                { label: 'Profile', value: instance.profileKey },
                { label: 'Owner', value: instance.owner.name },
                { label: 'Domain owner', value: instance.domainOwner.name },
                { label: 'Created', value: formatDateTime(instance.createdAt) },
                { label: 'Current version', value: instance.currentVersion, mono: true },
                { label: 'Available version', value: instance.availableVersion ?? 'Up to date' },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          {/* FR-1.18 — requirement id, developer-only; the panel header used to carry it as its
              eyebrow. */}
          <PanelHeader title="Resolved deployment source" />
          <div className="p-4">
            <DefinitionList
              columns={2}
              items={[
                { label: 'Path', value: instance.source.path },
                { label: 'Source location', value: instance.source.sourceUrl, mono: true },
                { label: 'Revision', value: instance.source.sourceRevision, mono: true },
                { label: 'Resolved image', value: instance.source.resolvedImageRef, mono: true },
                { label: 'Policy verdict', value: instance.source.policyVerdict },
                { label: 'Resolved at', value: formatDateTime(instance.source.resolvedAt) },
              ]}
            />
            {instance.source.policyNotes.length > 0 ? (
              <ul className="mt-3 space-y-1 border-t border-line pt-2.5">
                {instance.source.policyNotes.map((note) => (
                  <li
                    key={note}
                    className="flex items-start gap-1.5 text-meta leading-snug text-muted"
                  >
                    <ChevronRight className="mt-0.5 size-3 shrink-0 text-faint" aria-hidden />
                    {note}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel>
          <PanelHeader eyebrow="Consumption" title="Resource usage" />
          <div className="space-y-2 p-4">
            <KeyValueRows
              rows={[
                { key: 'cpu', label: 'CPU limit', value: `${instance.resources.cpu} vCPU` },
                { key: 'cpu-use', label: 'CPU in use', value: `${instance.usage.cpuPercent}%` },
                {
                  key: 'mem',
                  label: 'Memory limit',
                  value: `${(instance.resources.memoryMb / 1024).toFixed(1)} GB`,
                },
                {
                  key: 'mem-use',
                  label: 'Memory in use',
                  value: `${(instance.usage.memoryMb / 1024).toFixed(1)} GB`,
                },
                {
                  key: 'disk',
                  label: 'Disk quota',
                  value: `${(instance.resources.diskMb / 1024).toFixed(0)} GB`,
                },
                {
                  key: 'disk-use',
                  label: 'Disk in use',
                  value: `${(instance.usage.diskMb / 1024).toFixed(0)} GB`,
                },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader eyebrow="Recovery" title="Backup posture" />
          <div className="space-y-2 p-4">
            <KeyValueRows
              rows={[
                { key: 'schedule', label: 'Schedule', value: instance.backup.schedule },
                {
                  key: 'last',
                  label: 'Last successful',
                  value: instance.backup.lastSuccessAt
                    ? formatRelative(instance.backup.lastSuccessAt)
                    : 'Never',
                },
                {
                  key: 'verify',
                  label: 'Last verified restore',
                  value: instance.backup.lastVerifiedRestoreAt
                    ? formatDateTime(instance.backup.lastVerifiedRestoreAt)
                    : 'Not verified',
                },
                {
                  key: 'image',
                  label: 'Image digest',
                  value: (
                    <span className="font-mono text-micro">
                      {instance.imageDigest.slice(0, 22)}…
                    </span>
                  ),
                },
              ]}
            />
            {!instance.backup.verified ? (
              <Callout tone="caution" title="No verified restore">
                A backup exists but no drill has passed. S-5 requires a verified restore for every
                stateful deployment.
              </Callout>
            ) : null}
          </div>
        </Panel>
      </div>
    </SplitLayout>
  );
}
