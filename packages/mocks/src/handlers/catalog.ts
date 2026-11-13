import { http, HttpResponse } from 'msw';
import { isCredentialGranularity, isWorkflowEligible, isWriteEligible } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { ENV_SCHEMAS } from '../fixtures/catalog';
import { resolveEnv } from '../fixtures/env-plan';
import { ENV_PROFILES } from '../fixtures/env-schema';
import { appendAudit, scaffoldFor, getState } from '../store';
import { actorFor, readBody, deny, problem, requireCapability, roleOf } from './utils';

export const catalogHandlers = [
  http.get('/api/v1/catalog', ({ request }) => {
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

  http.get('/api/v1/catalog/:key', ({ params, request }) => {
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

  http.get('/api/v1/catalog/:key/env-schema', ({ params, request }) => {
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
  http.get('/api/v1/catalog/:key/env-plan', ({ params, request }) => {
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

  http.get('/api/v1/env-profiles', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'instance.configure');
    if (guard) return guard;
    return HttpResponse.json(ENV_PROFILES);
  }),

  http.patch('/api/v1/catalog/:key/integration-metadata', async ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1', 'R3'], 'metadata.manage');
    if (guard) return guard;

    const body = await readBody<{ credentialGranularity?: string; sessionMaxMinutes?: number }>(
      request,
    );
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
    const previousGranularity = entry.integration.credentialGranularity;
    if (body.credentialGranularity !== undefined) {
      entry.integration.credentialGranularity = body.credentialGranularity;
    }
    if (typeof body.sessionMaxMinutes === 'number') {
      entry.integration.sessionMaxMinutes = body.sessionMaxMinutes;
    }
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

  http.get('/api/v1/catalog/:key/scaffold', ({ params, request }) => {
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

  http.post('/api/v1/catalog/:key/scaffold/:draftId/confirm', ({ params, request }) => {
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
  http.post('/api/v1/catalog/reload', ({ request }) => {
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
    });
  }),

  /** FR-1.30: map a pasted .env or Compose environment into the declared schema. */
  http.post('/api/v1/catalog/:key/env-import', async ({ params, request }) => {
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
