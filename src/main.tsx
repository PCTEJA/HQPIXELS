/**
 * Client entry point.
 *
 * Intentionally tiny. Everything heavy — the PixiJS renderer, the claim wizard,
 * the admin surface — is a lazy route so the initial JavaScript payload stays
 * small. See the `manualChunks` config in vite.config.ts.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { SessionProvider } from './lib/session';
import { ApiRequestError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching on every window focus is a lot of requests for a wall that
      // changes a few times a day; the manifest-version watcher covers freshness.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 30_000,
      retry: (attemptIndex, error) => {
        // Never retry an auth or validation failure: it will not succeed, and
        // retrying delays showing the user what is actually wrong.
        if (error instanceof ApiRequestError) {
          if (error.isAuthError) return false;
          if (error.status >= 400 && error.status < 500 && error.status !== 429) return false;
        }
        return attemptIndex < 2;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    },
    mutations: {
      // Mutations here move money and inventory. A blanket retry policy on that
      // is how duplicates happen; each mutation opts in explicitly instead.
      retry: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
