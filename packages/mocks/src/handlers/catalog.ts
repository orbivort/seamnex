import { http, HttpResponse } from 'msw';
import {
  computeCatalogCoverage,
  isCredentialGranularity,
  isWorkflowEligible,
  isWriteEligible,
  type AccessRequest,
  type CatalogEntry,
  type EnvSchemaVar,
} from '@seamnex/domain';
import { at } from '../fixtures/context';
import { ENV_SCHEMAS } from '../fixtures/catalog';
import { CATALOG_SYNC_COMMIT, CATALOG_SYNC_TAGS } from '../fixtures/catalog-repository';
import { resolveEnv } from '../fixtures/env-plan';
import { envSchemaFor } from '../fixtures/env-schema';
import { appendAudit, envProfiles, meFor, scaffoldFor, getState } from '../store';
import { actorFor, readBody, deny, problem, requireCapability, roleOf } from './utils';

export const catalogHandlers = [
  http.get('*/api/v1/catalog', ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'catalog.browse');
    if (guard) return guard;
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const cluster = url.searchParams.get('cluster');
    const packaging = url.searchParams.get('packaging');
    const items = getState().catalog.filter((entry) => {
      const matchesQuery =
        q === '' ||
        entry.product.toLowerCase().includes(q) ||
        entry.domain.toLowerCase().includes(q) ||
        entry.key.toLowerCase() === q;
      const matchesCluster = !cluster || entry.cluster === cluster;
      const matchesPackaging = !packaging || entry.packaging === packaging;
      return matchesQuery && matchesCluster && matchesPackaging;
    });
    return HttpResponse.json(items);
  }),

  /*
   * ADR-BE-42 — registered **before** `/catalog/:key`, because MSW matches in registration order and
   * `:key` would otherwise capture `repository` and answer with an entry-not-found problem. The
   * console test would then pass against the wrong shape, which is worse than failing.
   */
  http.get('*/api/v1/catalog/repository', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'catalog.browse');
    if (guard) return guard;
    return HttpResponse.json(getState().catalogRepository);
  }),

  /** ADR-BE-42 §10.3: fetch, swap and reconcile. The mock has one tag, so an unknown ref refuses. */
  http.post('*/api/v1/catalog/sync', async ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'catalog sync');
    if (guard) return guard;
    const state = getState();
    if (!state.catalogRepository.source.configured) {
      return problem(
        503,
        'SOURCE_NOT_CONFIGURED',
        'No catalogue source is configured',
        'Nothing to fetch: SEAMNEX_CATALOG_SOURCE_URL is unset.',
        'Set the source URL, or place a catalogue tag in the working tree by hand and reload.',
      );
    }

    const body = await readBody<{ ref?: string }>(request);
    const ref = (body.ref ?? state.catalogRepository.source.ref ?? '').trim();
    if (!(CATALOG_SYNC_TAGS as readonly string[]).includes(ref)) {
      return problem(
        404,
        'SOURCE_REF_NOT_FOUND',
        'The source has no such tag',
        `The source has no tag "${ref}".`,
        'Use catalog-2026.11.0, or name a tag that exists in the mirror.',
      );
    }

    // A successful sync reconciles the tree, so any mixed state the mock was showing is repaired.
    state.catalogRepository = {
      revision: CATALOG_SYNC_COMMIT.sha,
      source: { ...state.catalogRepository.source, ref },
      commit: {
        sha: CATALOG_SYNC_COMMIT.sha,
        actor: actorFor(role).id,
        message: `catalog sync ${ref} at ${CATALOG_SYNC_COMMIT.sha}`,
        recordedAt: CATALOG_SYNC_COMMIT.recordedAt,
      },
      staged: null,
    };

    appendAudit({
      action: 'catalog.source.synced',
      targetType: 'catalog',
      targetId: CATALOG_SYNC_COMMIT.sha,
      targetLabel: `Catalogue source ${ref}`,
      outcome: 'success',
      detail: `Fetched ${state.catalogRepository.source.host ?? 'the configured source'} at ${ref} (${CATALOG_SYNC_COMMIT.sha}); ${String(state.catalog.length)} entries reconciled.`,
      actor: actorFor(role),
    });

    return HttpResponse.json({
      reloadedAt: at(0),
      revision: CATALOG_SYNC_COMMIT.sha,
      entries: state.catalog.length,
      added: 0,
      changed: 0,
      removed: 0,
      reconciled: state.catalog.map((entry) => ({
        key: entry.key,
        change: 'unchanged' as const,
        detail: `${entry.key} matches repository revision`,
      })),
      environment: { added: 0, changed: 0, removed: 0, refused: [], applied: [] },
      invalid: [],
      coverage: computeCatalogCoverage({
        entries: state.catalog.map((entry) => ({
          key: entry.key,
          guaranteeClass: entry.guaranteeClass,
          primaryInstanceId: entry.primaryInstanceId,
        })),
        declaredEnvironments: state.catalog.length,
        refused: [],
      }),
      source: {
        url: state.catalogRepository.source.host ?? 'the configured source',
        ref,
        commit: CATALOG_SYNC_COMMIT.sha,
      },
      staged: { pending: [] },
    });
  }),

  http.get('*/api/v1/catalog/:key', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'catalog.read_metadata');
    if (guard) return guard;
    const entry = getState().catalog.find((item) => item.key === String(params.key));
    if (!entry) {
      return problem(
        404,
        'CATALOG_ENTRY_NOT_FOUND',
        'Catalog entry not found',
        `No catalog entry has key ${String(params.key)}.`,
        'Reload the catalog, then retry. Entry keys follow the D<n> pattern declared by the repository.',
      );
    }
    return HttpResponse.json(entry);
  }),

  http.get('*/api/v1/catalog/:key/env-schema', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'catalog.read_metadata');
    if (guard) return guard;
    const key = String(params.key);
    const vars = ENV_SCHEMAS[key];
    if (!vars) {
      // FR-1.24 — the remediation used to end with "(FR-1.24)". Problem details are rendered to
      // operators, so the id stays here.
      return problem(
        404,
        'ENV_SCHEMA_NOT_FOUND',
        'No environment schema for this entry',
        `Entry ${key} has no declared environment schema.`,
        'Run catalog validation; every deployable entry must declare its variables.',
      );
    }
    return HttpResponse.json(vars);
  }),

  /** Resolved environment preview: default → profile → instance → secret, ceilings enforced. */
  http.get('*/api/v1/catalog/:key/env-plan', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'catalog.read_metadata');
    if (guard) return guard;
    const key = String(params.key);
    const entry = getState().catalog.find((item) => item.key === key);
    if (!entry) {
      return problem(
        404,
        'CATALOG_ENTRY_NOT_FOUND',
        'Catalog entry not found',
        `No catalog entry has key ${key}.`,
        'Reload the catalog, then retry. Entry keys follow the D<n> pattern declared by the repository.',
      );
    }
    const url = new URL(request.url);
    const profileKey = url.searchParams.get('profile') ?? 'production';
    const overrides: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
      if (name.startsWith('env.')) overrides[name.slice(4)] = value;
    }
    return HttpResponse.json(resolveEnv(key, profileKey, overrides));
  }),

  http.get('*/api/v1/env-profiles', ({ request }) => {
    // The route's policy key is `catalog.browse` (a read); the guard used to ask for
    // `instance.configure`, which is a different question and refused a role the API admits.
    const guard = requireCapability(roleOf(request), 'catalog.browse');
    if (guard) return guard;
    return HttpResponse.json(envProfiles());
  }),

  /**
   * FR-1.26 — a role that may read profiles but not write them files a change request instead.
   *
   * The request is an ordinary access request so the same governance queue and second-party rule
   * apply; nothing about a profile bypasses the decision that a write needs.
   */
  http.post('*/api/v1/env-profiles/:key/requests', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'profile.request');
    if (guard) return guard;
    const key = String(params.key);
    const body = await readBody<{ justification?: string }>(request);
    const justification = (body.justification ?? '').trim();
    const state = getState();
    const profile = state.profiles.find((item) => item.key === key);
    if (!profile) {
      return problem(
        404,
        'NOT_FOUND',
        'No such profile',
        `No environment profile "${key}".`,
        'Reload the list; a profile key cannot be renamed.',
      );
    }
    if (justification.length < 10) {
      return problem(
        422,
        'JUSTIFICATION_REQUIRED',
        'A justification is required',
        'The domain owner needs a reason to decide.',
        'Name the variable and the value you need, in at least 10 characters.',
        [{ field: 'justification', code: 'required', message: 'At least 10 characters.' }],
      );
    }
    const me = meFor(role);
    const created: AccessRequest = {
      id: `ar-${3300 + state.accessRequests.length}`,
      requester: { id: me.id, name: me.displayName },
      // A profile value is an instance parameter: the same queue that decides a single-instance
      // override decides a change to the set it inherits.
      kind: 'instance_param',
      target: `${profile.key} ${profile.name} — environment profile`,
      justification,
      state: 'open',
      createdAt: at(0),
      decidedBy: null,
      decidedAt: null,
      domain: 'Platform',
    };
    state.accessRequests = [created, ...state.accessRequests];
    appendAudit({
      action: 'profile.change_requested',
      targetType: 'env_profile',
      targetId: profile.key,
      targetLabel: profile.name,
      outcome: 'success',
      detail: `${me.displayName} requested a change; ${created.id} is open for R1.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(created, { status: 201 });
  }),

  /**
   * FR-1.26 / AC-51 — the four profile writes, with the same refusals the API issues.
   *
   * The demo data is a fixture, not a second implementation: each rejection below mirrors a
   * server check (shape, unknown variable, `none`-only ceiling, secret source, profile in use), so a
   * console test cannot pass against a rule the API does not have.
   */
  http.post('*/api/v1/env-profiles', async ({ request }) => {
    const guard = requireCapability(roleOf(request), 'profile.manage');
    if (guard) return guard;
    const body = (await readBody(request)) as {
      key?: string;
      name?: string;
      target?: 'production' | 'staging';
    };
    const key = body.key ?? '';
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(key)) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The profile key is not valid',
        'Use 2–32 characters: a lowercase letter followed by lowercase letters, digits, "-" or "_".',
        'Choose a key that follows the documented pattern; the key is what instances pin to.',
      );
    }
    if (!body.name || body.name.trim() === '') {
      return problem(
        422,
        'VALIDATION_FAILED',
        'A profile needs a name',
        'Enter a display name.',
        'The name is what the wizard shows; it does not have to be unique.',
      );
    }
    const state = getState();
    if (state.profiles.some((profile) => profile.key === key)) {
      return problem(
        409,
        'STATE_CONFLICT',
        'That profile already exists',
        `A profile with key "${key}" already exists.`,
        'Choose another key, or edit the existing profile instead.',
      );
    }
    const created = {
      key,
      name: body.name.trim(),
      target: body.target ?? 'production',
      updatedBy: actorFor(roleOf(request)).name,
      updatedAt: at(0),
      values: [],
    };
    state.profiles = [...state.profiles, created];
    appendAudit({
      action: 'profile.created',
      targetType: 'env_profile',
      targetId: key,
      targetLabel: created.name,
      outcome: 'success',
      detail: `${created.name} · ${created.target}`,
      actor: {
        id: actorFor(roleOf(request)).id,
        name: actorFor(roleOf(request)).name,
        type: 'user',
      },
    });
    return HttpResponse.json(created);
  }),

  http.patch('*/api/v1/env-profiles/:key', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'profile.manage');
    if (guard) return guard;
    const key = String(params.key);
    const body = (await readBody(request)) as { name?: string; target?: 'production' | 'staging' };
    if (body.name === undefined && body.target === undefined) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'Nothing to change',
        'Specify a name or a target.',
        'Send at least one field; an empty patch would re-sign the row without a change.',
      );
    }
    const state = getState();
    const profile = state.profiles.find((item) => item.key === key);
    if (!profile) {
      return problem(
        404,
        'NOT_FOUND',
        'No such profile',
        `No environment profile "${key}".`,
        'Reload the list; a profile key cannot be renamed.',
      );
    }
    if (body.name !== undefined) profile.name = body.name;
    if (body.target !== undefined) profile.target = body.target;
    profile.updatedBy = actorFor(roleOf(request)).name;
    profile.updatedAt = at(0);
    return HttpResponse.json(profile);
  }),

  http.put('*/api/v1/env-profiles/:key/values', async ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'profile.manage');
    if (guard) return guard;
    const key = String(params.key);
    const state = getState();
    const profile = state.profiles.find((item) => item.key === key);
    if (!profile) {
      return problem(
        404,
        'NOT_FOUND',
        'No such profile',
        `No environment profile "${key}".`,
        'Reload the list; a profile key cannot be renamed.',
      );
    }
    const body = (await readBody(request)) as {
      values?: { varName: string; value?: string | null; secretRef?: string | null }[];
    };
    const declarations = declaredVariables(state.catalog);
    const fieldErrors: { field: string; code: string; message: string }[] = [];
    for (const value of body.values ?? []) {
      const declared = declarations.get(value.varName);
      if (declared === undefined) {
        fieldErrors.push({
          field: value.varName,
          code: 'unknown_variable',
          message: 'No catalog entry declares this variable.',
        });
        continue;
      }
      if (declared.every((item) => item.ceiling === 'none')) {
        fieldErrors.push({
          field: value.varName,
          code: 'ceiling',
          message: 'Every entry that declares this variable caps it at "none".',
        });
        continue;
      }
      const hasSecret = typeof value.secretRef === 'string' && value.secretRef.length > 0;
      const isSecret = declared.some((item) => item.secret);
      if (isSecret !== hasSecret) {
        fieldErrors.push({
          field: value.varName,
          code: isSecret ? 'secret_required' : 'value_required',
          message: isSecret
            ? 'This variable is a secret; reference a stored secret instead of a value.'
            : 'This variable is not a secret; enter a value.',
        });
      }
    }
    if (fieldErrors.length > 0) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The profile values were refused',
        'The profile values were refused; nothing was written.',
        'Fix the named fields and save again.',
        fieldErrors,
      );
    }
    profile.values = (body.values ?? []).map((value) => ({
      varName: value.varName,
      value: value.secretRef ? null : (value.value ?? null),
      secretRef: value.secretRef ?? null,
    }));
    profile.updatedBy = actorFor(roleOf(request)).name;
    profile.updatedAt = at(0);
    return HttpResponse.json(profile);
  }),

  http.delete('*/api/v1/env-profiles/:key', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'profile.manage');
    if (guard) return guard;
    const key = String(params.key);
    const state = getState();
    const profile = state.profiles.find((item) => item.key === key);
    if (!profile) {
      return problem(
        404,
        'NOT_FOUND',
        'No such profile',
        `No environment profile "${key}".`,
        'Reload the list; a profile key cannot be renamed.',
      );
    }
    const used = state.instances.filter(
      (instance) => instance.profileKey === key && instance.state !== 'deleted',
    );
    if (used.length > 0) {
      return problem(
        409,
        'STATE_CONFLICT',
        'The profile is in use',
        `Instances still deploy with "${key}": ${used
          .map((instance) => instance.slug)
          .join(', ')}.`,
        'Move those instances to another profile first; deleting it would leave them unresolvable.',
      );
    }
    state.profiles = state.profiles.filter((item) => item.key !== key);
    return HttpResponse.json({ key, deleted: true });
  }),

  http.patch('*/api/v1/catalog/:key/integration-metadata', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3'], 'metadata.manage');
    if (guard) return guard;

    const body = await readBody<{
      credentialGranularity?: string;
      sessionMaxMinutes?: number;
      apiBaseUrl?: string;
      authMethod?: string;
      guaranteeClass?: CatalogEntry['guaranteeClass'];
      operationInventory?: CatalogEntry['integration']['operationInventory'];
      eventModes?: CatalogEntry['integration']['eventModes'];
      sloSupported?: boolean;
    }>(request);
    const state = getState();
    const entry = state.catalog.find((item) => item.key === String(params.key));
    if (!entry) {
      return problem(
        404,
        'CATALOG_ENTRY_NOT_FOUND',
        'Catalog entry not found',
        'Unknown entry key.',
        'Reload the catalog.',
      );
    }
    // The real API validates the enum at the route schema and answers 422; silently ignoring an
    // unknown value would let the simulator accept a request the platform refuses.
    if (
      body.credentialGranularity !== undefined &&
      !isCredentialGranularity(body.credentialGranularity)
    ) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'credentialGranularity is not a credential granularity',
        `"${String(body.credentialGranularity)}" is not one of scoped, account, none.`,
        'Send scoped, account or none.',
        [
          {
            field: 'credentialGranularity',
            code: 'enum',
            message: 'One of scoped, account, none.',
          },
        ],
      );
    }
    /*
     * FR-2.15: an empty body is refused. It would restart the review clock without anyone having
     * verified anything, which is the defect the widened contract exists to close.
     */
    if (Object.values(body).every((value) => value === undefined)) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'Verify at least one fact',
        'An empty request would restart the review clock without evidence.',
        'Change a fact before recording the review.',
        [{ field: 'body', code: 'required', message: 'Send at least one verified fact.' }],
      );
    }
    const previousGranularity = entry.integration.credentialGranularity;
    if (body.credentialGranularity !== undefined) {
      entry.integration.credentialGranularity = body.credentialGranularity;
    }
    if (typeof body.sessionMaxMinutes === 'number') {
      entry.integration.sessionMaxMinutes = body.sessionMaxMinutes;
    }
    // Every other verified fact supersedes the catalogue assumption in place, so the entry screen
    // and the registry projection read one record rather than two.
    if (body.apiBaseUrl !== undefined) entry.integration.apiBaseUrl = body.apiBaseUrl;
    if (body.authMethod !== undefined) entry.integration.authMethod = body.authMethod;
    if (body.guaranteeClass !== undefined) {
      entry.integration.guaranteeClassVerified = body.guaranteeClass;
      entry.guaranteeClass = body.guaranteeClass;
    }
    if (body.operationInventory !== undefined) {
      entry.integration.operationInventory = body.operationInventory;
    }
    if (body.eventModes !== undefined) entry.integration.eventModes = body.eventModes;
    if (body.sloSupported !== undefined) entry.integration.sloSupported = body.sloSupported;
    entry.integration.verifiedBy = 'Sofia Almeida';
    entry.integration.verifiedAt = at(0);
    // The review clock restarts with the verification (13 weeks), exactly as the API does: leaving
    // `nextReviewAt` where it was made a verified entry look overdue the next day.
    entry.integration.nextReviewAt = at(91 * 24 * 60);
    entry.integration.stale = false;
    // The registry is a projection of the same fact, and the workflow simulator reads its
    // `writeEligible` flag. Leaving it untouched is what let a product be declared write-ineligible
    // on the catalog screen and still accept a write workflow in the canvas.
    for (const row of state.registry.filter((item) => item.entryKey === entry.key)) {
      row.credentialGranularity = entry.integration.credentialGranularity;
      row.writeEligible = isWriteEligible(entry.integration.credentialGranularity);
      row.workflowEligible = isWorkflowEligible(entry.integration.credentialGranularity);
      row.apiBaseUrl = entry.integration.apiBaseUrl;
      row.authMethod = entry.integration.authMethod;
      row.guaranteeClass = entry.guaranteeClass;
      row.operations = entry.integration.operationInventory;
      row.eventModes = entry.integration.eventModes;
      row.sloSupported = entry.integration.sloSupported;
      // AC-41: the facts this verification actually recorded now carry provenance. The defaults are
      // left alone rather than relabelled — a screen may not claim more than the call did.
      const recorded: (typeof row.verifiedFacts)[number][] = [];
      if (body.apiBaseUrl !== undefined) recorded.push('apiBaseUrl');
      if (body.authMethod !== undefined) recorded.push('authMethod');
      if (body.guaranteeClass !== undefined) recorded.push('guaranteeClass');
      if (body.credentialGranularity !== undefined) recorded.push('credentialGranularity');
      if (body.sessionMaxMinutes !== undefined) recorded.push('sessionMaxMinutes');
      if (body.operationInventory !== undefined) recorded.push('operations');
      if (body.eventModes !== undefined) recorded.push('eventModes');
      if (body.sloSupported !== undefined) recorded.push('sloSupported');
      row.verifiedFacts = [...new Set([...row.verifiedFacts, ...recorded])];
      row.verifiedAt = entry.integration.verifiedAt;
      row.nextReviewAt = entry.integration.nextReviewAt;
      row.stale = false;
    }
    appendAudit({
      action: 'catalog.integration_metadata.updated',
      targetType: 'catalog',
      targetId: entry.key,
      targetLabel: `${entry.key} ${entry.product}`,
      outcome: 'success',
      detail:
        `Integration metadata re-verified (${entry.integration.credentialGranularity} credentials, session max ${entry.integration.sessionMaxMinutes} min)` +
        (previousGranularity === entry.integration.credentialGranularity
          ? '.'
          : `; granularity ${previousGranularity} → ${entry.integration.credentialGranularity}, write-ineligible: ${!isWriteEligible(entry.integration.credentialGranularity)}. Live write scopes revoked.`),
      actor: actorFor(role),
    });
    return HttpResponse.json(entry);
  }),

  http.get('*/api/v1/catalog/:key/scaffold', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'catalog.read_metadata');
    if (guard) return guard;
    const draft = scaffoldFor(String(params.key));
    if (!draft) {
      return problem(
        404,
        'SCAFFOLD_NOT_FOUND',
        'No scaffold draft for this entry',
        'This entry already ships a Compose file or Dockerfile, so no scaffold is required.',
        'Choose an entry whose packaging is "none" to inspect the scaffold path.',
      );
    }
    return HttpResponse.json(draft);
  }),

  http.post('*/api/v1/catalog/:key/scaffold/:draftId/confirm', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'scaffold confirm');
    if (guard) return guard;
    const draft = scaffoldFor(String(params.key));
    if (!draft) {
      return problem(
        404,
        'SCAFFOLD_NOT_FOUND',
        'No scaffold draft',
        'Nothing to confirm.',
        'Inspect the catalog entry.',
      );
    }
    appendAudit({
      action: 'catalog.scaffold.confirmed',
      targetType: 'catalog',
      targetId: String(params.key),
      targetLabel: `Scaffold draft ${draft.draftId}`,
      outcome: 'success',
      detail: 'Generated artefacts confirmed and committed to the catalog repository.',
      actor: actorFor(role),
    });
    return HttpResponse.json({ ...draft, approvedBy: 'Sofia Almeida', createdAt: at(0) });
  }),

  /** FR-1.18 / DD-07: re-read the declarative source and reconcile the projection. */
  http.post('*/api/v1/catalog/reload', ({ request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'catalog reload');
    if (guard) return guard;
    const state = getState();
    const reconciled = state.catalog.map((entry) => ({
      key: entry.key,
      change: 'unchanged' as const,
      detail: `${entry.key} matches repository revision`,
    }));
    appendAudit({
      action: 'catalog.reload',
      targetType: 'catalog',
      targetId: 'catalog',
      targetLabel: 'Catalog repository',
      outcome: 'success',
      detail: `Catalog repository reloaded; ${state.catalog.length} entries reconciled, 0 drift.`,
      actor: actorFor(role),
    });
    return HttpResponse.json({
      reloadedAt: at(0),
      revision: 'a91f0c4',
      entries: state.catalog.length,
      added: 0,
      changed: 0,
      removed: 0,
      reconciled,
      // The mock reads no working tree, so it reports the shape the real API reports rather than
      // omitting it: a client that only handles the entry half would look correct here and fail
      // against the API.
      environment: { added: 0, changed: 0, removed: 0, refused: [], applied: [] },
      invalid: [],
      /*
       * S-1 / S-2 — the coverage strip on the receipt. Computed from the catalogue being served, not
       * written as a literal: a fixed `floorMet: true` could never show the shortfall the strip
       * exists to surface, and the console would look correct against a mock that lies.
       */
      coverage: computeCatalogCoverage({
        entries: state.catalog.map((entry) => ({
          key: entry.key,
          guaranteeClass: entry.guaranteeClass,
          primaryInstanceId: entry.primaryInstanceId,
        })),
        declaredEnvironments: state.catalog.length,
        refused: [],
      }),
    });
  }),

  /** FR-1.30: map a pasted .env or Compose environment into the declared schema. */
  http.post('*/api/v1/catalog/:key/env-import', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3'], 'environment import');
    if (guard) return guard;
    const key = String(params.key);
    const body = await readBody<{ source?: 'dotenv' | 'compose'; content?: string }>(request);
    const vars = ENV_SCHEMAS[key];
    if (!vars) {
      return problem(
        404,
        'ENV_SCHEMA_NOT_FOUND',
        'No environment schema',
        `Entry ${key} has no declared schema.`,
        'Validate the catalog entry first.',
      );
    }
    if (body.source !== 'dotenv' && body.source !== 'compose') {
      return problem(
        422,
        'IMPORT_SOURCE_INVALID',
        'Unknown import source',
        'The source must be dotenv or compose.',
        'Choose the format of the pasted content.',
      );
    }
    const content = body.content ?? '';
    if (content.trim().length === 0) {
      return problem(
        422,
        'IMPORT_EMPTY',
        'Nothing to import',
        'The pasted content was empty.',
        'Paste the .env file or the environment block, then retry.',
        [{ field: 'content', code: 'required', message: 'Paste at least one KEY=value line.' }],
      );
    }

    const declarations = new Map(vars.map((variable) => [variable.name, variable]));
    const pairs: { name: string; value: string }[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.endsWith(':')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, name = '', value = ''] = match;
      if (name === '') continue;
      pairs.push({ name, value: value.replace(/^["']|["']$/g, '') });
    }

    const unmapped: string[] = [];
    const mapped = pairs.map((pair) => {
      const declared = declarations.get(pair.name);
      if (!declared) {
        unmapped.push(pair.name);
        return {
          name: pair.name,
          value: pair.value,
          secret: false,
          accepted: false,
          reason: 'Not declared in the environment schema.',
        };
      }
      if (declared.secret) {
        return {
          name: pair.name,
          value: null,
          secret: true,
          accepted: false,
          reason: 'Secret values are entered in the platform, never imported.',
        };
      }
      if (declared.overrideCeiling === 'none') {
        return {
          name: pair.name,
          value: pair.value,
          secret: false,
          accepted: false,
          reason: 'This variable is not overridable (ceiling: none).',
        };
      }
      return { name: pair.name, value: pair.value, secret: false, accepted: true, reason: null };
    });

    const imported = mapped.filter((entry) => entry.accepted).length;
    appendAudit({
      action: 'catalog.env.imported',
      targetType: 'catalog',
      targetId: key,
      targetLabel: `${key} environment import`,
      outcome: 'success',
      detail: `${imported} value(s) mapped from ${body.source}; ${unmapped.length} key(s) unmapped. Secret values were withheld.`,
      actor: actorFor(role),
    });

    return HttpResponse.json({
      entryKey: key,
      source: body.source,
      parsed: pairs.length,
      mapped,
      unmapped,
      fieldErrors: mapped
        .filter((entry) => !entry.accepted && !entry.secret && entry.reason !== null)
        .map((entry) => ({
          field: entry.name,
          code: 'IMPORT_REJECTED',
          message: entry.reason ?? 'Rejected.',
        })),
      importedAt: at(0),
    });
  }),
];

/**
 * Every variable any shipped entry declares, with the entries and the ceiling each applies.
 *
 * The profile editor needs the same fact the server checks on write (AC-51): a variable is only
 * writable if *some* entry allows it, and a secret-typed variable may only reference a stored
 * secret. Building it from the fixture schemas keeps the console's explanation and the API's
 * refusal in step.
 */
function declaredVariables(
  entries: readonly CatalogEntry[],
): Map<string, { entryKey: string; secret: boolean; ceiling: EnvSchemaVar['overrideCeiling'] }[]> {
  const map = new Map<
    string,
    { entryKey: string; secret: boolean; ceiling: EnvSchemaVar['overrideCeiling'] }[]
  >();
  for (const entry of entries) {
    for (const variable of envSchemaFor(entry)) {
      const list = map.get(variable.name) ?? [];
      list.push({
        entryKey: entry.key,
        secret: variable.secret,
        ceiling: variable.overrideCeiling,
      });
      map.set(variable.name, list);
    }
  }
  return map;
}
