import { describe, expect, it } from "vitest";
import {
  assertLabelsResolve,
  assertMergeWinnersPresent,
  assertNoDuplicateAssignments,
  assertSplitsHaveChildren,
} from "@/lib/evidence/clustering/validators";
import { ClusteringError } from "@/lib/evidence/clustering/errors";

describe("assertLabelsResolve", () => {
  it("passes when every label is known", () => {
    expect(() =>
      assertLabelsResolve(["E1", "E2"], new Set(["E1", "E2", "E3"]), "evidence"),
    ).not.toThrow();
  });

  it("throws on the first unknown label", () => {
    try {
      assertLabelsResolve(["E1", "E99"], new Set(["E1"]), "evidence");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClusteringError);
      expect((e as ClusteringError).code).toBe("unknown_label");
      expect((e as ClusteringError).message).toContain("E99");
    }
  });

  it("accepts empty input", () => {
    expect(() =>
      assertLabelsResolve([], new Set(["E1"]), "cluster"),
    ).not.toThrow();
  });
});

describe("assertNoDuplicateAssignments", () => {
  it("passes when every label appears once across lists", () => {
    expect(() =>
      assertNoDuplicateAssignments([
        ["E1", "E2"],
        ["E3", "E4"],
      ]),
    ).not.toThrow();
  });

  it("throws when a label appears in two lists", () => {
    expect(() =>
      assertNoDuplicateAssignments([
        ["E1", "E2"],
        ["E2", "E3"],
      ]),
    ).toThrow(ClusteringError);
  });

  it("throws when a label appears twice in the same list", () => {
    try {
      assertNoDuplicateAssignments([["E1", "E1"]]);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ClusteringError).code).toBe("duplicate_assignment");
    }
  });
});

describe("assertMergeWinnersPresent", () => {
  it("passes when every winner id is in the input set", () => {
    expect(() =>
      assertMergeWinnersPresent(["C1", "C2"], new Set(["C1", "C2", "C3"])),
    ).not.toThrow();
  });

  it("throws on a winner id not in the input", () => {
    try {
      assertMergeWinnersPresent(["C99"], new Set(["C1"]));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ClusteringError).code).toBe("merge_winner_missing");
    }
  });
});

describe("assertSplitsHaveChildren", () => {
  it("passes when every split has >= 1 child", () => {
    expect(() =>
      assertSplitsHaveChildren([
        { children: [{}] },
        { children: [{}, {}] },
      ]),
    ).not.toThrow();
  });

  it("throws on zero-child SPLIT", () => {
    try {
      assertSplitsHaveChildren([{ children: [] }]);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ClusteringError).code).toBe("split_no_children");
    }
  });
});
