import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { ingestEvidence } from "@/lib/evidence/ingest";
import { parseTextFile } from "@/lib/evidence/parsers/text";
import { withAuthedAccountTx } from "@/server/auth";

/*
  POST /api/evidence/upload

  Multipart form endpoint for file-based evidence ingestion. tRPC's
  transport doesn't do binary uploads cleanly — a plain Route Handler
  is the right shape for this one path.

  Each file runs through the shared ingest pipeline
  (lib/evidence/ingest.ts) so paste + upload can't drift. The
  response is per-file so the UI can show a list like:
    ✓ alice-interview.txt  (added, 1024 tokens)
    — bob-interview.txt    (deduped)
    ✗ report.pdf           (unsupported — PDF lands in next commit)

  Stop conditions:
    - Not signed in → 401.
    - Zero files → 400.
    - Batch count > 20 → 400.
    - Batch total size > 10 MB → 413.

  Per-file errors don't abort the batch; they're reported alongside
  successes in the `results` array. The one exception is plan-limit
  enforcement: hitting the Free 10-row cap throws FORBIDDEN and the
  remaining files in the batch are NOT processed (to stay within cap).
*/

const MAX_FILES_PER_BATCH = 20;
const MAX_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request): Promise<NextResponse> {
  const form = await req.formData();
  const files = form.getAll("files").filter((v): v is File => v instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  if (files.length > MAX_FILES_PER_BATCH) {
    return NextResponse.json(
      { error: `Batch exceeds ${MAX_FILES_PER_BATCH} files` },
      { status: 400 },
    );
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_BATCH_BYTES) {
    return NextResponse.json(
      { error: "Batch exceeds 10 MB total" },
      { status: 413 },
    );
  }

  const result = await withAuthedAccountTx(async (ctx) => {
    const results: Array<
      | { filename: string; id: string; deduped: boolean }
      | { filename: string; error: string }
    > = [];
    let capHit: TRPCError | null = null;

    for (const file of files) {
      if (capHit) break;

      const parsed = await parseTextFile(file);
      if (!parsed.ok) {
        results.push({ filename: file.name, error: parsed.detail });
        continue;
      }

      try {
        const { id, deduped } = await ingestEvidence(
          { db: ctx.db, accountId: ctx.accountId, plan: ctx.plan },
          {
            content: parsed.text,
            sourceType: "upload_text",
            sourceRef: `upload:${file.name}`,
            // Batch uploads offload embedding to Inngest. A 20-file
            // import would otherwise spend 20 × ~200ms = 4s on
            // OpenAI calls inside this request.
            embed: "defer",
          },
        );
        results.push({ filename: file.name, id, deduped });
      } catch (err) {
        if (
          err instanceof TRPCError &&
          err.code === "FORBIDDEN" &&
          err.cause &&
          typeof err.cause === "object" &&
          "type" in err.cause &&
          err.cause.type === "plan_limit_reached"
        ) {
          // Stop the batch — subsequent files would all fail the
          // same cap and we don't want to spam the client with N
          // identical errors. The last successful file is the last
          // one the UI shows before the paywall.
          capHit = err;
          results.push({ filename: file.name, error: err.message });
          break;
        }
        results.push({
          filename: file.name,
          error: err instanceof Error ? err.message : "Ingest failed",
        });
      }
    }

    return { results, capHit };
  });

  if (!result) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  return NextResponse.json({
    results: result.results,
    capHit: result.capHit
      ? { code: result.capHit.code, message: result.capHit.message }
      : null,
  });
}
