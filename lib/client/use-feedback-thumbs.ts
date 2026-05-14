"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { ThumbsRating } from "@/components/ui/FeedbackThumbs";

/*
  Client hook: given an entity type + a batch of ids, returns:
    - a lookup of each id's current vote (or null)
    - a `setVote(id, next)` callback that UPSERTs via trpc.feedback.vote
      or DELETEs via trpc.feedback.remove, then invalidates the cache
      so the thumb toggle paints instantly.

  Pattern: a feature screen renders N entities, calls this once with
  all ids, then does `<FeedbackThumbs value={votes[id]} onChange={(v) =>
  setVote(id, v)} />` per row. No N+1 queries.
*/

export type FeedbackEntityType = "insight_cluster" | "opportunity" | "spec";

export interface UseFeedbackThumbs {
  votes: Record<string, ThumbsRating>;
  setVote: (entityId: string, next: ThumbsRating) => void;
  isPending: boolean;
}

export function useFeedbackThumbs(
  entityType: FeedbackEntityType,
  entityIds: string[],
): UseFeedbackThumbs {
  const utils = trpc.useUtils();
  const mine = trpc.feedback.mine.useQuery(
    { entityType, entityIds },
    { enabled: entityIds.length > 0 },
  );

  const vote = trpc.feedback.vote.useMutation({
    onSuccess: () =>
      utils.feedback.mine.invalidate({ entityType, entityIds }),
  });
  const remove = trpc.feedback.remove.useMutation({
    onSuccess: () =>
      utils.feedback.mine.invalidate({ entityType, entityIds }),
  });

  const votes = useMemo<Record<string, ThumbsRating>>(() => {
    const lookup: Record<string, ThumbsRating> = {};
    for (const v of mine.data ?? []) {
      // ThumbsRating only handles "up" | "down" | null — dismiss
      // ratings are a separate feedback surface, not shown in thumbs.
      lookup[v.entityId] =
        v.rating === "up" || v.rating === "down" ? v.rating : null;
    }
    return lookup;
  }, [mine.data]);

  function setVote(entityId: string, next: ThumbsRating): void {
    if (next === null) {
      remove.mutate({ entityType, entityId });
    } else {
      vote.mutate({ entityType, entityId, rating: next });
    }
  }

  return {
    votes,
    setVote,
    isPending: vote.isPending || remove.isPending,
  };
}
