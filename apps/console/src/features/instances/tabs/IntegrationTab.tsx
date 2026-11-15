import type { InstanceDetail } from '@seamnex/domain';
import {
  Badge,
  Callout,
  InlineNote,
  KeyValueRows,
  Panel,
  PanelHeader,
  SplitLayout,
} from '@seamnex/ui';
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
            {instance.volumes.length === 0 ? (
              /**
               * FR-1.12: the sentence is the platform's actual behaviour, not an aspiration. It
               * used to promise "a backup would capture the database and none of the files", which
               * is what the backup now refuses to do; and the gap is a data-protection one, so it
               * gets a caution surface rather than a grey paragraph an operator skims past.
               */
              <Callout tone="caution" title="No data volume registered">
                The platform records the volumes a stack creates when it is applied, and none is
                recorded for this instance yet. A backup is refused until they are — the alternative
                would be restoring a database with none of the product&apos;s files. Reconfigure the
                instance to register them.
              </Callout>
            ) : (
              <KeyValueRows
                rows={instance.volumes.map((volume) => {
                  const tone = quotaTone(volume.usedMb, volume.quotaMb);
                  return {
                    key: volume.id,
                    label: <span className="font-mono text-meta">{volume.name}</span>,
                    value: (
                      <span className="flex items-center gap-2 font-mono text-micro text-muted">
                        {formatBytes(volume.usedMb * 1024 ** 2)} /{' '}
                        {formatBytes(volume.quotaMb * 1024 ** 2)}
                        {tone === null ? null : (
                          <Badge tone={tone} size="sm">
                            {tone === 'danger' ? 'over quota' : 'near quota'}
                          </Badge>
                        )}
                      </span>
                    ),
                  };
                })}
              />
            )}
            <InlineNote className="mt-2">
              Usage is measured by the status sampler; the quota is the reviewed per-volume limit.
              Mount paths are internal, and nothing is exposed on a host path without an approved
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

/**
 * FR-1.9 — the per-volume limit is soft, so the screen is where an operator can see it coming: 90 %
 * is worth a word, and at the quota itself the volume is over the reviewed limit.
 */
function quotaTone(usedMb: number, quotaMb: number): 'caution' | 'danger' | null {
  if (quotaMb <= 0) return null;
  if (usedMb >= quotaMb) return 'danger';
  return usedMb * 10 >= quotaMb * 9 ? 'caution' : null;
}
