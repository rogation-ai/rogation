import { describe, expect, it } from "vitest";
import {
  pickWinner,
  planClusterActions,
  type IncrementalInputState,
  type IncrementalLlmOutput,
} from "@/lib/evidence/clustering/actions";
import { ClusteringError } from "@/lib/evidence/clustering/errors";

function mk(
  id: string,
  frequency: number,
  createdAt: Date,
): { id: string; frequency: number; createdAt: Date } {
  return { id, frequency, createdAt };
}

describe("pickWinner", () => {
  it("picks the highest frequency", () => {
    const a = mk("a", 1, new Date("2026-01-01"));
    const b = mk("b", 5, new Date("2026-01-02"));
    const c = mk("c", 3, new Date("2026-01-01"));
    expect(pickWinner([a, b, c]).id).toBe("b");
  });

  it("tiebreaks by oldest createdAt", () => {
    const a = mk("a", 2, new Date("2026-01-05"));
    const b = mk("b", 2, new Date("2026-01-01"));
    const c = mk("c", 2, new Date("2026-01-03"));
    expect(pickWinner([a, b, c]).id).toBe("b");
  });

  it("final tiebreak: lexicographically lowest id", () => {
    const t = new Date("2026-01-01");
    const a = mk("zzz", 2, t);
    const b = mk("aaa", 2, t);
    const c = mk("mmm", 2, t);
    expect(pickWinner([a, b, c]).id).toBe("aaa");
  });

  it("is stable on identical input (no hidden randomness)", () => {
    const a = mk("a", 2, new Date("2026-01-01"));
    const b = mk("b", 2, new Date("2026-01-01"));
    const w1 = pickWinner([a, b]);
    const w2 = pickWinner([b, a]);
    const w3 = pickWinner([a, b]);
    expect(w1.id).toBe(w2.id);
    expect(w1.id).toBe(w3.id);
    expect(w1.id).toBe("a");
  });

  it("throws on empty input", () => {
    expect(() => pickWinner([])).toThrow(ClusteringError);
  });
});

describe("planClusterActions", () => {
  const baseState = (): IncrementalInputState => ({
    clusters: new Map([
      ["C1", mk("uuid-c1", 5, new Date("2026-01-01"))],
      ["C2", mk("uuid-c2", 3, new Date("2026-01-02"))],
      ["C3", mk("uuid-c3", 7, new Date("2026-01-03"))],
    ]),
    evidenceLabelToId: new Map([
      ["E1", "uuid-e1"],
      ["E2", "uuid-e2"],
      ["E3", "uuid-e3"],
      ["E4", "uuid-e4"],
    ]),
  });

  it("KEEP: resolves labels, records centroid recompute when evidence attaches", () => {
    const out: IncrementalLlmOutput = {
      actions: [
        {
          type: "KEEP",
          clusterLabel: "C1",
          newTitle: "Updated",
          newDescription: null,
          attachEvidence: ["E1", "E2"],
        },
      ],
    };
    const plan = planClusterActions(out, baseState());
    expect(plan.keeps).toEqual([
      {
        clusterId: "uuid-c1",
        newTitle: "Updated",
        newDescription: null,
        attachEvidenceIds: ["uuid-e1", "uuid-e2"],
      },
    ]);
    expect([...plan.centroidsToRecompute]).toEqual(["uuid-c1"]);
  });

  it("KEEP with no attachments skips centroid recompute", () => {
    const plan = planClusterActions(
      {
        actions: [
          {
            type: "KEEP",
            clusterLabel: "C1",
            newTitle: null,
            newDescription: null,
            attachEvidence: [],
          },
        ],
      },
      baseState(),
    );
    expect(plan.centroidsToRecompute.size).toBe(0);
  });

  it("MERGE: server picks deterministic winner, losers tombstone into winner", () => {
    // C3 has freq 7 (highest) → wins even though LLM listed C1 first.
    const out: IncrementalLlmOutput = {
      actions: [
        {
          type: "MERGE",
          clusterLabels: ["C1", "C3"],
          newTitle: "Merged",
          newDescription: "desc",
        },
      ],
    };
    const plan = planClusterActions(out, baseState());
    expect(plan.merges).toEqual([
      {
        winnerId: "uuid-c3",
        loserIds: ["uuid-c1"],
        newTitle: "Merged",
        newDescription: "desc",
      },
    ]);
    expect([...plan.centroidsToRecompute]).toEqual(["uuid-c3"]);
  });

  it("MERGE throws on < 2 inputs", () => {
    expect(() =>
      planClusterActions(
        {
          actions: [
            {
              type: "MERGE",
              clusterLabels: ["C1"],
              newTitle: "t",
              newDescription: "d",
            },
          ],
        },
        baseState(),
      ),
    ).toThrow(ClusteringError);
  });

  it("SPLIT: first child keepOriginId=true, rest false", () => {
    const out: IncrementalLlmOutput = {
      actions: [
        {
          type: "SPLIT",
          originLabel: "C2",
          children: [
            {
              title: "A",
              description: "a",
              severity: "high",
              evidenceLabels: ["E1"],
            },
            {
              title: "B",
              description: "b",
              severity: "low",
              evidenceLabels: ["E2"],
            },
          ],
        },
      ],
    };
    const plan = planClusterActions(out, baseState());
    expect(plan.splits).toHaveLength(1);
    expect(plan.splits[0]!.originId).toBe("uuid-c2");
    expect(plan.splits[0]!.children[0]!.keepOriginId).toBe(true);
    expect(plan.splits[0]!.children[1]!.keepOriginId).toBe(false);
    expect(plan.splits[0]!.children[0]!.evidenceIds).toEqual(["uuid-e1"]);
    expect([...plan.centroidsToRecompute]).toEqual(["uuid-c2"]);
  });

  it("NEW: produces fresh cluster, no centroid recompute (computed on insert)", () => {
    const out: IncrementalLlmOutput = {
      actions: [
        {
          type: "NEW",
          title: "t",
          description: "d",
          severity: "medium",
          evidenceLabels: ["E3", "E4"],
        },
      ],
    };
    const plan = planClusterActions(out, baseState());
    expect(plan.newClusters).toEqual([
      {
        title: "t",
        description: "d",
        severity: "medium",
        evidenceIds: ["uuid-e3", "uuid-e4"],
      },
    ]);
    expect(plan.centroidsToRecompute.size).toBe(0);
  });

  it("rejects unknown cluster label", () => {
    expect(() =>
      planClusterActions(
        {
          actions: [
            {
              type: "KEEP",
              clusterLabel: "C99",
              newTitle: null,
              newDescription: null,
              attachEvidence: [],
            },
          ],
        },
        baseState(),
      ),
    ).toThrow(/unknown_label|C99/);
  });

  it("rejects unknown evidence label", () => {
    expect(() =>
      planClusterActions(
        {
          actions: [
            {
              type: "KEEP",
              clusterLabel: "C1",
              newTitle: null,
              newDescription: null,
              attachEvidence: ["E99"],
            },
          ],
        },
        baseState(),
      ),
    ).toThrow(/E99/);
  });

  it("rejects duplicate evidence assignment across actions", () => {
    expect(() =>
      planClusterActions(
        {
          actions: [
            {
              type: "KEEP",
              clusterLabel: "C1",
              newTitle: null,
              newDescription: null,
              attachEvidence: ["E1"],
            },
            {
              type: "NEW",
              title: "t",
              description: "d",
              severity: "low",
              evidenceLabels: ["E1"],
            },
          ],
        },
        baseState(),
      ),
    ).toThrow(/duplicate_assignment|E1/);
  });

  it("rejects SPLIT with zero children", () => {
    expect(() =>
      planClusterActions(
        {
          actions: [
            {
              type: "SPLIT",
              originLabel: "C1",
              children: [],
            },
          ],
        },
        baseState(),
      ),
    ).toThrow(ClusteringError);
  });

  it("handles a mixed plan end-to-end", () => {
    const out: IncrementalLlmOutput = {
      actions: [
        {
          type: "KEEP",
          clusterLabel: "C1",
          newTitle: null,
          newDescription: null,
          attachEvidence: ["E1"],
        },
        {
          type: "MERGE",
          clusterLabels: ["C2", "C3"],
          newTitle: "m",
          newDescription: "md",
        },
        {
          type: "NEW",
          title: "n",
          description: "nd",
          severity: "critical",
          evidenceLabels: ["E4"],
        },
      ],
    };
    const plan = planClusterActions(out, baseState());
    expect(plan.keeps).toHaveLength(1);
    expect(plan.merges).toHaveLength(1);
    expect(plan.newClusters).toHaveLength(1);
    expect(plan.centroidsToRecompute.size).toBe(2); // C1 (attach) + merge winner
  });
});
