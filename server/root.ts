import { accountRouter } from "@/server/routers/account";
import { billingRouter } from "@/server/routers/billing";
import { evidenceRouter } from "@/server/routers/evidence";
import { insightsRouter } from "@/server/routers/insights";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers (opportunities, specs, outcomes,
  integrations) mount here as they land.
*/
export const appRouter = router({
  account: accountRouter,
  billing: billingRouter,
  evidence: evidenceRouter,
  insights: insightsRouter,
});

export type AppRouter = typeof appRouter;
