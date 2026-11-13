import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { JobAcceptedSchema, JobLogListSchema, JobPageSchema, JobSchema } from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

export type JobFilters = { instanceId?: string; kind?: string; state?: string };

const PAGE_SIZE = 25;

function jobQueryString(filters: JobFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.instanceId) params.set('instanceId', filters.instanceId);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.state) params.set('state', filters.state);
  return params;
}

/**
 * First page only. The overview needs a handful of recent jobs, not the whole history:
 * an unfiltered query here would silently truncate once the fleet grows past one page.
 */
export function useJobs(filters: JobFilters = {}) {
  const params = jobQueryString(filters);
  params.set('limit', '20');
  return useQuery({
    queryKey: [...queryKeys.jobs, 'first-page', filters] as const,
    queryFn: ({ signal }) =>
      request(`/jobs?${params.toString()}`, { schema: JobPageSchema, signal }),
  });
}

/** Cursor-paged job history for the Jobs screen. */
export function useJobPages(filters: JobFilters = {}) {
  const params = jobQueryString(filters);
  params.set('limit', String(PAGE_SIZE));

  return useInfiniteQuery({
    queryKey: [...queryKeys.jobs, 'pages', filters] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams(params);
      if (pageParam !== null) query.set('cursor', pageParam);
      return request(`/jobs?${query.toString()}`, { schema: JobPageSchema, signal });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Changing a filter is a new key; keep the current page visible while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: queryKeys.job(id),
    queryFn: ({ signal }) => request(`/jobs/${id}`, { schema: JobSchema, signal }),
    enabled: id.length > 0,
    // A terminal job cannot change, so the poll stops there; a live one is followed closely.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'running' || state === undefined ? 1_200 : false;
    },
    // The SSE stream drives updates while the job runs, but a tab that was in the background
    // must not show a finished job as running when it comes back.
    refetchOnWindowFocus: true,
  });
}

/**
 * Logs are fetched on demand and, while `live` is set, re-fetched on an interval.
 * The UI states that it is polling; it must never claim a stream it does not have.
 */
export function useJobLogs(id: string, live = false) {
  return useQuery({
    queryKey: queryKeys.jobLogs(id),
    queryFn: ({ signal }) => request(`/jobs/${id}/logs`, { schema: JobLogListSchema, signal }),
    enabled: id.length > 0,
    refetchInterval: live ? 1_500 : false,
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(`/jobs/${id}/cancel`, { schema: JobSchema, method: 'POST' }),
    onSuccess: (job) => {
      void client.invalidateQueries({ queryKey: queryKeys.job(job.id) });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export function useRetryJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(`/jobs/${id}/retry`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}
