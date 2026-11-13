import { http, HttpResponse } from 'msw';
import type { Backup, PlatformRestoreRun, RestoreDrill } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { RECOVERY_CONTENTS } from '../fixtures/recovery';
import { buildRestorePhases, startPlatformRestore } from '../recovery-simulator';
import { appendAudit, getState } from '../store';
import { BACKUP_STEPS, enqueueJob } from './job-factory';
import { actorFor, problem, readBody, requireCapability, roleOf } from './utils';

const GB = 1024 ** 3;

export const recoveryHandlers = [
  http.get('/api/v1/recovery', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'recovery.view');
    if (guard) return guard;
    const state = getState();
    const runs = [...state.recovery.runs].sort(
      (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
    );
    const lastBackup = state.recovery.backups.reduce<Backup | null>(
      (latest, backup) =>
        latest === null || Date.parse(backup.startedAt) > Date.parse(latest.startedAt)
          ? backup
          : latest,
      null,
    );
    const lastVerified =
      runs.find((run) => run.state === 'succeeded' && run.loginVerifiedAt !== null) ?? null;
    return HttpResponse.json({
      generatedAt: at(0),
      backups: state.recovery.backups,
      runs,
      drills: state.recovery.drills,
      gate: state.recovery.gate,
      contents: RECOVERY_CONTENTS,
      lastBackupAt: lastBackup?.startedAt ?? null,
      lastVerifiedRestoreAt: lastVerified?.finishedAt ?? null,
    });
  }),

  http.post('/api/v1/recovery/backups', ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'recovery.manage');
    if (guard) return guard;
    const state = getState();
    const backup: Backup = {
      id: `bkp-platform-${1023 + state.recovery.backups.length}`,
      kind: 'platform',
      instanceId: null,
      instanceLabel: 'Platform state (including IdP realm)',
      state: 'succeeded',
      startedAt: at(0),
      finishedAt: at(0),
      sizeBytes: Math.round(2.4 * GB),
      objectKey: `s3://seamnex-backups/platform/2026/10/22/platform-state-${state.recovery.backups.length + 1}.tar.zst.age`,
      includes: RECOVERY_CONTENTS.filter((item) => item.included).map((item) => item.label),
      verifiedAt: null,
      verifyMethod: null,
      renderSetId: 'rs-platform-183',
    };
    state.recovery.backups = [backup, ...state.recovery.backups];
    const accepted = enqueueJob({
      kind: 'backup',
      instanceId: null,
      entryKey: null,
      label: `Platform state backup ${backup.id}`,
      requestedBy: 'Sofia Almeida',
      summary: 'Capture the platform state, including the identity-provider realm.',
      steps: BACKUP_STEPS,
    });
    appendAudit({
      action: 'platform.backup.created',
      targetType: 'platform',
      targetId: backup.id,
      targetLabel: 'Platform state backup',
      outcome: 'success',
      detail: `Entitlements, audit, job history, workflow IR, keys, TLS material and the identity-provider realm queued as job ${accepted.jobId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  http.post('/api/v1/recovery/restores', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'recovery.manage');
    if (guard) return guard;
    const state = getState();
    const body = await readBody<{ backupId?: string; justification?: string }>(request);
    const backup = state.recovery.backups.find((item) => item.id === body.backupId);
    if (!backup) {
      return problem(
        422,
        'BACKUP_NOT_FOUND',
        'Choose a platform-state backup',
        `No platform backup matches "${body.backupId ?? ''}".`,
        'Select a backup from the register.',
        [{ field: 'backupId', code: 'required', message: 'A platform-state backup is required.' }],
      );
    }
    const justification = (body.justification ?? '').trim();
    if (justification.length < 20) {
      return problem(
        422,
        'JUSTIFICATION_REQUIRED',
        'A written justification is required',
        'A platform restore is a recovery event; it needs a recorded reason and a witness.',
        'Describe the incident, the scope and the expected outcome.',
        [{ field: 'justification', code: 'minLength', message: 'At least 20 characters.' }],
      );
    }
    const run: PlatformRestoreRun = {
      id: `rst-${130 + state.recovery.runs.length}`,
      backupId: backup.id,
      kind: 'platform',
      phase: 'preparing',
      state: 'running',
      startedAt: at(0),
      finishedAt: null,
      loginVerifiedAt: null,
      concurrency: Math.max(4, state.settings.restoreConcurrency),
      failedReason: null,
      justification,
      requestedBy: actorFor(role).name,
      routesUnpublishedUntilLogin: true,
      phases: buildRestorePhases(),
    };
    state.recovery.runs = [run, ...state.recovery.runs];
    startPlatformRestore(run.id);
    const accepted = enqueueJob({
      kind: 'restore',
      instanceId: null,
      entryKey: null,
      label: `Platform restore ${run.id}`,
      requestedBy: 'Sofia Almeida',
      summary:
        'Restore the identity provider first, the control plane second, then products in parallel.',
      steps: [
        'Restore identity provider',
        'Restore control plane',
        'Verify administrative login',
        'Restore products',
      ],
    });
    appendAudit({
      action: 'platform.restore.started',
      targetType: 'platform',
      targetId: run.id,
      targetLabel: 'Platform-state restore',
      outcome: 'success',
      detail: `Restore from ${backup.id} accepted as job ${accepted.jobId}; routes unpublished until the administrative login succeeds. Justification recorded.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  http.post('/api/v1/restore-drills', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'recovery.manage');
    if (guard) return guard;
    const state = getState();
    const body = await readBody<{ instanceId?: string }>(request);
    const instance = state.instances.find((item) => item.id === body.instanceId);
    if (!instance) {
      return problem(
        422,
        'INSTANCE_NOT_FOUND',
        'Choose an instance',
        'A drill targets one deployed instance.',
        'Select an instance from the fleet.',
        [{ field: 'instanceId', code: 'required', message: 'An instance is required.' }],
      );
    }
    const drill: RestoreDrill = {
      id: `drill-${instance.slug}-${state.recovery.drills.length + 1}`,
      instanceId: instance.id,
      instanceLabel: `${instance.entryKey} ${instance.product}`,
      performedAt: at(0),
      smokeTest:
        instance.entryKey === 'D08-01'
          ? 'Document count matches the manifest (±0)'
          : instance.entryKey === 'D03-01'
            ? 'Ticket count and SLA clock state match'
            : 'Admin login and record count within tolerance',
      passed: true,
      evidenceUrl: `https://evidence.seamnex.local/restore-drills/${instance.slug}-${state.recovery.drills.length + 1}`,
    };
    state.recovery.drills = [drill, ...state.recovery.drills];
    instance.backup.verified = true;
    instance.backup.lastVerifiedRestoreAt = drill.performedAt;
    appendAudit({
      action: 'restore.drill.completed',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: `Restore drill passed: ${drill.smokeTest}. Evidence recorded at ${drill.evidenceUrl}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(drill, { status: 201 });
  }),
];
