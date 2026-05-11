import { describe, expect, it } from "vitest";
import {
  centroidOf,
  cosineSim,
  farthestFirstIndices,
  nearestClusters,
} from "@/lib/evidence/clustering/knn";
import { ClusteringError } from "@/lib/evidence/clustering/errors";

describe("centroidOf", () => {
  it("throws on zero vectors", () => {
    expect(() => centroidOf([])).toThrow(ClusteringError);
  });

  it("returns the single vector unchanged (divided by 1)", () => {
    expect(centroidOf([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("averages element-wise across N vectors", () => {
    const out = centroidOf([
      [1, 0, 4],
      [3, 2, 0],
    ]);
    expect(out).toEqual([2, 1, 2]);
  });

  it("handles small magnitudes without catastrophic cancellation", () => {
    // Mean of 1e-7 and 3e-7 = 2e-7. Exercise numeric stability on
    // values in the scale of actual cosine-normalized embeddings.
    const out = centroidOf([
      [1e-7, 2e-7],
      [3e-7, 4e-7],
    ]);
    expect(out[0]).toBeCloseTo(2e-7, 10);
    expect(out[1]).toBeCloseTo(3e-7, 10);
  });

  it("throws on dimension mismatch", () => {
    expect(() =>
      centroidOf([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toThrow(ClusteringError);
  });

  it("throws on zero-dim vectors", () => {
    expect(() => centroidOf([[]])).toThrow(ClusteringError);
  });
});

describe("cosineSim", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSim([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when either side is zero-vector", () => {
    expect(cosineSim([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSim([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSim([1, 2], [1, 2, 3])).toThrow(ClusteringError);
  });
});

describe("nearestClusters", () => {
  const query = [1, 0];
  const candidates = [
    { id: "a", centroid: [0.9, 0.1] },
    { id: "b", centroid: [0.1, 0.9] },
    { id: "c", centroid: [1, 0] },
  ];

  it("returns candidates sorted by similarity descending", () => {
    const hits = nearestClusters(query, candidates, 3);
    expect(hits.map((h) => h.id)).toEqual(["c", "a", "b"]);
  });

  it("caps at k", () => {
    const hits = nearestClusters(query, candidates, 2);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.id)).toEqual(["c", "a"]);
  });

  it("returns [] for k <= 0", () => {
    expect(nearestClusters(query, candidates, 0)).toEqual([]);
    expect(nearestClusters(query, candidates, -1)).toEqual([]);
  });

  it("returns [] for no candidates", () => {
    expect(nearestClusters(query, [], 5)).toEqual([]);
  });
});

describe("farthestFirstIndices", () => {
  it("returns every index when items.length <= k", () => {
    const items = [
      { embedding: [1, 0] },
      { embedding: [0, 1] },
    ];
    expect(farthestFirstIndices(items, 5)).toEqual([0, 1]);
  });

  it("returns [] for k <= 0 or empty input", () => {
    expect(farthestFirstIndices([], 5)).toEqual([]);
    expect(farthestFirstIndices([{ embedding: [1] }], 0)).toEqual([]);
    expect(farthestFirstIndices([{ embedding: [1] }], -1)).toEqual([]);
  });

  it("picks the outliers across a clearly clustered set", () => {
    // Three tight clusters around (1,0), (0,1), (-1,0). FFT should
    // pick one representative from each, not three from the same
    // corner like a recency sort would.
    const items = [
      { embedding: [1.0, 0.0] },
      { embedding: [0.99, 0.01] },
      { embedding: [0.98, 0.02] },
      { embedding: [0.0, 1.0] },
      { embedding: [0.01, 0.99] },
      { embedding: [0.02, 0.98] },
      { embedding: [-1.0, 0.0] },
      { embedding: [-0.99, 0.01] },
      { embedding: [-0.98, 0.02] },
    ];
    const picks = farthestFirstIndices(items, 3);
    expect(picks).toHaveLength(3);
    // Determine which cluster each pick belongs to by sign of x.
    const clusters = picks.map((i) => {
      const x = items[i]!.embedding[0]!;
      const y = items[i]!.embedding[1]!;
      if (x > 0.5) return "right";
      if (x < -0.5) return "left";
      if (y > 0.5) return "top";
      return "other";
    });
    // All three distinct cluster labels covered.
    expect(new Set(clusters).size).toBe(3);
  });

  it("never picks the same index twice", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      embedding: [Math.cos(i), Math.sin(i)],
    }));
    const picks = farthestFirstIndices(items, 5);
    expect(picks).toHaveLength(5);
    expect(new Set(picks).size).toBe(5);
  });
});
