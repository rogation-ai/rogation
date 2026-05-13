import { sql, eq, count } from "drizzle-orm";
import { inngest } from "@/lib/inngest/client";
import { db } from "@/db/client";
import { integrationState, evidence } from "@/db/schema";
import { bindAccountToTx } from "@/db/scoped";
import { dispatchClusterRun } from "@/lib/evidence/clustering/dispatch";

/*
  Auto-cluster cron. Runs every 5 minutes, checks each account with
  active connectors for enough new evidence to trigger clustering.

  Architecture (from eng review D3):
  - Debounce was rejected because it never fires on channels with steady
    traffic (the debounce keeps resetting). Cron guarantees clustering
    runs within 5 minutes of hitting the threshold.
  - One COUNT query per active account per 5 minutes -- negligible load.
  - Respects existing cluster-run rate limit (10/hour/account) and
    dispatchClusterRun dedup (no concurrent runs per account).
*/

const AUTO_CLUSTER_THRESHOLD = 10;

export const autoClusterCheck = inngest.createFunction(
  {
    id: "auto-cluster-check",
    retries: 0,
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    return step.run("check-and-dispatch", async () => {
      const activeAccounts = await db
        .selectDistinct({ accountId: integrationState.accountId })
        .from(integrationState)
        .where(eq(integrationState.status, "active"));

      if (activeAccounts.length === 0) return { checked: 0, dispatched: 0 };

      let dispatched = 0;

      for (const { accountId } of activeAccounts) {
        const newCount = await countNewEvidenceSinceLastRun(accountId);

        if (newCount >= AUTO_CLUSTER_THRESHOLD) {
          try {
            await db.transaction(async (tx) => {
              await bindAccountToTx(tx, accountId);
              await dispatchClusterRun({ db: tx, accountId });
            });
            dispatched++;
          } catch {
            // Rate limit hit or concurrent run exists -- both expected.
          }
        }
      }

      return { checked: activeAccounts.length, dispatched };
    });
  },
);

async function countNewEvidenceSinceLastRun(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(evidence)
    .where(
      sql`${evidence.accountId} = ${accountId}
        AND ${evidence.createdAt} > COALESCE(
          (SELECT MAX(created_at) FROM insight_run WHERE account_id = ${accountId}),
          '1970-01-01'::timestamptz
        )`,
    );
  return row?.n ?? 0;
}
