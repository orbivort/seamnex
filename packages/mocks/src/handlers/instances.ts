import { http, HttpResponse } from 'msw';
import type { Backup, JobKind } from '@seamnex/domain';
import { admissionVerdict } from '@seamnex/domain';
import { CAPACITY_HOST, CAPACITY_RESERVE } from '../fixtures/capacity';
import { at } from '../fixtures/context';
import { resolveEnv } from '../fixtures/env-plan';
import { provisionInstance } from '../fixtures/provision';
import { appendAudit, getState, refreshCapacity } from '../store';
import { BACKUP_STEPS, DEPLOY_STEPS, LIFECYCLE_STEPS, enqueueJob } from './job-factory';
import { actorFor, deny, problem, readBody, requireCapability, roleOf } from './utils';

type DataRetention = 'keep' | 'export' | 'delete';

/**
 * Versions of the stored administrator token per instance, demo-only. A real deployment stores the
 * value in the secret store and reports the version; the demo has no secret store to write to.
 */
const adminCredentials = new Map<string, number>();

/** The provisioning shape of each demo entry, mirroring `ProductApiAdapters` in the API. */
function provisioningKind(entryKey: string): 'bearer' | 'password' | 'none' {
  if (entryKey === 'D09-01') return 'bearer';
  if (entryKey === 'D07-01') return 'password';
  return 'none';
}

export const instanceHandlers = [
  http.get('/api/v1/instances', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const entryKey = url.searchParams.get('entryKey');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = getState().instances.filter((instance) => {
      const matchesState = !state || instance.state === state;
      const matchesEntry = !entryKey || instance.entryKeys.includes(entryKey);
      const matchesQuery =
        q === '' ||
        instance.product.toLowerCase().includes(q) ||
        instance.domain.toLowerCase().includes(q) ||
        instance.slug.includes(q);
      return matchesState && matchesEntry && matchesQuery;
    });
    return HttpResponse.json(items);
  }),

  http.get('/api/v1/instances/:id', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const id = String(params.id);
    const state = getState();
    const instance = state.instances.find((item) => item.id === id || item.slug === id);
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        `No instance matches ${id}.`,
        'Refresh the instance list.',
      );
    }
    const detail = state.instanceDetails[instance.id];
    return HttpResponse.json({ ...detail, ...instance });
  }),

  http.get('/api/v1/instances/:id/status', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const id = String(params.id);
    const instance = getState().instances.find((item) => item.id === id || item.slug === id);
    const status = instance ? getState().statuses[instance.id] : undefined;
    if (!instance || !status) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        `No status for ${id}.`,
        'Refresh the instance list.',
      );
    }
    const refresh = new URL(request.url).searchParams.get('refresh') === 'true';
    if (refresh) {
      status.observedAt = at(0);
      status.source = 'manual';
      instance.observedAt = status.observedAt;
      instance.statusSource = 'manual';
    }
    return HttpResponse.json(status);
  }),

  http.get('/api/v1/instances/:id/containers', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    return HttpResponse.json(getState().containers[instance.id] ?? []);
  }),

  http.get('/api/v1/instances/:id/env', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.env');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    return HttpResponse.json(getState().envValues[instance.id] ?? []);
  }),

  http.put('/api/v1/instances/:id/env', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'instance.env');
    if (guard) return guard;
    const body = await readBody<{ values: Record<string, string> }>(request);
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const changed = new Set(Object.keys(body.values));
    const plan = resolveEnv(instance.entryKey, instance.profileKey, body.values);
    const relevant = plan.fieldErrors.filter(
      (item) => changed.has(item.field) || [...changed].some((name) => item.message.includes(name)),
    );
    if (relevant.length > 0) {
      return problem(
        422,
        'ENV_INVALID',
        'The environment change did not pass validation',
        `${relevant.length} declared variable(s) cannot be set this way.`,
        'Fix the flagged fields, or change the value in the environment profile instead.',
        relevant,
      );
    }
    const values = getState().envValues[instance.id] ?? [];
    const diff = Object.entries(body.values).flatMap(([name, value]) => {
      const target = values.find((item) => item.name === name);
      if (!target) return [];
      const changed = target.secret ? value !== '••••••••' : target.value !== value;
      if (!changed) return [];
      const from = target.value;
      target.value = target.secret ? '••••••••' : value;
      target.source = 'instance';
      return [
        {
          name,
          from,
          to: target.secret ? '••••••••' : value,
          requiresRecreate: target.requiresRecreate,
        },
      ];
    });
    const requiresRecreate = diff.some((item) => item.requiresRecreate);
    appendAudit({
      action: 'instance.env.changed',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail:
        diff.length > 0
          ? `${diff.map((item) => item.name).join(', ')} changed; ${requiresRecreate ? 'recreate' : 'restart'} required to apply.`
          : 'Environment submitted with no effective change.',
      actor: actorFor(role),
    });
    return HttpResponse.json({
      diff,
      requiresRecreate,
      applied: false,
      note: requiresRecreate
        ? 'Changes apply only after the instance is recreated. A restart is not sufficient.'
        : 'Changes apply on the next restart.',
    });
  }),

  /*
   * ADR-BE-22 §Credentials. The token is never part of a response: the demo mirrors the API's
   * write-only contract, so a screen that expected the value back would fail here too.
   */
  http.get('/api/v1/instances/:id/admin-credential', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.env');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const kind = provisioningKind(instance.entryKey);
    const version = adminCredentials.get(instance.id);
    return HttpResponse.json({
      kind,
      required: kind === 'bearer',
      configured: kind === 'bearer' && version !== undefined,
      name: 'product_api_token',
      version: kind === 'bearer' ? (version ?? null) : null,
    });
  }),

  http.put('/api/v1/instances/:id/admin-credential', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'instance.env');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const kind = provisioningKind(instance.entryKey);
    if (kind !== 'bearer') {
      return problem(
        422,
        'ADMIN_CREDENTIAL_NOT_APPLICABLE',
        'This entry does not provision with an API token',
        `${instance.entryKey} provisions with its administrator login, or has no adapter.`,
        'Change the administrator variables instead; no token is read for this product.',
      );
    }
    const body = await readBody<{ token: string }>(request);
    if (typeof body.token !== 'string' || body.token.trim().length < 8) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The token is too short',
        'A token must be at least 8 characters.',
        'Paste the value the product issued, without surrounding whitespace.',
      );
    }
    const version = (adminCredentials.get(instance.id) ?? 0) + 1;
    adminCredentials.set(instance.id, version);
    appendAudit({
      action: 'instance.admin_credential.updated',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: `Administrator token stored as version ${version}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json({
      kind,
      required: true,
      configured: true,
      name: 'product_api_token',
      version,
    });
  }),

  /*
   * ADR-BE-22: the on-demand pass. The demo has no products to create accounts in, so it answers
   * what a healthy deployment would — one person, provisioned — and records the click, because a
   * button whose only effect is a count with no evidence is the thing this route replaced.
   */
  http.post('/api/v1/instances/:id/relay/provision', ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'instance.env');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const configured = provisioningKind(instance.entryKey) !== 'none';
    const provisioned = configured ? 1 : 0;
    appendAudit({
      action: 'relay.account.provisioned',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: configured
        ? 'On-demand pass: 1 account created or refreshed.'
        : 'No provisioning adapter is registered for this entry; nothing was attempted.',
      actor: actorFor(role),
    });
    return HttpResponse.json({
      instanceId: instance.id,
      enabled: true,
      configured,
      considered: provisioned,
      provisioned,
      failed: 0,
    });
  }),

  http.get('/api/v1/instances/:id/drift', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    return HttpResponse.json(getState().drift[instance.id] ?? []);
  }),

  http.get('/api/v1/instances/:id/backups', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    return HttpResponse.json(
      getState().backups.filter((backup) => backup.instanceId === instance.id),
    );
  }),

  http.get('/api/v1/instances/:id/containers/:cid/logs', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const service = String(params.cid).replace('ctr-', '').replace(`${instance.id}-`, '');
    const lines = [
      `container ${service} starting (image pinned by digest)`,
      'environment resolved from catalog default → profile → instance',
      'DB_PASSWORD=•••••••• (masked by the platform)',
      'listening on internal address, expose only',
      'health probe GET / -> 200',
      'request handled in 42 ms',
    ];
    return HttpResponse.json(
      lines.map((line, index) => ({
        seq: index,
        ts: at(-6 + index * 0.4),
        stream: 'stdout' as const,
        line,
      })),
    );
  }),

  http.post('/api/v1/instances/:id/backups', ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'instance.backup');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const backup: Backup = {
      id: `bkp-${instance.slug}-${getState().backups.length + 1}`,
      kind: 'instance',
      instanceId: instance.id,
      instanceLabel: `${instance.entryKey} ${instance.product}`,
      state: 'running',
      startedAt: at(0),
      finishedAt: null,
      sizeBytes: 0,
      objectKey: `s3://seamnex-backups/${instance.slug}/manual-${getState().backups.length + 1}.tar.zst.age`,
      includes: ['database dump (transactional)', 'volume capture', 'render set manifest'],
      verifiedAt: null,
      verifyMethod: null,
      renderSetId: `rs-${instance.slug}-manual`,
    };
    getState().backups = [backup, ...getState().backups];
    const accepted = enqueueJob({
      kind: 'backup',
      instanceId: instance.id,
      entryKey: instance.entryKey,
      label: `Backup ${instance.entryKey} ${instance.product}`,
      requestedBy: 'Sofia Almeida',
      summary: 'On-demand backup requested by an operator.',
      steps: BACKUP_STEPS,
    });
    appendAudit({
      action: 'backup.requested',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: `On-demand backup ${backup.id} accepted; job ${accepted.jobId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  /** FR-1.12: the schedule is editable; the change is audited like any other configuration. */
  http.put('/api/v1/instances/:id/backup-schedule', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'backup schedule');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const body = await readBody<{ schedule?: string; timezone?: string; enabled?: boolean }>(
      request,
    );
    const schedule = (body.schedule ?? '').trim();
    if (schedule.length < 3) {
      return problem(
        422,
        'SCHEDULE_INVALID',
        'A schedule is required',
        'The cadence must be at least three characters.',
        'Use a form such as "Daily 02:00".',
        [
          {
            field: 'schedule',
            code: 'required',
            message: 'Describe the cadence, e.g. "Daily 02:00".',
          },
        ],
      );
    }
    const timezone = (body.timezone ?? '').trim();
    if (!/^[A-Za-z]+\/[A-Za-z_]+$/.test(timezone) && timezone !== 'UTC') {
      return problem(
        422,
        'TIMEZONE_INVALID',
        'Unknown timezone',
        'Use an IANA zone such as Europe/Berlin.',
        'Pick the zone the schedule is expressed in.',
        [
          {
            field: 'timezone',
            code: 'format',
            message: 'Expected an IANA zone, e.g. Europe/Berlin.',
          },
        ],
      );
    }
    const previous = instance.backup.schedule;
    instance.backup.schedule = schedule;
    instance.backup.scheduleTimezone = timezone;
    instance.backup.scheduleEnabled = body.enabled ?? true;
    appendAudit({
      action: 'backup.schedule.changed',
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail: `Backup schedule changed from "${previous}" to "${schedule}" (${timezone}); ${instance.backup.scheduleEnabled ? 'enabled' : 'disabled'}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(instance.backup);
  }),

  http.post('/api/v1/backups/:id/verify', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'instance.backup verify');
    if (guard) return guard;
    const backup = getState().backups.find((item) => item.id === String(params.id));
    if (!backup) {
      return problem(
        404,
        'BACKUP_NOT_FOUND',
        'Backup not found',
        'The backup set no longer exists.',
        'Refresh the backup list.',
      );
    }
    backup.verifiedAt = at(0);
    backup.verifyMethod = 'scratch-stack smoke test';
    const instance = getState().instances.find((item) => item.id === backup.instanceId);
    if (instance) instance.backup.verified = true;
    const accepted = enqueueJob({
      kind: 'backup',
      instanceId: backup.instanceId,
      entryKey: instance?.entryKey ?? null,
      label: `Verify ${backup.id}`,
      requestedBy: 'Sofia Almeida',
      summary: 'Scratch-stack verification of a backup artefact.',
      steps: BACKUP_STEPS,
    });
    appendAudit({
      action: 'backup.verified',
      targetType: 'backup',
      targetId: backup.id,
      targetLabel: backup.instanceLabel,
      outcome: 'success',
      detail: 'Scratch-stack restore passed; the verified timestamp is recorded on the instance.',
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  http.post('/api/v1/backups/:id/restore', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'instance.restore');
    if (guard) return guard;
    const backup = getState().backups.find((item) => item.id === String(params.id));
    if (!backup) {
      return problem(
        404,
        'BACKUP_NOT_FOUND',
        'Backup not found',
        'The backup set no longer exists.',
        'Refresh the backup list.',
      );
    }
    const accepted = enqueueJob({
      kind: 'restore',
      instanceId: backup.instanceId,
      entryKey: null,
      label: `Restore ${backup.id}`,
      requestedBy: 'Sofia Almeida',
      summary: 'Restore a backup on a scratch stack and smoke-test it before republishing routes.',
      steps: ['Restore database', 'Restore volumes', 'Verify administrative login', 'Smoke test'],
    });
    appendAudit({
      action: 'instance.restore',
      targetType: 'backup',
      targetId: backup.id,
      targetLabel: backup.instanceLabel,
      outcome: 'success',
      detail: `Restore of ${backup.id} accepted as job ${accepted.jobId}; routes stay unpublished until the login is verified.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  http.get('/api/v1/instances/:id/images', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    return HttpResponse.json([
      {
        digest: instance.imageDigest,
        version: instance.currentVersion,
        state: 'running',
        builtAt: instance.createdAt,
        artefact: instance.source.path === 'dockerfile' ? 'retained' : 'not-applicable',
      },
      {
        digest: 'sha256:1c7a04e9b25d83f6a0e1c47d92b38f50c6a1d7e4b92f038c6d51e8a04b7c3a91',
        version: instance.availableVersion ?? instance.currentVersion,
        state: 'retained',
        builtAt: at(-14 * 24 * 60),
        artefact: instance.source.path === 'dockerfile' ? 'retained' : 'not-applicable',
      },
    ]);
  }),

  http.get('/api/v1/instances/:id/plan', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.deploy');
    if (guard) return guard;
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the list.',
      );
    }
    const action = new URL(request.url).searchParams.get('action') ?? 'upgrade';
    return HttpResponse.json({
      action,
      instanceId: instance.id,
      from: instance.currentVersion,
      to: instance.availableVersion ?? instance.currentVersion,
      changes: [
        {
          field: 'image.digest',
          from: instance.imageDigest.slice(0, 18),
          to: 'sha256:9d41c7b2e05a…',
        },
        { field: 'database.migration', from: 'none', to: '3 migrations pending' },
      ],
      preUpgradeBackup: true,
      capacityVerdict: {
        admissible: true,
        headline: 'Within host capacity',
        detail: 'No additional reservation required.',
      },
      rollbackAvailable: true,
    });
  }),

  http.post('/api/v1/instances', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'instance.deploy');
    if (guard) return guard;

    const body = await readBody<{
      entryKey?: string;
      slug?: string;
      profile?: string;
      resources?: { cpu: number; memoryMb: number; diskMb: number };
      envOverrides?: Record<string, string>;
    }>(request);

    const state = getState();
    const entry = state.catalog.find((item) => item.key === body.entryKey);
    if (!entry) {
      return problem(
        422,
        'UNKNOWN_CATALOG_ENTRY',
        'Unknown catalog entry',
        `No entry key ${body.entryKey ?? '(missing)'}.`,
        'Select an entry from the catalog.',
        [{ field: 'entryKey', code: 'required', message: 'Choose one of D01-01…D13-01.' }],
      );
    }
    const slug = body.slug ?? '';
    // eslint-disable-next-line security/detect-unsafe-regex -- same DNS-label pattern as `SlugSchema`: single character classes, linear worst case.
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length < 2) {
      return problem(
        422,
        'INVALID_SLUG',
        'Route slug is not valid',
        `"${slug}" is not a valid DNS label.`,
        'Use lower-case letters, digits and dashes, 2–48 characters.',
        [{ field: 'slug', code: 'pattern', message: 'Lower-case alphanumeric with dashes only.' }],
      );
    }
    if (state.instances.some((instance) => instance.slug === slug)) {
      return problem(
        409,
        'SLUG_CONFLICT',
        'Route slug is already in use',
        `${slug}.seamnex.local is bound to another instance.`,
        'Choose a different slug; deleted slugs stay reserved for 30 days.',
        [{ field: 'slug', code: 'conflict', message: 'Slug already bound.' }],
      );
    }
    const pendingException = state.policyExceptions.find(
      (exception) => exception.scope.includes(entry.key) && exception.state === 'requested',
    );
    if (pendingException) {
      return problem(
        409,
        'POLICY_EXCEPTION_PENDING',
        'A compose policy exception is awaiting a second party',
        `${pendingException.id} (${pendingException.rule}) was requested by ${pendingException.requester} and has not been approved.`,
        'The domain owner approves it on Governance → Maintenance & exceptions, then retry the deployment.',
        [
          {
            field: 'policy',
            code: 'exception_pending',
            message: `${pendingException.id} is ${pendingException.state}.`,
          },
        ],
      );
    }

    const profileKey = body.profile ?? 'production';
    const envOverrides = body.envOverrides ?? {};
    const envPlan = resolveEnv(entry.key, profileKey, envOverrides);
    if (envPlan.fieldErrors.length > 0) {
      return problem(
        422,
        'ENV_INVALID',
        'Environment values did not pass validation',
        `${envPlan.fieldErrors.length} declared variable(s) need attention before deployment.`,
        'Fix the flagged fields; resolved values are checked before any container starts.',
        envPlan.fieldErrors,
      );
    }

    const resources = body.resources ?? entry.resources;
    const allocated = state.instances.reduce(
      (total, instance) => ({
        cpu: total.cpu + instance.resources.cpu,
        memoryMb: total.memoryMb + instance.resources.memoryMb,
        diskMb: total.diskMb + instance.resources.diskMb,
      }),
      { cpu: 0, memoryMb: 0, diskMb: 0 },
    );
    const verdict = admissionVerdict({
      host: {
        cpu: CAPACITY_HOST.cpuCores,
        memoryMb: CAPACITY_HOST.memoryMb,
        diskMb: CAPACITY_HOST.diskMb,
      },
      reserve: {
        cpu: CAPACITY_RESERVE.cpuCores,
        memoryMb: CAPACITY_RESERVE.memoryMb,
        diskMb: CAPACITY_RESERVE.diskMb,
      },
      allocated,
      request: resources,
      oversubscriptionFactor: state.settings.oversubscriptionFactor,
    });
    if (!verdict.admissible) {
      return problem(
        422,
        'CAPACITY_INSUFFICIENT',
        'Host capacity would be exceeded',
        `Shortfall: ${verdict.shortfall.join(', ')}. ${verdict.headline}`,
        'Reduce the request or remove an unused instance first.',
        [
          {
            field: 'resources',
            code: 'capacity',
            message: `Not enough ${verdict.shortfall.join(' and ')} against the admission rule.`,
          },
        ],
      );
    }

    const provisioned = provisionInstance({
      entry,
      slug,
      profileKey,
      resources,
      ownerName: 'Sofia Almeida',
      ownerId: 'usr-sofia',
      envOverrides,
    });
    state.instances = [provisioned.instance, ...state.instances];
    state.instanceDetails[provisioned.instance.id] = provisioned.detail;
    state.containers[provisioned.instance.id] = provisioned.containers;
    state.statuses[provisioned.instance.id] = provisioned.status;
    state.envValues[provisioned.instance.id] = provisioned.envValues;
    refreshCapacity(state);

    const accepted = enqueueJob({
      kind: 'deploy',
      instanceId: provisioned.instance.id,
      entryKey: entry.key,
      label: `Deploy ${entry.key} ${entry.product}`,
      requestedBy: 'Sofia Almeida',
      summary: `Deployment of ${entry.product} as ${slug}.seamnex.local from the ${entry.packaging === 'none' ? 'platform scaffold' : entry.packaging} path.`,
      steps: DEPLOY_STEPS,
    });
    appendAudit({
      action: 'instance.deploy',
      targetType: 'instance',
      targetId: provisioned.instance.id,
      targetLabel: `${entry.key} ${entry.product}`,
      outcome: 'success',
      detail: `Deployment accepted as ${slug}.seamnex.local from the ${entry.packaging === 'none' ? 'platform scaffold' : entry.packaging} path; job ${accepted.jobId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  http.post('/api/v1/instances/:id/:action', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'instance.lifecycle');
    if (guard) return guard;
    const action = String(params.action);
    // `reconfigure` is a Must action (FR-1.28) and the executor registers a pipeline for it, so a
    // mock that answers 404 for it made the demo build contradict the product it demonstrates.
    const allowed = [
      'start',
      'stop',
      'restart',
      'reconfigure',
      'upgrade',
      'rollback',
      'delete',
      'export',
    ];
    if (!allowed.includes(action)) {
      return problem(
        404,
        'UNKNOWN_ACTION',
        'Unknown lifecycle action',
        `"${action}" is not a lifecycle operation.`,
        `Use one of ${allowed.join(', ')}.`,
      );
    }
    const instance = getState().instances.find((item) => item.id === String(params.id));
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        'The instance no longer exists.',
        'Refresh the instance list.',
      );
    }
    const body =
      action === 'delete'
        ? await readBody<{ dataRetention?: DataRetention }>(request).catch(
            () => ({}) as { dataRetention?: DataRetention },
          )
        : {};
    const retention: DataRetention = body.dataRetention ?? 'keep';
    const running = instance.state === 'ready' || instance.state === 'degraded';
    const invalid =
      (action === 'stop' || action === 'restart' || action === 'upgrade') && !running
        ? 'The instance must be running for this action.'
        : action === 'start' && instance.state !== 'stopped'
          ? 'Only a stopped instance can be started.'
          : action === 'reconfigure' && instance.state === 'requested'
            ? 'The definition has not been rendered yet; deploy the instance first.'
            : null;
    if (invalid) {
      return problem(
        409,
        'INVALID_STATE',
        `Cannot ${action} from ${instance.state}`,
        invalid,
        'Refresh status; the instance may be mid-transition.',
      );
    }

    const nextState =
      action === 'stop'
        ? 'stopping'
        : action === 'start'
          ? 'starting'
          : action === 'upgrade'
            ? 'upgrading'
            : action === 'rollback'
              ? 'rolling_back'
              : action === 'reconfigure'
                ? 'deploying'
                : action === 'delete'
                  ? 'deleting'
                  : 'restarting';
    instance.state = nextState;
    const status = getState().statuses[instance.id];
    if (status) status.state = instance.state;

    const accepted = enqueueJob({
      kind: action as JobKind,
      instanceId: instance.id,
      entryKey: instance.entryKey,
      label: `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} ${instance.entryKey} ${instance.product}`,
      requestedBy: 'Sofia Almeida',
      summary:
        action === 'delete'
          ? `delete requested for ${instance.slug}.seamnex.local; data retention: ${retention}.`
          : `${action} requested for ${instance.slug}.seamnex.local.`,
      steps: LIFECYCLE_STEPS,
    });
    appendAudit({
      action: `instance.${action}`,
      targetType: 'instance',
      targetId: instance.id,
      targetLabel: `${instance.entryKey} ${instance.product}`,
      outcome: 'success',
      detail:
        action === 'delete'
          ? `Delete accepted with data retention "${retention}"; job ${accepted.jobId}.`
          : `${action} accepted; job ${accepted.jobId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),
];
