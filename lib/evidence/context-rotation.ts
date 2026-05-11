import { createHash } from "crypto";

export type RotationFlag = "on" | "off" | "rotate";
export type RotationCallType = "clustering" | "opportunity" | "spec";

export function shouldUseContext(
  rotationFlag: RotationFlag,
  accountId: string,
  runId: string,
  callType: RotationCallType,
): boolean {
  if (rotationFlag === "on") return true;
  if (rotationFlag === "off") return false;

  if (callType === "clustering") {
    return hashMod2(accountId + runId) === 0;
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  return hashMod2(accountId + dateKey) === 0;
}

function hashMod2(input: string): number {
  const hash = createHash("sha256").update(input).digest();
  return hash[0]! % 2;
}
