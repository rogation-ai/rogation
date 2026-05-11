import { eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import type { Tx } from "@/db/scoped";
import type { CompleteOpts } from "@/lib/llm/router";
import type { RotationCallType } from "./context-rotation";
import { shouldUseContext } from "./context-rotation";
import {
  assembleContextBundle,
  hasNonEmptyContext,
  PRODUCT_CONTEXT_SYSTEM_INSTRUCTION,
} from "./product-context-bundle";

export interface ProductContextResult {
  contextUsed: boolean;
  promptOpts: CompleteOpts;
  productContextBlock: string | undefined;
}

export async function loadProductContext(
  db: Tx,
  accountId: string,
  runId: string,
  callType: RotationCallType,
  baseOpts: CompleteOpts = {},
): Promise<ProductContextResult> {
  const [account] = await db
    .select({
      productBrief: accounts.productBrief,
      productBriefStructured: accounts.productBriefStructured,
      flagProductContextV1: accounts.flagProductContextV1,
      flagProductContextV1Rotation: accounts.flagProductContextV1Rotation,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));

  if (!account || !account.flagProductContextV1) {
    return { contextUsed: false, promptOpts: baseOpts, productContextBlock: undefined };
  }

  const rotationFlag = (account.flagProductContextV1Rotation || "off") as "on" | "off" | "rotate";

  if (!hasNonEmptyContext(account.productBrief, account.productBriefStructured)) {
    return { contextUsed: false, promptOpts: baseOpts, productContextBlock: undefined };
  }

  const useContext = shouldUseContext(rotationFlag, accountId, runId, callType);
  if (!useContext) {
    return { contextUsed: false, promptOpts: baseOpts, productContextBlock: undefined };
  }

  const { block } = assembleContextBundle(
    account.productBrief,
    account.productBriefStructured,
  );

  return {
    contextUsed: true,
    promptOpts: {
      ...baseOpts,
      contextSystemInstruction: PRODUCT_CONTEXT_SYSTEM_INSTRUCTION,
    },
    productContextBlock: block,
  };
}
