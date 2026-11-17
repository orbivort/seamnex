import { http, HttpResponse } from 'msw';
import { normaliseRegistryEntry } from '@seamnex/domain';
import type { TrustedRegistryRevision } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { appendAudit, imageScanReport, trustedRegistryState } from '../store';
import { actorFor, problem, readBody, requireCapability, roleOf } from './utils';

/**
 * NFR-4.16 / NFR-4.6 — image trust and image scanning, as the console sees them.
 *
 * The update route mirrors the live one rather than accepting anything: a revision is a new row
 * (never an edit of the current list), the note is mandatory, a no-op is refused, and an empty list
 * is refused because it would block every image on the platform — including the scanner's own.
 */
export const securityHandlers = [
  http.get('/api/v1/security/trusted-registries', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'settings.view');
    if (guard) return guard;
    return HttpResponse.json(trustedRegistryState());
  }),

  http.post('/api/v1/security/trusted-registries', async ({ request }) => {
    const role = roleOf(request);
    const guard = requireCapability(role, 'settings.manage');
    if (guard) return guard;

    const body = await readBody<{ add?: string[]; remove?: string[]; note?: string }>(request);
    const note = (body.note ?? '').trim();
    if (note.length < 10) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The change needs a recorded reason',
        'An audit row reading "changed" answers nothing; NFR-4.16 makes adding an entry an audited change.',
        'Describe why the namespace is being added or removed.',
        [{ field: 'note', code: 'minLength', message: 'At least 10 characters.' }],
      );
    }

    const state = trustedRegistryState();
    const entries = new Set(state.current.entries);
    const added: string[] = [];
    const removed: string[] = [];

    for (const raw of body.remove ?? []) {
      const entry = normaliseRegistryEntry(raw);
      if (entry === null) continue;
      if (entries.delete(entry)) removed.push(entry);
    }
    for (const raw of body.add ?? []) {
      const entry = normaliseRegistryEntry(raw);
      if (entry === null) continue;
      if (!entries.has(entry)) added.push(entry);
      entries.add(entry);
    }

    if (added.length === 0 && removed.length === 0) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'The allow-list already matches that change',
        `Version ${state.current.version} already holds every entry in the request.`,
        'Add an entry that is not present, or remove one that is.',
      );
    }
    if (entries.size === 0) {
      return problem(
        422,
        'VALIDATION_FAILED',
        'That change would trust no registry at all',
        'An empty allow-list refuses every image on the platform, including the scanner image.',
        'Add the replacement namespace in the same change, or keep the current revision.',
      );
    }

    const canonical = [...entries].sort();
    const version = state.current.version + 1;
    const revision: TrustedRegistryRevision = {
      version,
      // A mock digest: stable for the version so the screen shows a revision identity, not a claim.
      contentHash: `sha256:mock-${version}-${canonical.length}`,
      entries: canonical,
      note,
      createdBy: actorFor(role).id,
      createdAt: at(0),
    };
    state.current = revision;
    state.history = [
      {
        version,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
        note,
        entryCount: canonical.length,
      },
      ...state.history,
    ];

    appendAudit({
      action: 'security.trusted_registry.updated',
      targetType: 'trusted_registry_revision',
      targetId: String(version),
      targetLabel: `Trusted registry revision ${version}`,
      outcome: 'success',
      detail: `Revision ${version}: ${added.length} added, ${removed.length} removed (${canonical.length} entries). ${note}`,
      actor: actorFor(role),
    });

    return HttpResponse.json(state);
  }),

  /**
   * NFR-4.6 / S-10 — the retained report for one digest.
   *
   * A digest with no row is a 404, not an empty pass: "we never scanned this image" and "we scanned it
   * and found nothing" are different answers, and the screen says so.
   */
  http.get('/api/v1/instances/:id/image-scan', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const url = new URL(request.url);
    const digest = url.searchParams.get('digest') ?? '';
    if (digest === '') {
      return problem(
        422,
        'VALIDATION_FAILED',
        'A digest is required',
        'The report belongs to an image, identified by its digest.',
        'Send the digest exactly as the image list shows it.',
        [{ field: 'digest', code: 'required', message: 'Send ?digest=sha256:…' }],
      );
    }
    const report = imageScanReport(String(params.id), digest);
    if (!report) {
      return problem(
        404,
        'NOT_FOUND',
        'No retained scan for this image',
        `Image ${digest} of ${String(params.id)} has never been scanned.`,
        'Redeploy the instance so the image is scanned before its containers start.',
      );
    }
    return HttpResponse.json(report);
  }),
];
