import { accountRouter } from "@/server/routers/account";
import { billingRouter } from "@/server/routers/billing";
import { evidenceRouter } from "@/server/routers/evidence";
import { feedbackRouter } from "@/server/routers/feedback";
import { insightsRouter } from "@/server/routers/insights";
import { learningRouter } from "@/server/routers/learning";
import { integrationsRouter } from "@/server/routers/integrations";
import { opportunitiesRouter } from "@/server/routers/opportunities";
import { outcomesRouter } from "@/server/routers/outcomes";
import { scopesRouter } from "@/server/routers/scopes";
import { specsRouter } from "@/server/routers/specs";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers mount here.
*/
export const appRouter = router({
  account: accountRouter,
  billing: billingRouter,
  evidence: evidenceRouter,
  feedback: feedbackRouter,
  insights: insightsRouter,
  integrations: integrationsRouter,
  learning: learningRouter,
  opportunities: opportunitiesRouter,
  outcomes: outcomesRouter,
  scopes: scopesRouter,
  specs: specsRouter,
});

export type AppRouter = typeof appRouter;
