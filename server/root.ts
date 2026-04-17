import { accountRouter } from "@/server/routers/account";
import { billingRouter } from "@/server/routers/billing";
import { evidenceRouter } from "@/server/routers/evidence";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers (insights, opportunities, specs,
  outcomes, integrations) mount here as they land.
*/
export const appRouter = router({
  account: accountRouter,
  billing: billingRouter,
  evidence: evidenceRouter,
});

export type AppRouter = typeof appRouter;
