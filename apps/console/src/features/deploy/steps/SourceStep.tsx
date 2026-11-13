import type { CatalogEntry, PolicyException } from '@seamnex/domain';
import { PACKAGING_LABELS } from '@seamnex/domain';
import {
  Badge,
  Callout,
  DefinitionList,
  InlineNote,
  Panel,
  PanelHeader,
  SplitLayout,
} from '@seamnex/ui';
import { cn } from '@seamnex/utils';

export function SourceStep({
  entry,
  exception,
}: {
  entry: CatalogEntry;
  exception?: PolicyException | null;
}) {
  const pathLabel = PACKAGING_LABELS[entry.packaging];
  const approved = exception?.state === 'approved';
  const policyVerdict = approved ? (
    <Badge tone="caution" size="sm">
      exception-approved · {exception?.id}
    </Badge>
  ) : (
    <Badge tone="positive" size="sm">
      compliant
    </Badge>
  );
  return (
    <SplitLayout ratio="content">
      <Panel>
        {/* FR-1.17 — requirement id, developer-only; the eyebrow keeps its step number only. */}
        <PanelHeader
          eyebrow="Step 2"
          title="Deployment source resolution"
          description="Precedence is fixed: upstream Compose, then Dockerfile, then a platform scaffold. The path is recorded in the instance definition."
        />
        <div className="p-4">
          <ol className="space-y-3">
            {[
              {
                title: 'Upstream Compose file',
                detail:
                  'Used as immutable input; platform settings go into a generated override file.',
                active: entry.packaging === 'compose',
              },
              {
                title: 'Repository Dockerfile',
                detail: 'Image is built, tagged immutably, and retained for rollback.',
                active: entry.packaging === 'dockerfile',
              },
              {
                title: 'Platform scaffold',
                detail:
                  'Artefacts are generated, reviewed and committed to the catalog repository.',
                active: entry.packaging === 'none',
              },
            ].map((option, index) => (
              <li
                key={option.title}
                className={cn(
                  'flex gap-3 rounded-sm border px-3 py-2.5',
                  option.active
                    ? 'border-primary bg-primary-soft/50'
                    : 'border-line bg-panel-soft opacity-70',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-micro',
                    option.active
                      ? 'border-primary-border bg-primary text-primary-foreground'
                      : 'border-line-strong text-faint',
                  )}
                >
                  {index + 1}
                </span>
                <div>
                  <p className="text-body font-semibold text-text">{option.title}</p>
                  <p className="mt-0.5 text-meta leading-snug text-muted">{option.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Panel>

      <div className="space-y-3">
        <Panel>
          <PanelHeader eyebrow="Resolved" title={pathLabel} />
          <div className="p-4">
            <DefinitionList
              columns={1}
              items={[
                { label: 'Source location', value: entry.packagingSource, mono: true },
                { label: 'Resolved image', value: entry.imageRef, mono: true },
                { label: 'Pinned digest', value: entry.imageDigest, mono: true },
                { label: 'Policy verdict', value: policyVerdict },
              ]}
            />
          </div>
          {exception ? (
            <div className="px-4 pb-4">
              <InlineNote>
                {exception.id} · {exception.rule} ·{' '}
                {exception.state === 'approved'
                  ? `approved by ${exception.approver}`
                  : 'awaiting a second party'}
              </InlineNote>
            </div>
          ) : null}
        </Panel>

        {entry.packaging === 'none' ? (
          <Callout tone="caution" title="Scaffolded entries require an approved draft">
            The generated artefacts were reviewed and committed. Deployment uses the approved
            revision, not a fresh guess.
          </Callout>
        ) : (
          <Callout tone="info" title="Upstream is never edited">
            Your delta is derivable as a diff: the upstream file is retained verbatim beside the
            generated override.
          </Callout>
        )}
      </div>
    </SplitLayout>
  );
}
