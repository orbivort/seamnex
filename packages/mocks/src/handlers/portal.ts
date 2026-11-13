import { http, HttpResponse } from 'msw';
import { can } from '@seamnex/domain';
import { isEntitled } from '../fixtures/portal';
import { getState, entitlements, launcher, logout, meFor } from '../store';
import { problem, roleOf } from './utils';

export const portalHandlers = [
  http.get('/api/v1/me', ({ request }) => {
    const role = roleOf(request);
    const me = meFor(role);
    return HttpResponse.json(me);
  }),

  http.get('/api/v1/me/entitlements', ({ request }) => {
    const role = roleOf(request);
    if (!can(role, 'portal.view_entitlements')) {
      return problem(
        403,
        'FORBIDDEN',
        'Entitlement summary is not available to guests',
        'Guest access is scoped to a single product surface; no catalog or entitlement browsing is permitted.',
        'Open the invitation link that was sent to you, or ask the domain owner for portal access.',
      );
    }
    return HttpResponse.json(entitlements(role));
  }),

  http.get('/api/v1/me/launcher', ({ request }) => {
    const role = roleOf(request);
    return HttpResponse.json(launcher(role));
  }),

  http.post('/api/v1/me/logout', ({ request }) => {
    const role = roleOf(request);
    return HttpResponse.json(logout(role));
  }),

  http.get('/api/v1/portal/status-banner', () => {
    const banner = getState().banners.find((item) => item.active) ?? null;
    return HttpResponse.json(banner);
  }),

  /** Deep links resolve one tile directly, without downloading the whole launcher. */
  http.get('/api/v1/portal/products/:slug', ({ params, request }) => {
    const role = roleOf(request);
    const slug = String(params.slug);
    const tile = launcher(role).tiles.find((item) => item.slug === slug);
    if (!tile) {
      // No entitlement and no such product are answered identically, so the endpoint cannot
      // be used to enumerate products the caller may not see (FR-3.5).
      return problem(
        403,
        'ENTITLEMENT_REQUIRED',
        'This product is not available to your role',
        `No entitled product has the address "${slug}".`,
        'Ask the domain owner for a product entitlement, or request access from the portal.',
      );
    }
    return HttpResponse.json(tile);
  }),

  /** FR-3.13: products the caller may ask for. Unentitled tiles stay off the launcher (FR-3.5). */
  http.get('/api/v1/portal/requestable', ({ request }) => {
    const role = roleOf(request);
    if (!can(role, 'portal.view_entitlements')) {
      return problem(
        403,
        'FORBIDDEN',
        'Access requests are not available to guests',
        'Guest access is scoped to a single product surface.',
        'Ask the domain owner to include you in the directory group instead.',
      );
    }
    const me = meFor(role);
    const held = new Set(entitlements(role).entitlements.map((item) => item.entryKey));
    const state = getState();
    return HttpResponse.json(
      state.catalog
        .filter((entry) => !held.has(entry.key))
        .map((entry) => {
          const open = state.accessRequests.find(
            (item) =>
              item.requester.id === me.id &&
              item.state === 'open' &&
              item.target.startsWith(`${entry.key} `),
          );
          return {
            entryKey: entry.key,
            domain: entry.domain,
            product: entry.product,
            description: entry.description,
            guaranteeClass: entry.guaranteeClass,
            productRole: 'member',
            owner: entry.owner.name,
            requested: open !== undefined,
            requestedAt: open?.createdAt ?? null,
          };
        }),
    );
  }),

  http.get('/api/v1/portal/launch-targets/:instanceId', ({ params, request }) => {
    const role = roleOf(request);
    const instanceId = String(params.instanceId);
    const instance = getState().instances.find((item) => item.id === instanceId);
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        `No instance matches ${instanceId}.`,
        'Refresh the launcher; the catalog may have changed since this page was opened.',
      );
    }
    if (role === 'R2') {
      return problem(
        403,
        'LAUNCH_NOT_PERMITTED',
        'Auditors cannot launch products',
        'R2 holds read-only access to platform evidence, not to business product surfaces.',
        'Ask a domain owner for a product entitlement if business access is required.',
      );
    }
    if (!isEntitled(role, instance.id)) {
      return problem(
        403,
        'ENTITLEMENT_REQUIRED',
        'This product is not entitled to your role',
        `${instance.product} is absent from your launcher because your directory groups do not grant it.`,
        'Ask the domain owner to add you to the directory group that grants this product.',
      );
    }
    const entry = getState().catalog.find((item) => item.key === instance.entryKey);
    const gate = entry?.guaranteeClass === 'fa_gate';
    return HttpResponse.json({
      instanceId: instance.id,
      url: `https://${instance.domainRoute}/`,
      authClass: entry?.guaranteeClass ?? 'fa_gate',
      ssoState: gate ? 'sign_in_required' : 'sso',
      note: gate
        ? 'Sign-in required. Your product credential is provisioned outside the platform and is not stored here.'
        : 'Opens in a new tab using your existing portal session. No second credential prompt.',
      opensInNewTab: true,
      bootstrapRequired: (entry?.guaranteeClass ?? 'fa_gate') !== 'native',
      // ADR-BE-22: only a gated route relays, and the demo shows the state a working deployment is
      // in after its first provisioning pass rather than the transient one.
      relayState: gate ? 'ready' : 'unavailable',
    });
  }),

  /**
   * The demo has no edge to redeem a ticket, so the mock answers with the bootstrap URL the real
   * API would return. Modelling the shape keeps the dialog's code path identical in both modes.
   */
  http.post('/api/v1/portal/launch-tickets/:instanceId', ({ params, request }) => {
    const role = roleOf(request);
    const instanceId = String(params.instanceId);
    const instance = getState().instances.find((item) => item.id === instanceId);
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        `No instance matches ${instanceId}.`,
        'Refresh the launcher.',
      );
    }
    if (role === 'R2' || !isEntitled(role, instance.id)) {
      return problem(
        403,
        'ENTITLEMENT_REQUIRED',
        'This product is not entitled to your role',
        `${instance.product} is absent from your launcher because your directory groups do not grant it.`,
        'Ask the domain owner to add you to the directory group that grants this product.',
      );
    }
    return HttpResponse.json({
      url: `https://${instance.domainRoute}/__seamnex/session?ticket=demo-${instance.id.slice(-6)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }),

  /**
   * The launch record. The demo has no audit chain to append to, so it answers with the shape the
   * real service returns; the dialog calls this in both modes, which keeps one code path.
   */
  http.post('/api/v1/portal/launch-events/:instanceId', ({ params, request }) => {
    const role = roleOf(request);
    const instanceId = String(params.instanceId);
    const instance = getState().instances.find((item) => item.id === instanceId);
    if (!instance) {
      return problem(
        404,
        'INSTANCE_NOT_FOUND',
        'Instance not found',
        `No instance matches ${instanceId}.`,
        'Refresh the launcher.',
      );
    }
    if (role === 'R2' || !isEntitled(role, instance.id)) {
      return problem(
        403,
        'ENTITLEMENT_REQUIRED',
        'This product is not entitled to your role',
        `${instance.product} is absent from your launcher because your directory groups do not grant it.`,
        'Ask the domain owner to add you to the directory group that grants this product.',
      );
    }
    const entry = getState().catalog.find((item) => item.key === instance.entryKey);
    return HttpResponse.json({
      instanceId: instance.id,
      recordedAt: new Date().toISOString(),
      ssoState: entry?.guaranteeClass === 'fa_gate' ? 'sign_in_required' : 'sso',
    });
  }),
];
