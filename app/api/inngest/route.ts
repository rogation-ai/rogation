import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { embedEvidence } from "@/lib/inngest/functions/embed-evidence";
import { clusterEvidence } from "@/lib/inngest/functions/cluster-evidence";
import { autoClusterCheck } from "@/lib/inngest/functions/auto-cluster-check";
import { syncSlack } from "@/lib/inngest/functions/sync-slack";

/*
  Inngest webhook endpoint. Inngest Cloud (or the local dev server)
  POSTs signed requests here to invoke registered functions. The
  request is verified against INNGEST_SIGNING_KEY by the SDK — no
  need to reach into headers here.

  Add every function to the `functions` array below when we register
  new background jobs. A missing function = a silently-dropped event.
*/
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [embedEvidence, clusterEvidence, autoClusterCheck, syncSlack],
});
