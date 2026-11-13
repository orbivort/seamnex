import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../../common/adapters';
import { AppError, isAppError } from '../../common/problem/app-error';

/**
 * 4E.4 - the n8n adapter.
 *
 * The platform owns the workflow document and n8n executes it. `upsert` is create-then-activate in
 * one call because a workflow that exists but is inactive is the state an operator mistakes for
 * "published": the compiler only returns once the instance can actually receive a trigger.
 */
@Injectable()
export class N8nClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Fails while nothing has been written yet when the adapter cannot be reached by configuration.
   *
   * Activation mints a credential before the push, so a key discovered missing at push time would
   * leave a live write scope behind for a workflow that never went live — and the refusal promises
   * the operator that nothing changed.
   */
  assertReady(): void {
    requireAdapters(this.config, 'n8n');
    if (this.config.SEAMNEX_N8N_API_KEY.length === 0) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'No n8n API key is configured.',
        remediation: 'Set SEAMNEX_N8N_API_KEY; workflow activation cannot be faked.',
      });
    }
  }

  /** The mirror polls on a timer, where throwing would be a crash rather than an answer. */
  ready(): boolean {
    try {
      this.assertReady();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create-or-update, then activate in one call.
   *
   * `knownId` is `workflow_version.compiled_n8n_id`, the id this definition was last pushed to, and it
   * is authoritative. The name search is the fallback for a definition the platform has no id for. Both
   * were needed: with only the search, and a search that matched nothing, every activation created a
   * second n8n workflow and left the previous one running.
   */
  async upsert(
    workflowId: string,
    document: Record<string, unknown>,
    activate: boolean,
    knownId?: string | null,
  ): Promise<string> {
    let id = knownId ?? (await this.find(workflowId));
    if (id === null) {
      id = await this.create(document);
    } else {
      try {
        await this.request('PUT', `/workflows/${id}`, document);
      } catch (error) {
        /*
         * A recorded id that no longer exists in n8n means someone deleted it there, and recreating is
         * the repair: leaving it as a plain error would make the definition unactivatable until an
         * operator edited the database. Only a 404 is repaired — any other failure is real and must
         * surface, or a transient 502 would silently mint a duplicate.
         */
        if (!isAppError(error) || !error.detail.includes('404')) throw error;
        const found = await this.find(workflowId);
        if (found === id) throw error;
        id = found ?? (await this.create(document));
        if (found !== null) await this.request('PUT', `/workflows/${id}`, document);
      }
    }
    if (activate) await this.request('POST', `/workflows/${id}/activate`);
    return id;
  }

  /**
   * Ends the n8n schedule. Unlike `remove`, a miss is an error: it is only called for an active
   * definition, which by construction has a workflow in n8n, so "not found" means the two sides have
   * diverged and the caller must record that instead of reporting a clean disable.
   */
  async deactivate(workflowId: string, knownId?: string | null): Promise<void> {
    const id = knownId ?? (await this.find(workflowId));
    if (id === null) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'n8n holds no workflow for this definition.',
        remediation: 'Check the n8n instance; the platform state was not changed by that call.',
      });
    }
    await this.request('POST', `/workflows/${id}/deactivate`);
  }

  /** Idempotent: deleting a workflow n8n never had is not a failure. Answers whether it removed one. */
  async remove(workflowId: string, knownId?: string | null): Promise<boolean> {
    const id = knownId ?? (await this.find(workflowId));
    if (id === null) return false;
    await this.request('DELETE', `/workflows/${id}`);
    return true;
  }

  /**
   * The credential a version's nodes send to the broker.
   *
   * n8n keeps credentials in its own store and resolves a node's `credentials.<type>.id` against it;
   * a reference to a row that does not exist fails the call before the request is made, which is
   * exactly what every run reported while the compiled definition carried `{{ $json.credentialId }}`.
   * The public API can create and delete, never mutate — a rotation is create → repoint → delete.
   */
  async createCredential(name: string, token: string): Promise<string> {
    const response = await this.request('POST', '/credentials', {
      name,
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${token}` },
    });
    const payload = (await response.json()) as { id?: string };
    if (payload.id === undefined) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'n8n did not return a credential id.',
        remediation: 'Retry; nothing was activated.',
      });
    }
    return payload.id;
  }

  /**
   * Idempotent: a credential that is already gone (or was never created, in a failed earlier
   * activation) is not a failure — the caller is rotating, and the old row has no further use.
   */
  async removeCredential(credentialId: string): Promise<void> {
    await this.request('DELETE', `/credentials/${encodeURIComponent(credentialId)}`);
  }

  /**
   * 4E.4 — ask n8n to execute the compiled definition once.
   *
   * n8n's public API has no run endpoint: `POST /api/v1/workflows/:id/run` answers `405`, which
   * the first version of this method reported as a failure of the workflow. A manual run has to
   * arrive as a delivery to the webhook the compiler emits, whose `path` is the platform workflow
   * id. In queue mode n8n registers that webhook as `<n8nWorkflowId>/<nodeName>/<path>` — the
   * workflow id keeps the route unique across instances — while a single-process deployment
   * registers it as `<path>`. Both are tried in that order, because both topologies are supported.
   *
   * The 200 is an acknowledgement, not an execution id: n8n runs asynchronously, so what it
   * executed is read back from the executions endpoint (ADR-BE-12 D9).
   */
  async trigger(n8nWorkflowId: string, webhookPath: string): Promise<void> {
    this.assertReady();
    const candidates = [`${n8nWorkflowId}/trigger/${webhookPath}`, webhookPath];
    for (const candidate of candidates) {
      const response = await fetch(`${this.config.SEAMNEX_N8N_URL}/webhook/${candidate}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No trigger data exists for a manual run; the platform identifies itself so a node can.
        body: JSON.stringify({ source: 'seamnex', workflowId: n8nWorkflowId }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return;
      if (response.status !== 404) {
        throw new AppError({
          code: 'ADAPTER_UNAVAILABLE',
          detail: `n8n POST /webhook/${candidate} answered ${response.status}.`,
          remediation: 'Check the n8n instance and its queue-mode workers.',
        });
      }
    }
    throw new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      detail: `n8n has no webhook registered for ${webhookPath}, so no execution could start.`,
      remediation: 'Activate the workflow, then run it.',
    });
  }

  /** Execution mirror: the run record is read back so `workflow_run` reflects what n8n did. */
  async executions(
    workflowId: string,
    limit = 20,
  ): Promise<{ id: string; finished: boolean; status: string; startedAt: string }[]> {
    const response = await this.request(
      'GET',
      `/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}`,
    );
    const payload = (await response.json()) as {
      data?: { id: string; finished: boolean; status: string; startedAt: string }[];
    };
    return (payload.data ?? []).map((entry) => ({
      id: String(entry.id),
      finished: entry.finished === true,
      status: String(entry.status ?? 'unknown'),
      startedAt: String(entry.startedAt ?? ''),
    }));
  }

  /**
   * One execution with its per-node result (`includeData=true`).
   *
   * n8n reports `status: "error"` while `finished` stays `false` on a crashed execution, so the
   * caller must treat `status` as authoritative; `finished` alone would leave the run in flight.
   */
  async execution(id: string): Promise<{
    status: string;
    /**
     * When n8n says the execution ended. `null` on an execution still in flight, and on the detail
     * of an older n8n that does not return the field.
     *
     * The mirror used to stamp `finished_at = now()` at the moment it noticed, which made the run
     * table's *Duration* the settle latency: three runs of the same 265 ms execution displayed 38.1 s,
     * 60.0 s and 135.8 s depending on where the poll landed.
     */
    stoppedAt: string | null;
    nodes: {
      name: string;
      state: 'succeeded' | 'failed' | 'queued';
      durationMs: number;
      records: number;
      error: string | null;
      /** The first output item's `json`, as n8n already returned it. Unredacted; the mirror redacts. */
      sample: Record<string, unknown> | null;
    }[];
    error: string | null;
  }> {
    const response = await this.request(
      'GET',
      `/executions/${encodeURIComponent(id)}?includeData=true`,
    );
    const payload = (await response.json()) as {
      status?: unknown;
      stoppedAt?: unknown;
      data?: {
        resultData?: {
          runData?: Record<
            string,
            {
              executionStatus?: unknown;
              executionTime?: unknown;
              error?: N8nNodeError;
              data?: { main?: unknown[][] };
            }[]
          >;
          error?: N8nNodeError;
        };
      };
    };
    const result = payload.data?.resultData ?? {};
    const nodes = Object.entries(result.runData ?? {}).map(([name, runs]) => {
      const last = runs[runs.length - 1] ?? {};
      const failed = last.executionStatus === 'error' || last.error !== undefined;
      const items = Array.isArray(last.data?.main?.[0]) ? (last.data?.main?.[0] ?? []) : [];
      return {
        name,
        state: failed ? ('failed' as const) : ('succeeded' as const),
        durationMs: typeof last.executionTime === 'number' ? last.executionTime : 0,
        records: items.length,
        error: errorText(last.error),
        // FR-5.5: the item is already in the `includeData=true` payload this method requests to
        // count records, so capturing it adds no call. Only the first one: the mapper needs a path
        // to exist, not every row.
        sample: itemJson(items[0]),
      };
    });
    return {
      status: typeof payload.status === 'string' ? payload.status : 'unknown',
      stoppedAt: typeof payload.stoppedAt === 'string' ? payload.stoppedAt : null,
      nodes,
      error: errorText(result.error),
    };
  }

  private async find(workflowId: string): Promise<string | null> {
    const response = await this.request('GET', `/workflows?limit=250`);
    const payload = (await response.json()) as { data?: { id: string; name: string }[] };
    /*
     * `compile` ends every workflow name with `[<workflow id>]`. Matching on `staticData.irHash` as
     * well was dead code — that field holds the IR hash, never a workflow id — so the search could not
     * succeed even when the definition was already in n8n.
     */
    const match = (payload.data ?? []).find((entry) => entry.name.endsWith(`[${workflowId}]`));
    return match?.id ?? null;
  }

  private async create(document: Record<string, unknown>): Promise<string> {
    const response = await this.request('POST', '/workflows', document);
    const payload = (await response.json()) as { id?: string };
    if (payload.id === undefined) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'n8n did not return a workflow id.',
        remediation: 'Retry; nothing was activated.',
      });
    }
    return payload.id;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    this.assertReady();
    const response = await fetch(`${this.config.SEAMNEX_N8N_URL}/api/v1${path}`, {
      method,
      headers: {
        'X-N8N-API-KEY': this.config.SEAMNEX_N8N_API_KEY,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok && method !== 'DELETE') {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `n8n ${method} ${path} answered ${response.status}.`,
        remediation:
          'The workflow was not changed in n8n; check the queue-mode workers and the API key.',
      });
    }
    return response;
  }
}

/**
 * The error object n8n stores for a failed node or execution.
 *
 * `message` is n8n's own summary — an HTTP Request node fails with the generic "Bad request - please
 * check your parameters" — while the product's answer lives in `description` ("400 - {…}"), in
 * `messages` (the HTTP node's rendering of a parsed response body, which is where a `409` duplicate
 * carries the record that already exists) and the status code in `httpCode`. Reading only `message`
 * is what turned a refused write into a run record that named neither the product nor the field it
 * rejected.
 */
type N8nNodeError = {
  message?: unknown;
  description?: unknown;
  httpCode?: unknown;
  messages?: unknown;
};

/**
 * The `json` of one n8n item, or `null`.
 *
 * n8n wraps every item as `{ json, binary }`; only `json` is the object a mapping's `from` path is
 * evaluated against. A non-object item (a primitive binding) has nothing to map, so it is dropped
 * rather than stored as a puzzle.
 */
function itemJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const json = (value as Record<string, unknown>)['json'];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  return json as Record<string, unknown>;
}

/** Long enough for a duplicate record's identifying fields, short enough for a table cell. */
const MESSAGE_LIMIT = 400;

function firstMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const text = messages.find((entry): entry is string => typeof entry === 'string' && entry !== '');
  if (text === undefined) return null;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

/** The most specific sentence n8n has: its summary, qualified by the product's own answer. */
function errorText(error: N8nNodeError | undefined): string | null {
  if (error === undefined || error === null) return null;
  const message = typeof error.message === 'string' ? error.message : null;
  // A 409 is the one case where the summary says nothing at all: n8n renders every 4xx as "Your
  // request is invalid or could not be processed by the service" and puts the body here instead.
  const description =
    typeof error.description === 'string' ? error.description : firstMessage(error.messages);
  if (message === null) return description;
  if (description === null || description === message) return message;
  const code = typeof error.httpCode === 'string' ? error.httpCode : null;
  // n8n usually prefixes the description with the status itself ("400 - {…}"); adding it again
  // produced "400 400 - {…}" on the run that this was measured against.
  const qualified =
    code === null || description.startsWith(code) ? description : `${code} ${description}`;
  return `${message}: ${qualified}`;
}
