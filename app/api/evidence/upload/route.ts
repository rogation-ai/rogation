import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { ingestEvidence } from "@/lib/evidence/ingest";
import { parseTextFile } from "@/lib/evidence/parsers/text";
import { splitIntoBlocks } from "@/lib/evidence/split-blocks";
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

  Optional form field `splitOnBlankLines=true`: split each .txt/.md
  into one evidence row per blank-line separated block. Right for
  pasted ticket dumps; wrong for transcripts with speaker turns. The
  UI surfaces this as a checkbox next to the dropzone.
*/

const MAX_FILES_PER_BATCH = 20;
const MAX_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request): Promise<NextResponse> {
  const form = await req.formData();
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  // Opt-in: split .txt/.md files into one evidence row per blank-line
  // separated block. Right for ticket dumps; wrong for transcripts.
  // Form fields are always strings — coerce to boolean explicitly.
  const splitOnBlankLines = form.get("splitOnBlankLines") === "true";

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

      // When splitting is enabled and the file parsed to > 1 block,
      // ingest each block as a separate evidence row. A file with no
      // blank-line separators returns 1 block and falls through to the
      // whole-file path — the checkbox can't silently break single-
      // block files.
      const blocks = splitOnBlankLines
        ? splitIntoBlocks(parsed.text)
        : [{ index: 1, text: parsed.text }];

      if (blocks.length === 0) {
        results.push({ filename: file.name, error: "File is empty" });
        continue;
      }

      const splitting = splitOnBlankLines && blocks.length > 1;

      for (const block of blocks) {
        if (capHit) break;
        const label = splitting
          ? `${file.name} #${block.index}`
          : file.name;
        const sourceRef = splitting
          ? `upload:${file.name}#block-${block.index}`
          : `upload:${file.name}`;

        try {
          const { id, deduped } = await ingestEvidence(
            { db: ctx.db, accountId: ctx.accountId, plan: ctx.plan },
            {
              content: block.text,
              sourceType: "upload_text",
              sourceRef,
              // Batch uploads offload embedding to Inngest. A 20-file
              // import (or one file split into 20 blocks) would
              // otherwise spend 20 × ~200ms = 4s on OpenAI calls
              // inside this request.
              embed: "defer",
            },
          );
          results.push({ filename: label, id, deduped });
        } catch (err) {
          if (
            err instanceof TRPCError &&
            err.code === "FORBIDDEN" &&
            err.cause &&
            typeof err.cause === "object" &&
            "type" in err.cause &&
            err.cause.type === "plan_limit_reached"
          ) {
            // Stop the batch — subsequent rows would all fail the
            // same cap. The last successful row is the last one the
            // UI shows before the paywall.
            capHit = err;
            results.push({ filename: label, error: err.message });
            break;
          }
          results.push({
            filename: label,
            error: err instanceof Error ? err.message : "Ingest failed",
          });
        }
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
