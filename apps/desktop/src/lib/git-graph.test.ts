import { describe, expect, it } from "vitest";
import { buildGitGraph, type GitGraphSegment } from "./git-graph";
import type { GitCommit } from "../types";

function commit(hash: string, parents: string[] = []): GitCommit {
  return {
    hash,
    parents,
    shortHash: hash,
    author: "A",
    date: "2026-09-26",
    subject: hash,
    refs: [],
    files: [],
  };
}

function segmentsBetweenRows(segments: GitGraphSegment[]) {
  return new Set(
    segments
      .filter((segment) => !segment.dashed && segment.toY === 1)
      .map((segment) => `${segment.toLane}:${segment.color}`),
  );
}

describe("buildGitGraph", () => {
  it("returns no lanes for empty history", () => {
    expect(buildGitGraph([])).toEqual({ rows: [], laneCount: 0 });
  });

  it("keeps one lane and one color across a linear first-parent history", () => {
    const graph = buildGitGraph([commit("tip", ["middle"]), commit("middle", ["root"]), commit("root")]);

    expect(graph.laneCount).toBe(1);
    expect(graph.rows.map(({ lane, color }) => [lane, color])).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(graph.rows[0].segments).toContainEqual({
      fromLane: 0,
      toLane: 0,
      fromY: 0.5,
      toY: 1,
      color: 0,
    });
    expect(graph.rows[1].segments).toContainEqual({
      fromLane: 0,
      toLane: 0,
      fromY: 0,
      toY: 0.5,
      color: 0,
    });
  });

  it.each([1000, 10000])("lays out every commit in a %i-commit linear history", (count) => {
    const commits = Array.from({ length: count }, (_, index) => {
      const hash = `commit-${index}`;
      const parent = index + 1 < count ? [`commit-${index + 1}`] : [];
      return commit(hash, parent);
    });
    const graph = buildGitGraph(commits);

    expect(graph.rows).toHaveLength(count);
    expect(graph.laneCount).toBe(1);
    expect(graph.rows[0].commit.hash).toBe("commit-0");
    expect(graph.rows.at(-1)?.commit.hash).toBe(`commit-${count - 1}`);
    expect(graph.rows.at(-1)?.hasHiddenParents).toBe(false);
  });

  it("keeps existing lanes in place when independent heads share ancestry", () => {
    const graph = buildGitGraph([
      commit("main-tip", ["shared"]),
      commit("feature-tip", ["shared"]),
      commit("shared", ["root"]),
      commit("root"),
    ]);
    const [main, feature, shared] = graph.rows;

    expect([main.lane, feature.lane]).toEqual([0, 1]);
    expect(feature.segments).toContainEqual({ fromLane: 0, toLane: 0, fromY: 0, toY: 1, color: 0 });
    expect(shared.color).toBe(main.color);
    expect(shared.segments).toContainEqual({ fromLane: 0, toLane: shared.lane, fromY: 0, toY: 0.5, color: main.color });
    expect(shared.segments).toContainEqual({ fromLane: 1, toLane: shared.lane, fromY: 0, toY: 0.5, color: feature.color });
  });

  it("preserves the first-parent color when a merge parent is already active", () => {
    const graph = buildGitGraph([
      commit("main-merge", ["shared", "side-root"]),
      commit("side-child", ["shared"]),
      commit("shared", ["base"]),
      commit("side-root"),
      commit("base"),
    ]);
    const mergeColor = graph.rows[0].color;
    const shared = graph.rows[2];

    expect(graph.rows[0].segments.some((segment) => segment.fromY === 0.5 && segment.color === mergeColor && segment.toY === 1)).toBe(true);
    expect(shared.color).toBe(mergeColor);
    expect(shared.segments.some((segment) => segment.fromLane !== shared.lane && segment.toY === 0.5)).toBe(true);
  });

  it("routes merges with more than two parents to distinct visible parent lanes", () => {
    const graph = buildGitGraph([
      commit("merge", ["first", "second", "third"]),
      commit("first"),
      commit("second"),
      commit("third"),
    ]);
    const merge = graph.rows[0];
    const outgoing = merge.segments.filter((segment) => segment.fromY === 0.5 && segment.toY === 1);

    expect(graph.laneCount).toBe(3);
    expect(new Set(outgoing.map((segment) => segment.toLane))).toEqual(new Set([0, 1, 2]));
  });

  it("reuses an empty lane without changing another lane's position", () => {
    const graph = buildGitGraph([
      commit("child-a", ["root-a"]),
      commit("child-b", ["root-b"]),
      commit("root-a"),
      commit("child-c", ["root-c"]),
      commit("root-b"),
      commit("root-c"),
    ]);

    expect(graph.rows.map((row) => row.lane)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(graph.rows[3].segments).toContainEqual({ fromLane: 1, toLane: 1, fromY: 0, toY: 1, color: graph.rows[1].color });
    expect(graph.laneCount).toBe(2);
  });

  it("marks omitted parents with a dashed stub and keeps explicit roots clean", () => {
    const graph = buildGitGraph([
      commit("cutoff", ["not-loaded"]),
      commit("root"),
    ]);

    expect(graph.rows[0].hasHiddenParents).toBe(true);
    expect(graph.rows[0].segments).toContainEqual({
      fromLane: 0,
      toLane: 0,
      fromY: 0.5,
      toY: 1,
      color: 0,
      dashed: true,
    });
    expect(graph.rows[1].hasHiddenParents).toBe(false);
    expect(graph.rows[1].segments.some((segment) => segment.dashed)).toBe(false);
  });

  it("treats an omitted parent list as unknown instead of a confirmed root", () => {
    const unknownParents = { ...commit("unknown"), parents: undefined };
    const graph = buildGitGraph([unknownParents]);

    expect(graph.rows[0].hasHiddenParents).toBe(true);
    expect(graph.rows[0].segments.some((segment) => segment.dashed)).toBe(true);
  });

  it("uses the same lane and color coordinates at every loaded row boundary", () => {
    const graph = buildGitGraph([
      commit("merge", ["main", "side"]),
      commit("main-child", ["main"]),
      commit("main", ["root"]),
      commit("side", ["root"]),
      commit("root"),
    ]);

    for (let index = 0; index < graph.rows.length - 1; index += 1) {
      expect(segmentsBetweenRows(graph.rows[index].segments)).toEqual(
        new Set(
          graph.rows[index + 1].segments
            .filter((segment) => !segment.dashed && segment.fromY === 0)
            .map((segment) => `${segment.fromLane}:${segment.color}`),
        ),
      );
    }

    for (const row of graph.rows) {
      for (const segment of row.segments) {
        expect([0, 0.5]).toContain(segment.fromY);
        expect([0.5, 1]).toContain(segment.toY);
        expect(segment.fromLane).toBeGreaterThanOrEqual(0);
        expect(segment.toLane).toBeGreaterThanOrEqual(0);
        expect(segment.fromLane).toBeLessThan(graph.laneCount);
        expect(segment.toLane).toBeLessThan(graph.laneCount);
      }
    }
  });
});
