import { TRPCError } from "@trpc/server";
import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/*
  Sentry noise filter. Attached as beforeSend on every runtime so the
  dashboard sees real bugs, not predictable user-input / auth errors.

  Dropped:
  - TRPCError with code UNAUTHORIZED / FORBIDDEN / NOT_FOUND / BAD_REQUEST.
    These are signals to the caller, not bugs in our code.
  - ZodError. Input validation, by construction.

  Kept (lets Sentry process them):
  - Everything else, including TRPCError with INTERNAL_SERVER_ERROR and
    any non-TRPC exception thrown inside a resolver.

  Pure function, unit-tested. Import where the Sentry configs call
  beforeSend so behavior stays in one place.
*/

const EXPECTED_TRPC_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "METHOD_NOT_SUPPORTED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
  "TIMEOUT",
]);

/**
 * Returns true when the error is routine application behavior that
 * should NOT reach Sentry. Exported for unit-testing + reuse from any
 * caller that wants the same "is this expected?" heuristic.
 */
export function isExpectedError(err: unknown): boolean {
  if (err instanceof TRPCError) {
    return EXPECTED_TRPC_CODES.has(err.code);
  }
  // zod errors have a `.issues` array. Duck-type it so we don't
  // couple to a specific zod version's class identity across bundle
  // boundaries.
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "ZodError"
  ) {
    return true;
  }
  return false;
}

/**
 * Sentry beforeSend hook. Return null to drop the event.
 */
export function sentryBeforeSend(
  event: ErrorEvent,
  hint: EventHint,
): ErrorEvent | null {
  if (isExpectedError(hint.originalException)) {
    return null;
  }
  return event;
}
