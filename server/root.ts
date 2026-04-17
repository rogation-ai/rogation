import { accountRouter } from "@/server/routers/account";
import { billingRouter } from "@/server/routers/billing";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers (evidence, insights, opportunities,
  specs, outcomes, integrations) mount here as they land.
*/
export const appRouter = router({
  account: accountRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
