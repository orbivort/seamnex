import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useImageScanReport, useImages } from '@seamnex/api-client';
import type { ImageScanSummary, InstanceDetail, ScanSeverity } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Drawer,
  EmptyState,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';

/**
 * NFR-4.6 / S-10 — what was scanned, what it found, and what stopped a deploy.
 *
 * The tab's whole job is to keep four states apart, because collapsing any two of them is the defect
 * the review named: `passed` (scanned, nothing blocking), `blocked` (scanned, a blocking severity
 * found, apply refused), `error` (the scanner could not finish — *not* a pass), and no report at all
 * (never scanned). The verdict comes from the image list, so the tab costs one request; findings are
 * fetched only for the image whose drawer is open.
 */
/** The four rated severities; `unknown` is a scanner state, not a finding to count. */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/** One glyph per severity keeps the four counts readable at `text-micro` in a dense row. */
const SEVERITY_INITIAL: Readonly<Record<(typeof SEVERITY_ORDER)[number], string>> = {
  critical: 'C',
  high: 'H',
  medium: 'M',
  low: 'L',
};

export function ImageSecurityTab({ instance }: { instance: InstanceDetail }) {
  const images = useImages(instance.id);
  const [openDigest, setOpenDigest] = useState<string | null>(null);

  return (
    <Panel>
      <PanelHeader
        eyebrow="NFR-4.6"
        title="Image security"
        description="Every image is scanned after it is pulled or built and before its containers start. A blocking severity stops the deploy and is audited."
      />
      <AsyncPanel
        query={images}
        loading={
          <div className="p-4">
            <SkeletonLines lines={5} />
          </div>
        }
        loadingLabel="Loading the scanned images"
      >
        {(data) =>
          data.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert />}
              title="No image has been recorded for this instance"
              description="The scan runs during apply, so an instance that has never been deployed has nothing to scan yet."
            />
          ) : (
            <div className="divide-y divide-line">
              {data.map((image) => (
                <ImageRow
                  key={image.digest}
                  version={image.version}
                  digest={image.digest}
                  stateLabel={image.state}
                  scan={image.scan ?? null}
                  onOpen={() => setOpenDigest(image.digest)}
                />
              ))}
            </div>
          )
        }
      </AsyncPanel>

      <Drawer
        open={openDigest !== null}
        onOpenChange={(open) => (open ? undefined : setOpenDigest(null))}
        title="Findings for this image"
        description="Severity is the scanner's own rating. A fix version of “none” means upstream has not published one."
        width="lg"
      >
        {/*
          Mounted only while open, which is also when the query is enabled: a drawer that fetched on
          mount would pull every finding for every image to render a table of counts.
        */}
        <FindingsPane instanceId={instance.id} digest={openDigest} />
      </Drawer>
    </Panel>
  );
}

function ImageRow({
  version,
  digest,
  stateLabel,
  scan,
  onOpen,
}: {
  version: string;
  digest: string;
  stateLabel: string;
  scan: ImageScanSummary | null;
  onOpen: () => void;
}) {
  const verdict = verdictOf(scan);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-meta font-medium text-text">{version}</span>
          <Badge tone="neutral" size="sm">
            {stateLabel}
          </Badge>
          <StatusPill tone={verdict.tone} label={verdict.label} size="sm" />
        </div>
        <p className="mt-1 truncate font-mono text-micro text-faint" title={digest}>
          {digest}
        </p>
        <p className="mt-0.5 text-micro text-faint">
          {scan === null
            ? 'Never scanned: no report is retained for this digest.'
            : `Scanned ${formatRelative(scan.scannedAt)} with ${scan.scanner} ${scan.scannerVersion}.`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        {scan === null ? null : <SeverityCounts counts={scan.severityCounts} />}
        <Button variant="ghost" size="sm" onClick={onOpen} disabled={scan === null}>
          {scan === null ? 'No report' : 'Findings'}
        </Button>
      </div>
    </div>
  );
}

/** Four counts, not a total: 30 medium findings and 2 critical ones are different situations. */
function SeverityCounts({ counts }: { counts: ImageScanSummary['severityCounts'] }) {
  return (
    <div className="flex items-center gap-1.5">
      {SEVERITY_ORDER.map((severity) => (
        <span
          key={severity}
          className={
            counts[severity] === 0
              ? 'rounded-sm border border-line px-1.5 py-0.5 font-mono text-micro text-faint'
              : severity === 'critical' || severity === 'high'
                ? 'rounded-sm border border-danger-border bg-danger-soft px-1.5 py-0.5 font-mono text-micro font-semibold text-danger-strong'
                : 'rounded-sm border border-warning-border bg-warning-soft px-1.5 py-0.5 font-mono text-micro text-warning-strong'
          }
          title={`${counts[severity]} ${severity}`}
        >
          {SEVERITY_INITIAL[severity]} {counts[severity]}
        </span>
      ))}
    </div>
  );
}

const findingColumns = defineColumns<{
  id: string;
  package: string;
  installedVersion: string;
  fixedVersion: string | null;
  severity: ScanSeverity;
  title: string;
  url: string | null;
}>([
  {
    id: 'package',
    header: 'Package',
    primary: true,
    mono: true,
    cell: (row) => row.package,
  },
  {
    id: 'installed',
    header: 'Installed',
    mono: true,
    cell: (row) => row.installedVersion,
  },
  {
    id: 'fixed',
    header: 'Fixed in',
    mono: true,
    cell: (row) => row.fixedVersion ?? <span className="text-faint">none published</span>,
  },
  {
    id: 'severity',
    header: 'Severity',
    cell: (row) => (
      <Badge tone={row.severity === 'critical' ? 'danger' : 'caution'} size="sm">
        {row.severity}
      </Badge>
    ),
  },
  {
    id: 'advisory',
    header: 'Advisory',
    cell: (row) =>
      row.url === null ? (
        <span className="font-mono text-micro text-muted">{row.id}</span>
      ) : (
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono text-micro text-link hover:underline"
        >
          {row.id}
        </a>
      ),
  },
]);

function FindingsPane({ instanceId, digest }: { instanceId: string; digest: string | null }) {
  const report = useImageScanReport(instanceId, digest);
  return (
    <AsyncPanel
      query={report}
      loading={<SkeletonLines lines={8} />}
      loadingLabel="Loading the scan findings"
    >
      {(data) =>
        data.findings.length === 0 ? (
          <p className="text-body text-muted">
            The retained report holds no individual findings; the severity counts are the whole
            result.
          </p>
        ) : (
          <div className="space-y-3">
            {data.verdict === 'blocked' ? (
              <Callout tone="danger" title="This image blocked a deployment">
                The apply was refused because {data.blockingSeverities.join(', ')} findings are
                present. The refusal is in the audit trail as `deployment.image_scan.blocked`.
              </Callout>
            ) : null}
            <DataTable
              columns={findingColumns}
              rows={data.findings}
              rowKey={(row) => row.id}
              dense
              caption="Findings in the retained report, with the version that fixes each one."
            />
          </div>
        )
      }
    </AsyncPanel>
  );
}

function verdictOf(scan: ImageScanSummary | null): {
  tone: 'positive' | 'danger' | 'caution' | 'neutral';
  label: string;
} {
  if (scan === null) return { tone: 'neutral', label: 'never scanned' };
  if (scan.verdict === 'passed') return { tone: 'positive', label: 'passed' };
  if (scan.verdict === 'blocked') return { tone: 'danger', label: 'blocked' };
  // `error` is a scanner that did not finish. Rendering it as anything but a caution is how "we
  // could not check" becomes "we checked and it was fine".
  return { tone: 'caution', label: 'scan failed' };
}
