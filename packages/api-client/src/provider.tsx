import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';
import { ApiError } from './http';

export type ApiProviderProps = {
  children: ReactNode;
  /**
   * Changing this key discards the whole query cache. The apps pass the role and scenario
   * so a permission change never renders another role's data.
   */
  resetKey?: string;
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A 4xx is a decision, not a blip: retrying it only delays the error state.
        retry: (failureCount, error) => {
          if (
            error instanceof ApiError &&
            error.problem.status >= 400 &&
            error.problem.status < 500
          )
            return false;
          return failureCount < 2;
        },
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

function QueryScope({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function ApiProvider({ children, resetKey = 'default' }: ApiProviderProps) {
  return (
    <Fragment key={resetKey}>
      <QueryScope>{children}</QueryScope>
    </Fragment>
  );
}
