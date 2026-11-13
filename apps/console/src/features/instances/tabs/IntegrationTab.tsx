import type { InstanceDetail } from '@seamnex/domain';
import { Badge, InlineNote, KeyValueRows, Panel, PanelHeader, SplitLayout } from '@seamnex/ui';
import { formatBytes, formatRelative } from '@seamnex/utils';

export function IntegrationTab({ instance }: { instance: InstanceDetail }) {
  return (
    <div className="space-y-3">
      <Panel>
        {/* FR-2.9 — requirement id, developer-only; it used to be the panel eyebrow. */}
        <PanelHeader
          title="Post-deployment integration health"
          description="An instance is not reported ready until every check passes."
        />
        <ul className="divide-y divide-line">
          {instance.integrationChecks.map((check) => (
            <li key={check.check} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-body font-medium text-text">{check.label}</p>
                <p className="mt-0.5 text-meta leading-snug text-muted">{check.detail}</p>
              </div>
              <div className="shrink-0 text-right">
                <Badge tone={check.ok ? 'positive' : 'danger'} size="sm">
                  {check.ok ? 'pass' : 'fail'}
                </Badge>
                <p className="mt-0.5 font-mono text-micro text-faint">
                  {formatRelative(check.checkedAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <SplitLayout ratio="even">
        <Panel>
          <PanelHeader eyebrow="Services" title="Stack composition" />
          <div className="p-4">
            <KeyValueRows
              rows={instance.services.map((service) => ({
                key: service.id,
                label: (
                  <span>
                    <span className="font-mono text-meta text-text">{service.serviceName}</span>
                    <span className="ml-1.5 text-micro text-faint">{service.role}</span>
                  </span>
                ),
                value: <span className="font-mono text-micro text-muted">{service.imageRef}</span>,
              }))}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader eyebrow="Storage" title="Volumes and quota" />
          <div className="p-4">
            <KeyValueRows
              rows={instance.volumes.map((volume) => ({
                key: volume.id,
                label: <span className="font-mono text-meta">{volume.name}</span>,
                value: (
                  <span className="font-mono text-micro text-muted">
                    {formatBytes(volume.usedMb * 1024 ** 2)} /{' '}
                    {formatBytes(volume.quotaMb * 1024 ** 2)}
                  </span>
                ),
              }))}
            />
            <InlineNote className="mt-2">
              Mount paths are internal; nothing is exposed on a host path without an approved
              exception.
            </InlineNote>
          </div>
        </Panel>
      </SplitLayout>

      <Panel>
        <PanelHeader eyebrow="Triggers" title="Inbound event endpoints" />
        <div className="flex flex-wrap gap-2 p-4">
          {instance.eventModes.length === 0 ? (
            <span className="text-meta text-muted">
              This product exposes no event mechanism, so workflows can only poll it on a schedule.
            </span>
          ) : (
            instance.eventModes.map((mode) => (
              <Badge
                key={`${mode.mode}:${mode.label}`}
                tone={mode.mode === 'webhook' ? 'accent' : 'neutral'}
              >
                {mode.label}
                {mode.minimumIntervalMinutes === undefined
                  ? ''
                  : ` · min ${mode.minimumIntervalMinutes} min`}
              </Badge>
            ))
          )}
          <span className="text-meta text-faint">
            Inbound tokens are issued once and stored as HMAC secrets; the trigger ingress dedupes
            deliveries.
          </span>
        </div>
      </Panel>
    </div>
  );
}
