import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import { isExpectedError, sentryBeforeSend } from "@/lib/sentry-filter";
import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/*
  Pure unit tests over the Sentry noise filter. No network, no SDK
  mocking — just the classifier behavior.

  The Sentry dashboard is only useful when the noise floor is low.
  These assertions guard the rules that keep expected app behavior out
  of the alert stream while still letting real bugs through.
*/

describe("isExpectedError", () => {
  it.each([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "BAD_REQUEST",
    "TOO_MANY_REQUESTS",
    "CONFLICT",
  ] as const)("drops TRPCError with code %s (routine user-input / auth)", (code) => {
    expect(isExpectedError(new TRPCError({ code, message: "x" }))).toBe(true);
  });

  it("keeps TRPCError with code INTERNAL_SERVER_ERROR (real bug)", () => {
    expect(
      isExpectedError(
        new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "db connection lost" }),
      ),
    ).toBe(false);
  });

  it("drops ZodError (input validation, not a bug)", () => {
    const err = new ZodError([]);
    expect(isExpectedError(err)).toBe(true);
  });

  it("keeps generic exceptions (unknown = likely bug)", () => {
    expect(isExpectedError(new Error("kaboom"))).toBe(false);
    expect(isExpectedError("a string")).toBe(false);
    expect(isExpectedError(null)).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
  });
});

describe("sentryBeforeSend", () => {
  const baseEvent: ErrorEvent = { type: undefined };

  it("returns null for expected errors (drops the event)", () => {
    const hint = {
      originalException: new TRPCError({ code: "FORBIDDEN", message: "upgrade" }),
    } as EventHint;

    expect(sentryBeforeSend(baseEvent, hint)).toBeNull();
  });

  it("passes real errors through unchanged", () => {
    const hint = { originalException: new Error("boom") } as EventHint;
    expect(sentryBeforeSend(baseEvent, hint)).toBe(baseEvent);
  });

  it("passes events with no originalException through (rare but defensive)", () => {
    const hint = {} as EventHint;
    expect(sentryBeforeSend(baseEvent, hint)).toBe(baseEvent);
  });
});
