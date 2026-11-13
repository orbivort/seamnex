import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download, Rocket } from 'lucide-react';
import {
  toProblem,
  useCatalogEntry,
  useConfirmScaffold,
  useEnvSchema,
  usePrefetchEntry,
  useScaffoldDraft,
  useVerifyIntegrationMetadata,
} from '@seamnex/api-client';
import {
  CREDENTIAL_GRANULARITY_OPTIONS,
  GUARANTEE_CLASS_LABELS,
  PACKAGING_LABELS,
  can,
  canMutate,
  isWriteEligible,
  writeIneligibilityReason,
  type CredentialGranularity,
} from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  DefinitionList,
  Field,
  Grid,
  InlineNote,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  SplitLayout,
  StatusPill,
  TabPanel,
  Tabs,
  buttonVariants,
} from '@seamnex/ui';
import { formatDate, formatDateTime } from '@seamnex/utils';
import { useSession } from '../../session';
import { QueryError } from '@seamnex/shell';
import { EnvTab, IntegrationTab, ScaffoldTab } from './EntryTabs';

export function EntryDetailPage() {
  const { key = '' } = useParams();
  const { session } = useSession();
  const entry = useCatalogEntry(key);
  const envSchema = useEnvSchema(key);
  const [tab, setTab] = useState('overview');
  const [granularityState, setGranularity] = useState<CredentialGranularity | null>(null);
  const verify = useVerifyIntegrationMetadata(key);
  // The draft belongs to the pending review. Left in place after a successful save it kept showing
  // an unsaved value after someone else verified the entry, or after the entry was reloaded from the
  // repository — the select would then disagree with the record it claims to display.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft is derived from a mutation result, not a render input, and the hook exposes no per-call callback
    if (verify.isSuccess) setGranularity(null);
  }, [verify.isSuccess, verify.data]);
  // CL-18: NFR-2.4 measures apply, not download, so warming the image cache is an operator action
  // taken before a deployment window rather than part of the deploy itself.
  const prefetch = usePrefetchEntry(key);

  const scaffoldEnabled = entry.data?.packaging === 'none';
  const scaffold = useScaffoldDraft(key, scaffoldEnabled);
  const confirmScaffold = useConfirmScaffold(key);

  /**
   * The whole screen is a gate on the entry, but only while there is no entry to show: `isError` is
   * also true for a failed refetch, and returning the error panel then discarded a detail surface
   * that was still cached and still the last thing the API said (ERR-04). The degraded case keeps
   * the data and shows the banner below instead.
   */
  if (!entry.data) {
    return entry.isPending ? (
      <Panel inset>
        <SkeletonLines lines={10} />
      </Panel>
    ) : (
      <QueryError error={entry.error} onRetry={() => void entry.refetch()} />
    );
  }

  const data = entry.data;
  const guarantee = GUARANTEE_CLASS_LABELS[data.guaranteeClass];
  const granularity = granularityState ?? data.integration.credentialGranularity;

  return (
    <Page>
      <Link
        to="/catalog"
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Catalog
      </Link>

      <PageHeader
        eyebrow={
          <>
            <span className="rounded-xs border border-line bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-semibold text-muted">
              {data.key}
            </span>
            <span className="font-mono text-faint label-caps">{data.cluster}</span>
            <StatusPill tone={guarantee.tone} label={guarantee.label} size="sm" />
            {data.integration.stale ? (
              <Badge tone="caution" size="sm">
                metadata stale
              </Badge>
            ) : null}
          </>
        }
        title={`${data.product} — ${data.domain}`}
        description={data.description}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download />}
              disabled={!canMutate(session.role, 'metadata.manage') || prefetch.isPending}
              title={
                canMutate(session.role, 'metadata.manage')
                  ? 'Pre-pull the pinned images so the deployment window is not spent downloading'
                  : 'R1 pre-pulls images; the pull consumes host bandwidth and disk'
              }
              onClick={() => prefetch.mutate()}
            >
              {prefetch.isPending ? 'Starting…' : 'Prefetch images'}
            </Button>
            {can(session.role, 'instance.deploy') ? (
              <Link
                to={`/deploy/${data.key}`}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                <Rocket className="size-4" aria-hidden />
                Deploy
              </Link>
            ) : (
              <Badge tone="neutral" size="sm">
                deploy: platform administrator
              </Badge>
            )}
          </>
        }
        meta={
          <>
            <Badge tone="neutral" size="sm">
              {PACKAGING_LABELS[data.packaging]}
            </Badge>
            <Badge tone="neutral" size="sm">
              {data.licenseId}
            </Badge>
            <InlineNote>{data.repoUrl}</InlineNote>
          </>
        }
      />

      {/* The degraded branch of the screen gate above: the entry is on screen, its last read failed,
          and the operator needs to know which of the two they are looking at. */}
      {entry.isError ? (
        <Alert
          tone="caution"
          title="Showing the last data that loaded"
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void entry.refetch()}>
              Retry
            </Button>
          }
        >
          {toProblem(entry.error).detail}
        </Alert>
      ) : null}

      {verify.isError ? <QueryError error={verify.error} compact /> : null}
      {verify.data ? (
        <div className="mb-3">
          <Alert tone="positive" title={`${verify.data.key} metadata verified`}>
            Review recorded by {verify.data.integration.verifiedBy}; the next review is due{' '}
            {formatDate(verify.data.integration.nextReviewAt)} and the change is in the audit trail.
          </Alert>
        </div>
      ) : null}

      {prefetch.isError ? (
        <div className="mb-3">
          <QueryError error={prefetch.error} compact />
        </div>
      ) : null}
      {prefetch.data ? (
        <div className="mb-3">
          <Alert tone="info" title={`Pre-pulling the images for ${data.key}`}>
            Job{' '}
            <Link to={`/jobs/${prefetch.data.jobId}`} className="font-mono underline">
              {prefetch.data.jobId}
            </Link>{' '}
            pulls {data.imageRef} into the local cache. It does not create containers or touch the
            published route, so it is safe to run against a live instance.
          </Alert>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'integration', label: 'Integration metadata' },
          { value: 'env', label: 'Environment schema', count: envSchema.data?.length },
          ...(scaffoldEnabled ? [{ value: 'scaffold', label: 'Scaffold draft' }] : []),
        ]}
        className="mb-3"
      >
        <TabPanel value="overview" className="pt-3">
          <SplitLayout ratio="content">
            <Panel>
              <PanelHeader eyebrow="Definition" title="Catalog entry facts" />
              <div className="p-4">
                <DefinitionList
                  columns={2}
                  items={[
                    { label: 'Upstream repository', value: data.repoUrl, mono: true },
                    { label: 'Technology stack', value: data.stack },
                    { label: 'License', value: data.licenseId, hint: data.licenseNote },
                    { label: 'Packaging source', value: data.packagingSource },
                    {
                      label: 'Primary instance',
                      value: data.primaryInstanceId ?? 'Not deployed',
                      mono: true,
                    },
                    {
                      label: 'Shared with',
                      value: data.sharedWith.length ? data.sharedWith.join(', ') : 'No other entry',
                    },
                    { label: 'HTTP port (internal)', value: String(data.httpPort) },
                    { label: 'Pinned image', value: data.imageRef, mono: true },
                    {
                      label: 'Image digest',
                      value: data.imageDigest,
                      mono: true,
                      // FR-1.5 says the deployment is pinned by digest, so a value that is not one is a
                      // defect worth showing. The catalog loader accepts any non-empty string (an
                      // entry must not become unreadable because of one field), and a `sha256:` prefix
                      // with 128 hex characters is a sha512 digest wearing the wrong name — it can
                      // never match a registry manifest.
                      // FR-1.5: the hint used to open with the id — "FR-1.5: this digest is what a
                      // deployment pins; the tag is for humans." Requirement ids stay in source.
                      hint: /^sha256:[0-9a-f]{64}$/.test(data.imageDigest)
                        ? 'This digest is what a deployment pins; the tag is for humans.'
                        : 'Not a sha256:<64 hex> digest: a deployment cannot pull this image by digest until the entry is reconciled with the registry.',
                    },
                    { label: 'Dependencies', value: data.dependencies.join(', ') || 'None' },
                    { label: 'Owner', value: `${data.owner.name} · ${data.owner.team}` },
                    { label: 'Verified', value: formatDateTime(data.verifiedAt) },
                  ]}
                />
              </div>
            </Panel>

            <div className="space-y-3">
              <Panel>
                <PanelHeader eyebrow="Sizing" title="Default resource shape" />
                <Grid cols={3} className="gap-2 p-4">
                  {[
                    { label: 'CPU', value: `${data.resources.cpu} vCPU` },
                    { label: 'Memory', value: `${(data.resources.memoryMb / 1024).toFixed(1)} GB` },
                    { label: 'Disk', value: `${(data.resources.diskMb / 1024).toFixed(0)} GB` },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-sm border border-line bg-panel-soft p-2.5"
                    >
                      <p className="text-faint label-caps-sans">{item.label}</p>
                      <p className="mt-0.5 font-display text-title font-semibold text-text">
                        {item.value}
                      </p>
                    </div>
                  ))}
                </Grid>
                <div className="border-t border-line px-4 py-2.5">
                  <p className="text-faint label-caps-sans">Volumes</p>
                  <ul className="mt-1 space-y-0.5">
                    {data.volumes.map((volume) => (
                      <li
                        key={volume.name}
                        className="flex items-baseline justify-between gap-2 text-meta"
                      >
                        <span className="font-mono text-muted">{volume.name}</span>
                        <span className="text-faint">{volume.mountPath}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>

              {data.deviation ? (
                <Callout tone="caution" title="Recorded deviation">
                  {data.deviation}
                </Callout>
              ) : null}
              <Callout tone="info" title="Operator note">
                {data.notes}
              </Callout>
            </div>
          </SplitLayout>

          <Panel className="mt-3">
            {/* FR-2.12 · FR-2.14 — requirement ids, developer-only; they used to be the panel
                eyebrow. */}
            <PanelHeader
              title="Upstream release state and credential granularity"
              description="Release and advisory state is tracked per entry. Credential granularity decides whether write workflows are allowed against this product."
            />
            <SplitLayout ratio="rail" className="gap-4 p-4">
              <DefinitionList
                columns={1}
                items={[
                  { label: 'Current version', value: data.upstream.currentVersion, mono: true },
                  {
                    label: 'Latest upstream release',
                    value:
                      data.upstream.latestVersion === data.upstream.currentVersion
                        ? `${data.upstream.latestVersion} (up to date)`
                        : `${data.upstream.latestVersion} (update available)`,
                    mono: true,
                  },
                  {
                    label: 'Open security advisory',
                    value: data.upstream.advisory ?? 'None recorded',
                    ...(data.upstream.advisory === null
                      ? {}
                      : { hint: 'Tracked in the patch register until it is remediated.' }),
                  },
                  { label: 'Release notes', value: data.upstream.releaseUrl, mono: true },
                  { label: 'Checked', value: formatDateTime(data.upstream.checkedAt) },
                ]}
              />

              <div className="space-y-2">
                <Field
                  label="Credential granularity"
                  htmlFor="granularity"
                  hint="A product that cannot issue scoped credentials is write-workflow-ineligible (C-11)."
                >
                  {/* FR-2.14 is a mutating administrator action, so the control follows `canMutate`:
                      a `scoped` grant renders the field read-only rather than letting the operator
                      submit a change the policy would refuse. The option list comes from the domain
                      so the wording cannot drift from the rule it describes. */}
                  <Select
                    id="granularity"
                    value={granularity}
                    disabled={!canMutate(session.role, 'metadata.manage')}
                    onChange={(event) =>
                      setGranularity(event.target.value as CredentialGranularity)
                    }
                  >
                    {CREDENTIAL_GRANULARITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* The verdict, not the label: an operator changing `scoped` to `account` needs to
                    see that it makes the product write-ineligible *before* submitting. */}
                {isWriteEligible(granularity) ? null : (
                  <Callout
                    tone={granularity === 'none' ? 'danger' : 'caution'}
                    title="Write-ineligible"
                  >
                    {writeIneligibilityReason(granularity)}
                  </Callout>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canMutate(session.role, 'metadata.manage') || verify.isPending}
                  onClick={() =>
                    verify.mutate({
                      credentialGranularity: granularity,
                      sessionMaxMinutes: data.integration.sessionMaxMinutes,
                    })
                  }
                >
                  {verify.isPending ? 'Recording…' : 'Record verified review'}
                </Button>
                {granularityState !== null &&
                granularityState !== data.integration.credentialGranularity ? (
                  <InlineNote>
                    Unrecorded change: the catalog still holds{' '}
                    <span className="font-mono">{data.integration.credentialGranularity}</span>.
                  </InlineNote>
                ) : null}
                <InlineNote>
                  Verification restarts the staleness clock and writes an audit record. Lowering the
                  granularity below operation-scoped revokes the live write scopes it invalidates,
                  in the same transaction.
                </InlineNote>
              </div>
            </SplitLayout>
          </Panel>
        </TabPanel>

        <TabPanel value="integration" className="pt-3">
          <IntegrationTab entry={data} />
        </TabPanel>

        <TabPanel value="env" className="pt-3">
          <EnvTab entryKey={data.key} query={envSchema} />
        </TabPanel>

        {scaffoldEnabled ? (
          <TabPanel value="scaffold" className="pt-3">
            <ScaffoldTab
              query={scaffold}
              confirming={confirmScaffold.isPending}
              confirmError={confirmScaffold.error}
              onConfirm={(draftId) => confirmScaffold.mutate(draftId)}
            />
          </TabPanel>
        ) : null}
      </Tabs>
    </Page>
  );
}
