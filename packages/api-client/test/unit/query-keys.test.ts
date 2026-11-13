import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../src/query-keys';

/**
 * Query keys are the cache's identity: two different resources sharing a key render one page's
 * data on another, and a key that omits an input keeps a stale answer after that input changes.
 * The factories are asserted on their whole shape for that reason.
 */
describe('queryKeys', () => {
  it('keeps the two portal roots distinct', () => {
    expect(queryKeys.me).toEqual(['me']);
    expect(queryKeys.entitlements).toEqual(['me', 'entitlements']);
    expect(queryKeys.launcher).toEqual(['me', 'launcher']);
    expect(queryKeys.statusBanner).toEqual(['portal', 'status-banner']);
    expect(queryKeys.requestable).toEqual(['portal', 'requestable']);
  });

  it('scopes a per-resource key by id, so one instance never reads another', () => {
    expect(queryKeys.launchTarget('inst-crm')).toEqual(['portal', 'launch-target', 'inst-crm']);
    expect(queryKeys.catalogEntry('D01-01')).toEqual(['catalog', 'D01-01']);
    expect(queryKeys.envSchema('D01-01')).toEqual(['catalog', 'D01-01', 'env-schema']);
    expect(queryKeys.scaffold('D01-01')).toEqual(['catalog', 'D01-01', 'scaffold']);
    expect(queryKeys.instance('inst-crm')).toEqual(['instances', 'inst-crm']);
    expect(queryKeys.instanceStatus('inst-crm')).toEqual(['instances', 'inst-crm', 'status']);
    expect(queryKeys.containers('inst-crm')).toEqual(['instances', 'inst-crm', 'containers']);
    expect(queryKeys.instanceEnv('inst-crm')).toEqual(['instances', 'inst-crm', 'env']);
    expect(queryKeys.adminCredential('inst-crm')).toEqual([
      'instances',
      'inst-crm',
      'admin-credential',
    ]);
    expect(queryKeys.drift('inst-crm')).toEqual(['instances', 'inst-crm', 'drift']);
    expect(queryKeys.instanceBackups('inst-crm')).toEqual(['instances', 'inst-crm', 'backups']);
    expect(queryKeys.images('inst-crm')).toEqual(['instances', 'inst-crm', 'images']);
    expect(queryKeys.job('job-1')).toEqual(['jobs', 'job-1']);
    expect(queryKeys.jobLogs('job-1')).toEqual(['jobs', 'job-1', 'logs']);
    expect(queryKeys.workflow('wf-1')).toEqual(['workflows', 'wf-1']);
    expect(queryKeys.workflowRuns('wf-1')).toEqual(['workflows', 'wf-1', 'runs']);
    expect(queryKeys.workflowNodeFields('wf-1', 'node-1')).toEqual([
      'workflows',
      'wf-1',
      'nodes',
      'node-1',
      'fields',
    ]);
    expect(queryKeys.workflowNodeSample('wf-1', 'node-1')).toEqual([
      'workflows',
      'wf-1',
      'nodes',
      'node-1',
      'sample',
    ]);
    expect(queryKeys.run('run-1')).toEqual(['workflow-runs', 'run-1']);
    expect(queryKeys.auditProof(42)).toEqual(['audit', 'proof', 42]);
    expect(queryKeys.user('usr-1')).toEqual(['admin', 'users', 'usr-1']);
    expect(queryKeys.userEntitlements('usr-1')).toEqual([
      'admin',
      'users',
      'usr-1',
      'entitlements',
    ]);
  });

  it('keys the environment plan on every input it depends on', () => {
    const first = queryKeys.envPlan('D01-01', 'production', { DB_HOST: 'db' });
    const otherProfile = queryKeys.envPlan('D01-01', 'staging', { DB_HOST: 'db' });
    const otherValue = queryKeys.envPlan('D01-01', 'production', { DB_HOST: 'other' });

    expect(first).toEqual(['catalog', 'D01-01', 'env-plan', 'production', { DB_HOST: 'db' }]);
    expect(otherProfile).not.toEqual(first);
    expect(otherValue).not.toEqual(first);
  });

  it('keys the deploy preview on the size as well as the slug', () => {
    const resources = { cpu: 1, memoryMb: 1024, diskMb: 1024 };
    const first = queryKeys.deployPreview('D01-01', 'crm', 'production', resources);

    expect(first).toEqual(['instances', 'preview', 'D01-01', 'crm', 'production', resources]);
    expect(queryKeys.deployPreview('D01-01', 'crm', 'production', undefined)).toEqual([
      'instances',
      'preview',
      'D01-01',
      'crm',
      'production',
      null,
    ]);
    expect(queryKeys.deployPreview('D01-01', 'other', 'production', resources)).not.toEqual(first);
  });

  it('exposes the list roots the invalidation calls target', () => {
    expect(queryKeys.catalog).toEqual(['catalog']);
    expect(queryKeys.envProfiles).toEqual(['env-profiles']);
    expect(queryKeys.instances).toEqual(['instances']);
    expect(queryKeys.jobs).toEqual(['jobs']);
    expect(queryKeys.workflows).toEqual(['workflows']);
    expect(queryKeys.audit).toEqual(['audit']);
    expect(queryKeys.licenses).toEqual(['licenses']);
    expect(queryKeys.patches).toEqual(['patch-register']);
    expect(queryKeys.posture).toEqual(['posture']);
    expect(queryKeys.breakGlass).toEqual(['break-glass']);
    expect(queryKeys.capacity).toEqual(['capacity']);
    expect(queryKeys.registry).toEqual(['registry']);
    expect(queryKeys.registryStale).toEqual(['registry', 'stale']);
    expect(queryKeys.users).toEqual(['admin', 'users']);
    expect(queryKeys.groups).toEqual(['admin', 'groups']);
    expect(queryKeys.identitySync).toEqual(['admin', 'identity-sync']);
    expect(queryKeys.settings).toEqual(['admin', 'settings']);
    expect(queryKeys.alertChannels).toEqual(['admin', 'settings', 'alerts']);
    expect(queryKeys.accessRequests).toEqual(['admin', 'access-requests']);
    expect(queryKeys.maintenance).toEqual(['admin', 'maintenance-windows']);
    expect(queryKeys.policyExceptions).toEqual(['admin', 'policy-exceptions']);
    expect(queryKeys.dsar).toEqual(['admin', 'dsar']);
    expect(queryKeys.recovery).toEqual(['recovery']);
    expect(queryKeys.restoreStatus).toEqual(['recovery', 'restore-status']);
    expect(queryKeys.privacy).toEqual(['privacy']);
  });
});
