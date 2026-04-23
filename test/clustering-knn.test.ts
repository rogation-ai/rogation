import { describe, expect, it } from "vitest";
import { centroidOf, cosineSim, nearestClusters } from "@/lib/evidence/clustering/knn";
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
