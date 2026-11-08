import { createContext, useContext, useMemo } from 'react';
import { createClient, useOptionalStacks } from '@stacks/web';
import { createApi, type Api } from './api';

/** Lets components (and tests) get the API client without caring how auth works. */
export const ApiContext = createContext<Api | null>(null);

/** Book Club's typed API, over the Stacks session (an HttpOnly cookie; no token here). */
export function useApi(): Api {
  const fromContext = useContext(ApiContext);
  const client = useOptionalStacks()?.api;
  const api = useMemo(() => createApi(client ?? createClient()), [client]);
  return fromContext ?? api;
}
