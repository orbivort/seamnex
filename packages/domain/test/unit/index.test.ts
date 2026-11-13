import { describe, expect, it } from 'vitest';
import * as barrel from '../../src/index';
import * as capabilities from '../../src/capabilities';
import * as capacity from '../../src/capacity';
import * as contract from '../../src/contract';
import * as credentialGranularity from '../../src/credential-granularity';
import * as enums from '../../src/enums';
import * as envRules from '../../src/env-rules';
import * as labels from '../../src/labels';
import * as licenseTerms from '../../src/license-terms';
import * as mappingExpression from '../../src/mapping-expression';
import * as policy from '../../src/policy';
import * as propagation from '../../src/propagation';
import * as routes from '../../src/routes';
import * as signInCopy from '../../src/sign-in-copy';
import * as stateMachines from '../../src/state-machines';
import * as version from '../../src/version';
import * as authSchema from '../../src/schemas/auth';
import * as backupSchema from '../../src/schemas/backup';
import * as capacitySchema from '../../src/schemas/capacity';
import * as catalogSchema from '../../src/schemas/catalog';
import * as commonSchema from '../../src/schemas/common';
import * as governanceSchema from '../../src/schemas/governance';
import * as identitySchema from '../../src/schemas/identity';
import * as instanceSchema from '../../src/schemas/instance';
import * as jobSchema from '../../src/schemas/job';
import * as portalSchema from '../../src/schemas/portal';
import * as privacySchema from '../../src/schemas/privacy';
import * as recoverySchema from '../../src/schemas/recovery';
import * as registrySchema from '../../src/schemas/registry';
import * as fieldDiscoverySchema from '../../src/schemas/field-discovery';
import * as workflowSchema from '../../src/schemas/workflow';

/**
 * The barrel is the contract every other package validates against, so the failure that matters is
 * not a wrong value inside a schema — those have their own suites — but a name that stops being
 * reachable. `export *` drops a name silently when two modules publish it, and it drops a module
 * entirely when nobody adds it here; both leave every module-level test green.
 *
 * The table is written out instead of discovered for that reason: adding a module to `src/index.ts`
 * without adding it here leaves the union unchanged and the barrel with an unexplained extra key,
 * which the second test catches.
 */
const MODULES = [
  ['capabilities', capabilities],
  ['capacity', capacity],
  ['contract', contract],
  ['credential-granularity', credentialGranularity],
  ['enums', enums],
  ['env-rules', envRules],
  ['labels', labels],
  ['license-terms', licenseTerms],
  ['mapping-expression', mappingExpression],
  ['policy', policy],
  ['propagation', propagation],
  ['routes', routes],
  ['sign-in-copy', signInCopy],
  ['state-machines', stateMachines],
  ['version', version],
  ['schemas/auth', authSchema],
  ['schemas/backup', backupSchema],
  ['schemas/capacity', capacitySchema],
  ['schemas/catalog', catalogSchema],
  ['schemas/common', commonSchema],
  ['schemas/field-discovery', fieldDiscoverySchema],
  ['schemas/governance', governanceSchema],
  ['schemas/identity', identitySchema],
  ['schemas/instance', instanceSchema],
  ['schemas/job', jobSchema],
  ['schemas/portal', portalSchema],
  ['schemas/privacy', privacySchema],
  ['schemas/recovery', recoverySchema],
  ['schemas/registry', registrySchema],
  ['schemas/workflow', workflowSchema],
] as const satisfies readonly (readonly [string, Record<string, unknown>])[];

const barrelOf = barrel as Record<string, unknown>;
const barrelKeys = Object.keys(barrel).sort();

/** Every runtime symbol the modules publish, plus the module that publishes it. */
function published(): Map<string, { module: string; value: unknown }> {
  const seen = new Map<string, { module: string; value: unknown }>();
  for (const [module, namespace] of MODULES) {
    for (const [name, value] of Object.entries(namespace)) {
      const previous = seen.get(name);
      // Two modules publishing one name makes the `export *` ambiguous, so the barrel drops the
      // name: the contract would lose an export with no module-level test failing.
      expect(
        previous?.module,
        `${name} is published by both ${previous?.module} and ${module}`,
      ).toBeUndefined();
      seen.set(name, { module, value });
    }
  }
  return seen;
}

describe('@seamnex/domain entry point', () => {
  it('re-exports every symbol its modules publish, as the same binding', () => {
    for (const [name, { module, value }] of published()) {
      expect(barrelOf, `${name} from ${module} is missing from the barrel`).toHaveProperty(name);
      expect(barrelOf[name], `${name} is not the same binding`).toBe(value);
    }
  });

  it('publishes nothing the modules do not publish', () => {
    const known = new Set(published().keys());

    expect(barrelKeys.filter((key) => !known.has(key))).toEqual([]);
  });

  it('publishes no runtime key for a type-only export', () => {
    for (const name of [
      'PlatformRole',
      'GuaranteeClass',
      'InstanceState',
      'RouteMeta',
      'Page',
      'ProblemDetail',
      'EnvVarRule',
    ]) {
      expect(barrelKeys, `${name} is a type and must not exist at runtime`).not.toContain(name);
    }
  });

  it('publishes the schema and helper names the applications import', () => {
    for (const name of [
      'PLATFORM_ROLES',
      'ROUTES',
      'ROUTE_BY_PATH',
      'INSTANCE_TRANSITIONS',
      'ProblemDetailSchema',
      'TimestampSchema',
      'canTransitionInstance',
      'syncStateForGuaranteeClass',
      'compareVersions',
      'compareEntryKeys',
      'checkEnvValue',
      'pageOf',
    ]) {
      expect(barrelKeys, `barrel is missing ${name}`).toContain(name);
    }
  });
});

/**
 * One value per layer, reached only through the barrel: an enum tuple, a schema, a pure mapping and
 * a state machine. The point is that the entry point is enough to use the package, not that the
 * behaviour is re-tested here.
 */
describe('the entry point is usable as the only import', () => {
  it('exposes the role vocabulary as a value, not only as a type', () => {
    expect(barrel.PLATFORM_ROLES).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(barrel.INSTANCE_STATES).toContain('ready');
  });

  it('rejects a problem detail that omits the required members', () => {
    const result = barrel.ProblemDetailSchema.safeParse({ status: 500 });

    expect(result.success).toBe(false);
    expect(barrel.ProblemDetailSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an RFC 9457 problem detail and defaults the field errors', () => {
    const parsed = barrel.ProblemDetailSchema.parse({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Slug already in use',
      code: 'slug_taken',
      remediation: 'Choose another slug',
    });

    expect(parsed.fieldErrors).toEqual([]);
  });

  it('maps a guarantee class to the sync state a screen may claim', () => {
    expect(barrel.syncStateForGuaranteeClass('fa_gate')).toBe('unsupported');
    expect(barrel.propagatesFully('native')).toBe(true);
    expect(barrel.propagatesFully('fa_delegated')).toBe(false);
  });

  it('refuses a lifecycle shortcut through the exported state machine', () => {
    expect(barrel.canTransitionInstance('ready', 'stopping')).toBe(true);
    expect(barrel.canTransitionInstance('validating', 'ready')).toBe(false);
  });

  it('serves the console route table in a lookup form', () => {
    expect(barrel.ROUTES.length).toBeGreaterThan(0);
    expect(barrel.ROUTE_BY_PATH['/capacity']?.app).toBe('console');
  });
});
