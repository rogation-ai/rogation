"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
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
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
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
