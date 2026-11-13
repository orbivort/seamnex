import { useState } from 'react';
import { Activity, Save, ShieldCheck } from 'lucide-react';
import {
  useAlertChannels,
  useSettings,
  useUpdateAlertChannels,
  useUpdateSettings,
} from '@seamnex/api-client';
import type { PlatformSettings } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  DefinitionList,
  EmptyState,
  Field,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  SplitLayout,
  Switch,
} from '@seamnex/ui';
import { cn, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const alerts = useAlertChannels();
  const updateAlerts = useUpdateAlertChannels();

  const [draft, setDraft] = useState<Partial<PlatformSettings>>({});

  const value = (key: keyof PlatformSettings, fallback: number): number =>
    typeof draft[key] === 'number' ? (draft[key] as number) : fallback;

  return (
    <Page>
      <PageHeader
        eyebrow="Platform configuration"
        title="Settings"
        description="Break-glass duration, restore concurrency, oversubscription and session limits. Every change is audited."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Save />}
            disabled={update.isPending || Object.keys(draft).length === 0}
            onClick={() =>
              update.mutate(draft as Record<string, number>, { onSuccess: () => setDraft({}) })
            }
          >
            Save changes
          </Button>
        }
      />

      {update.isError ? <QueryError error={update.error} compact /> : null}
      {update.data ? (
        <div className="mb-3">
          <Alert tone="positive" title="Settings saved" />
        </div>
      ) : null}

      <SplitLayout ratio="even">
        <Panel>
          {/* FR-4.11 · DD-15 — requirement ids, developer-only; the panel header used to carry
              them as its eyebrow. */}
          <PanelHeader title="Session and elevation" />
          {/*
            Two independent reads, two independent regions: the settings form and the alert channels
            fail separately, and one banner must not stand in for the other (ARCH-03). The wrapper
            padding moved into the region's branches so a skeleton, a problem panel and the form all
            sit on the same grid.
          */}
          <AsyncPanel
            query={settings}
            loading={
              <div className="space-y-4 p-4">
                <SkeletonLines lines={5} />
              </div>
            }
            loadingLabel="Loading platform settings"
          >
            {(data) => (
              <div className="space-y-4 p-4">
                <Field
                  label="Break-glass maximum (minutes)"
                  htmlFor="bg-minutes"
                  hint="5–240. Cannot be extended in-session."
                >
                  <Input
                    id="bg-minutes"
                    type="number"
                    min={5}
                    max={240}
                    value={value('breakGlassMaxMinutes', data.breakGlassMaxMinutes)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        breakGlassMaxMinutes: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Restore concurrency"
                  htmlFor="restore-conc"
                  hint="Floor 4, ceiling 12. Parallel restores are authorised separately."
                >
                  <Input
                    id="restore-conc"
                    type="number"
                    min={4}
                    max={12}
                    value={value('restoreConcurrency', data.restoreConcurrency)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        restoreConcurrency: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <Field
                  label="CPU oversubscription factor"
                  htmlFor="oversub"
                  hint="Applies to CPU only. Memory and disk are never oversubscribed."
                >
                  <Input
                    id="oversub"
                    type="number"
                    min={1}
                    max={2}
                    step={0.05}
                    value={value('oversubscriptionFactor', data.oversubscriptionFactor)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        oversubscriptionFactor: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <DefinitionList
                  columns={2}
                  items={[
                    { label: 'Idle timeout', value: `${data.sessionIdleMinutes} min` },
                    { label: 'Absolute session', value: `${data.sessionAbsoluteHours} h` },
                    {
                      label: 'Metadata review window',
                      value: `${data.metadataReviewDays} days`,
                    },
                    { label: 'Audit retention', value: `${data.auditRetentionDays} days` },
                  ]}
                />
                <p className="text-micro text-faint">
                  Last changed {formatDateTime(data.updatedAt)} by {data.updatedBy}.
                </p>
              </div>
            )}
          </AsyncPanel>
        </Panel>

        <Panel>
          {/* FR-4.6 — requirement id, developer-only; the panel header used to carry it as its
              eyebrow. */}
          <PanelHeader
            title="Alert channels"
            description="At least one channel must be configured. Maintenance windows suppress delivery."
          />
          {/*
            ERR-05: this panel's two writes — the empty state's "Add an e-mail channel" button and
            every per-row switch — are the same mutation, so they share one failure slot inside the
            panel they change. It cannot stand at page level: the settings write above has its own
            banner there, and one banner must not be read as the outcome of the other. Rendering it
            per row would print the same failure once per channel.
          */}
          {updateAlerts.isError ? (
            <div className="p-3">
              <QueryError error={updateAlerts.error} compact />
            </div>
          ) : null}
          <AsyncPanel
            query={alerts}
            loading={
              <div className="p-4">
                <SkeletonLines lines={4} />
              </div>
            }
            loadingLabel="Loading alert channels"
            empty={(data) =>
              data.length === 0 && (
                <div className="p-4">
                  {/* FR-4.6: the empty copy used to read "FR-4.6 requires delivery to at least one
                      channel. Detection without delivery leaves an incident unseen." */}
                  <EmptyState
                    title="No alert channel configured"
                    description="Delivery to at least one channel is required. Detection without delivery leaves an incident unseen."
                    action={
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={updateAlerts.isPending}
                        onClick={() =>
                          updateAlerts.mutate([
                            {
                              id: 'ch-email-default',
                              type: 'email',
                              target: 'ops@seamnex.local',
                              severities: ['critical', 'warning'],
                              enabled: true,
                              lastDeliveryAt: null,
                            },
                          ])
                        }
                      >
                        Add an e-mail channel
                      </Button>
                    }
                  />
                </div>
              )
            }
          >
            {(data) => (
              <div className="divide-y divide-line">
                {data.map((channel) => (
                  <div key={channel.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-body font-medium text-text">
                          <Activity className="size-3.5 text-faint" aria-hidden />
                          <span className="font-mono">{channel.type}</span>
                        </p>
                        <p className="mt-0.5 truncate text-micro text-muted">{channel.target}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {channel.severities.map((severity) => (
                            <Badge key={severity} tone="neutral" size="sm">
                              {severity}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="text-right">
                        <Switch
                          checked={channel.enabled}
                          label={`Enable ${channel.type} channel`}
                          disabled={updateAlerts.isPending}
                          onCheckedChange={(checked) => {
                            // The write replaces the whole list, so it is built from the data this
                            // panel rendered rather than from a second read of the cache.
                            updateAlerts.mutate(
                              data.map((item) =>
                                item.id === channel.id ? { ...item, enabled: checked } : item,
                              ),
                            );
                          }}
                        />
                        <p className="mt-1 text-micro text-faint">
                          {channel.lastDeliveryAt
                            ? formatRelative(channel.lastDeliveryAt)
                            : 'never used'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AsyncPanel>
          <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-micro text-faint">
            <ShieldCheck className="size-3.5" aria-hidden />
            Delivery is suppressed inside a maintenance window; the window is shown in the portal.
          </div>
        </Panel>
      </SplitLayout>

      {Object.keys(draft).length > 0 ? (
        <p className={cn('mt-2 font-mono text-micro text-warning-strong')}>
          unsaved changes: {Object.keys(draft).join(', ')}
        </p>
      ) : null}
    </Page>
  );
}
