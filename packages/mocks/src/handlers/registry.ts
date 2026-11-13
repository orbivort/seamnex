import { http, HttpResponse } from 'msw';
import { getState } from '../store';
import { problem, requireCapability, roleOf } from './utils';

export const registryHandlers = [
  http.get('/api/v1/registry/instances', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'registry.view');
    if (guard) return guard;
    return HttpResponse.json(getState().registry);
  }),

  http.get('/api/v1/registry/instances/:slug', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'registry.view');
    if (guard) return guard;
    const entry = getState().registry.find((item) => item.slug === String(params.slug));
    if (!entry) {
      return problem(
        404,
        'REGISTRY_ENTRY_NOT_FOUND',
        'No registry entry',
        `No deployed instance has slug ${String(params.slug)}.`,
        'Refresh the registry projection.',
      );
    }
    return HttpResponse.json(entry);
  }),

  http.get('/api/v1/registry/stale', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'registry.view');
    if (guard) return guard;
    return HttpResponse.json(getState().registry.filter((entry) => entry.stale));
  }),
];
