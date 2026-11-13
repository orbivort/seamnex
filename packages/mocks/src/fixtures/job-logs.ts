import type { Job, JobLogLine } from '@seamnex/domain';
import { at } from './context';

const LINES_BY_KIND: Record<string, string[]> = {
  deploy: [
    'resolved source path=compose revision=%REV%',
    'render set hash=sha256:8f2c… applied',
    'creating network seamnex-inst-%SLUG% (internal)',
    'pulling image %IMAGE%',
    'container web started; publishing expose only (zero published ports)',
    'health probe GET http://web:8080/ -> 200 in 412 ms',
  ],
  upgrade: [
    'pre-upgrade backup bkp-%SLUG% created',
    'image %IMAGE% pulled and pinned',
    'recreating service web with the new digest',
    'health probe GET http://web:8080/ -> 503 (attempt 1/3)',
    'health probe GET http://web:8080/ -> 503 (attempt 2/3)',
  ],
  rollback: [
    'restoring render set sha256:41ab…',
    'starting previous image %IMAGE%',
    'health probe GET http://web:8080/ -> 200 in 388 ms',
  ],
  backup: [
    'engine dump started (transactional snapshot)',
    'dump complete: 1.8 GB',
    'volume archive created: media.tar.zst (6.4 GB)',
    'encrypting with age recipient platform-backup',
    'upload complete: s3://seamnex-backups/%SLUG%',
  ],
  restore: [
    'scratch stack created: seamnex-restore-%SLUG%',
    'database restored from dump',
    'volume archive extracted',
    'smoke test passed: document count matches manifest',
  ],
  stop: [
    'stopping service worker',
    'stopping service web',
    'route %SLUG%.seamnex.local unpublished',
  ],
  start: [
    'starting service db',
    'starting service web',
    'health probe GET http://web:8080/ -> 200 in 502 ms',
  ],
  restart: [
    'recreate requested: two environment values changed',
    'DB_PASSWORD=•••••••• (masked)',
    'NEXTCLOUD_TRUSTED_DOMAINS resolved from catalog default',
    'service web recreated',
  ],
  delete: [
    'data retention choice=export',
    'archive written to the backup target',
    'resources removed',
  ],
  export: ['portable archive created', 'manifest written: export-%SLUG%.json'],
  prepull: ['pre-pulling layers for %IMAGE%', 'layers cached'],
  scaffold: [
    'generating compose.yaml',
    'validating policy: no published ports',
    'committing draft to catalog repository',
  ],
};

function substitute(line: string, job: Job): string {
  const slug = job.instanceId ? job.instanceId.replace('inst-', '') : 'platform';
  return line
    .replaceAll('%SLUG%', slug)
    .replaceAll('%REV%', '9c2f1ab')
    .replaceAll('%IMAGE%', `${job.entryKey ?? 'platform'}:pinned@sha256:4f9a…`);
}

/** Deterministic log projection for historical and simulated jobs. */
export function logsForJob(job: Job): JobLogLine[] {
  const templates = LINES_BY_KIND[job.kind] ?? LINES_BY_KIND.deploy ?? [];
  const lines: JobLogLine[] = [];
  const startedMs = Date.parse(job.startedAt ?? job.createdAt);

  for (const step of job.steps) {
    if (step.state === 'pending') continue;
    const ts = step.startedAt ?? new Date(startedMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    lines.push({ seq: lines.length, ts, stream: 'system', line: `==> ${step.name}` });
    if (step.message) {
      lines.push({ seq: lines.length, ts, stream: 'stdout', line: step.message });
    }
    const template = templates[(step.seq - 1) % Math.max(templates.length, 1)];
    if (template) {
      lines.push({
        seq: lines.length,
        ts,
        stream: step.state === 'failed' ? 'stderr' : 'stdout',
        line: substitute(template, job),
      });
    }
  }

  if (job.errorMessage) {
    lines.push({
      seq: lines.length,
      ts: job.finishedAt ?? at(-1),
      stream: 'stderr',
      line: `error: ${job.errorCode} ${job.errorMessage}`,
    });
  }

  return lines;
}
