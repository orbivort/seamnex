import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PrivacyQueueSchema, PrivacyRequestSchema } from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

export function usePrivacyRequests() {
  return useQuery({
    queryKey: queryKeys.privacy,
    queryFn: ({ signal }) => request('/privacy/requests', { schema: PrivacyQueueSchema, signal }),
  });
}

export function useCreatePrivacyRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { subjectRef: string; kind: 'export' | 'delete' }) =>
      request('/privacy/requests', { schema: PrivacyRequestSchema, method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.privacy });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useAdvancePrivacyRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(`/privacy/requests/${id}/advance`, { schema: PrivacyRequestSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.privacy });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
