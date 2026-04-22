"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { Toaster } from "sonner";
import { trpc } from "@/lib/trpc";
import { initPostHog, identify, reset } from "@/lib/analytics/posthog-client";

/*
  Client-side providers. Wraps the app in TanStack Query + tRPC +
  PostHog so any client component can call trpc hooks + the app
  captures the activation funnel.

  PostHog init runs once on mount and is idempotent. identify() fires
  when Clerk resolves a user; reset() fires on sign-out so the shared
  machine doesn't mix two users' events.
*/
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AnalyticsBridge />
        <QueryCacheResetOnSignInChange queryClient={queryClient} />
        {children}
        {/*
          Shared toast surface. Every async action (paste evidence,
          push to Linear, regenerate, etc.) reports success / error
          through toast.success / toast.error — no silent 500s.
          theme=dark picks our palette; closeButton lets users
          dismiss manually if they're distracted.
        */}
        <Toaster
          theme="dark"
          position="bottom-right"
          richColors
          closeButton
        />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/*
  Clears the TanStack Query cache whenever the Clerk userId changes
  (sign-out, sign-in as a different user). Without this, queries
  cached under user A's session continue to serve to user B after a
  quick sign-out + sign-in — a UX bug (stale "Connected" states) and
  a privacy bug on shared machines (user B briefly sees user A's
  integration list / evidence / specs from cache).

  We detect the transition by comparing against a ref so the very
  first render (userId = previous) doesn't clear a fresh cache.
*/
function QueryCacheResetOnSignInChange({
  queryClient,
}: {
  queryClient: QueryClient;
}) {
  const { userId, isLoaded } = useAuth();
  const lastUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    const prev = lastUserIdRef.current;
    // First settled read — just record and do nothing.
    if (prev === undefined) {
      lastUserIdRef.current = userId ?? null;
      return;
    }
    // Actual transition: sign-out (userId → null), sign-in (null → id),
    // or user swap (id-A → id-B). Clear the cache in every case so
    // no response from the old session survives.
    if (prev !== (userId ?? null)) {
      queryClient.clear();
      lastUserIdRef.current = userId ?? null;
    }
  }, [isLoaded, userId, queryClient]);

  return null;
}

/*
  Connects Clerk's session state to PostHog. Mounted once inside the
  provider tree so useUser() has access to the Clerk context.
*/
function AnalyticsBridge() {
  const { isSignedIn, user } = useUser();

  useEffect(() => {
    initPostHog();
  }, []);

  useEffect(() => {
    if (isSignedIn && user) {
      identify(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
      });
    } else if (isSignedIn === false) {
      reset();
    }
  }, [isSignedIn, user]);

  return null;
}
