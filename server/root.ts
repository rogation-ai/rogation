import { accountRouter } from "@/server/routers/account";
import { billingRouter } from "@/server/routers/billing";
import { evidenceRouter } from "@/server/routers/evidence";
import { insightsRouter } from "@/server/routers/insights";
import { opportunitiesRouter } from "@/server/routers/opportunities";
import { specsRouter } from "@/server/routers/specs";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers (outcomes, integrations) mount
  here as they land.
*/
export const appRouter = router({
  account: accountRouter,
  billing: billingRouter,
  evidence: evidenceRouter,
  insights: insightsRouter,
  opportunities: opportunitiesRouter,
  specs: specsRouter,
});

export type AppRouter = typeof appRouter;
