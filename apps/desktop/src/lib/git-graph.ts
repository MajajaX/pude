import type { GitCommit } from "../types";

export const GIT_GRAPH_PALETTE_SIZE = 6;

export type GitGraphSegment = {
  fromLane: number;
  toLane: number;
  fromY: 0 | 0.5;
  toY: 0.5 | 1;
  color: number;
  dashed?: boolean;
};

export type GitGraphRow = {
  commit: GitCommit;
  lane: number;
  color: number;
  segments: GitGraphSegment[];
  hasHiddenParents: boolean;
};

export type GitGraph = {
  rows: GitGraphRow[];
  laneCount: number;
};

type ActiveLane = {
  target: string;
  color: number;
  priority: number;
};

function firstFreeLane(lanes: Array<ActiveLane | undefined>, excludedLane?: number): number {
  for (let lane = 0; lane < lanes.length; lane += 1) {
    if (lane !== excludedLane && lanes[lane] === undefined) return lane;
  }
  return lanes.length === excludedLane ? lanes.length + 1 : lanes.length;
}

function trimEmptyTrailingLanes(lanes: Array<ActiveLane | undefined>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop();
}

/**
 * Assigns fixed horizontal lanes to a newest-to-oldest, topologically sorted
 * commit list. Missing parents get a dashed terminal segment, never an active
 * lane that could be mistaken for a loaded commit.
 */
export function buildGitGraph(commits: GitCommit[]): GitGraph {
  const commitIndexes = new Map(commits.map((commit, index) => [commit.hash, index]));
  const rows: GitGraphRow[] = [];
  let lanes: Array<ActiveLane | undefined> = [];
  let nextColor = 0;
  let nextPriority = 0;
  let laneCount = 0;

  const noteLane = (lane: number) => {
    laneCount = Math.max(laneCount, lane + 1);
  };

  for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
    const commit = commits[commitIndex];
    const parents = commit.parents ?? [];
    const uniqueParents = [...new Set(parents)];
    const laterParents = uniqueParents.filter((parent) => {
      const parentIndex = commitIndexes.get(parent);
      return parentIndex !== undefined && parentIndex > commitIndex;
    });
    const visibleParents = new Set(laterParents);
    const hasHiddenParents = commit.parents === undefined || visibleParents.size < uniqueParents.length;

    const incomingLanes = lanes
      .map((lane, index) => (lane?.target === commit.hash ? index : -1))
      .filter((index) => index >= 0);
    const lane = incomingLanes.length > 0
      ? incomingLanes.reduce((preferred, candidate) =>
          lanes[candidate]!.priority < lanes[preferred]!.priority ? candidate : preferred)
      : firstFreeLane(lanes);
    noteLane(lane);

    const color = incomingLanes.length > 0
      ? lanes[lane]!.color
      : nextColor++ % GIT_GRAPH_PALETTE_SIZE;
    const priority = incomingLanes.length > 0 ? lanes[lane]!.priority : nextPriority++;
    const segments: GitGraphSegment[] = [];

    for (let activeLane = 0; activeLane < lanes.length; activeLane += 1) {
      const active = lanes[activeLane];
      if (!active) continue;

      if (active.target === commit.hash) {
        segments.push({
          fromLane: activeLane,
          toLane: lane,
          fromY: 0,
          toY: 0.5,
          color: active.color,
        });
      } else {
        segments.push({
          fromLane: activeLane,
          toLane: activeLane,
          fromY: 0,
          toY: 1,
          color: active.color,
        });
      }
    }

    const after = [...lanes];
    for (const incomingLane of incomingLanes) after[incomingLane] = undefined;

    const routedParents = new Set<string>();
    for (const parent of laterParents) {
      if (routedParents.has(parent)) continue;
      routedParents.add(parent);
      const isFirstParent = parents[0] === parent;
      const existingLanes = after
        .map((activeLane, index) => (activeLane?.target === parent ? index : -1))
        .filter((index) => index >= 0);

      if (isFirstParent) {
        // Keep the first-parent color attached to this path until it reaches
        // its parent, even when another child already has that parent queued.
        let parentLane = lane;
        if (after[parentLane] !== undefined) parentLane = firstFreeLane(after);
        noteLane(parentLane);
        after[parentLane] = { target: parent, color, priority };
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color,
        });
      } else if (existingLanes.length > 0) {
        const parentLane = existingLanes.reduce((preferred, candidate) =>
          after[candidate]!.priority < after[preferred]!.priority ? candidate : preferred);
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color: after[parentLane]!.color,
        });
      } else {
        const hiddenFirstParent = parents[0] !== undefined && !visibleParents.has(parents[0]);
        const parentLane = firstFreeLane(after, hiddenFirstParent ? lane : undefined);
        noteLane(parentLane);
        const parentColor = nextColor++ % GIT_GRAPH_PALETTE_SIZE;
        after[parentLane] = { target: parent, color: parentColor, priority: nextPriority++ };
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color: parentColor,
        });
      }
    }

    if (hasHiddenParents) {
      const firstParentIsHidden = commit.parents === undefined
        || (parents.length > 0 && !visibleParents.has(parents[0]));
      const firstParentIsVisible = parents[0] !== undefined && visibleParents.has(parents[0]);
      // A hidden first parent gets a visible dashed stub. If a visible first
      // parent already uses the same path, hasHiddenParents carries the hidden
      // ancestry signal without obscuring that solid first-parent connection.
      if (firstParentIsHidden || !firstParentIsVisible) {
        segments.push({
          fromLane: lane,
          toLane: lane,
          fromY: 0.5,
          toY: 1,
          color,
          dashed: true,
        });
      }
    }

    trimEmptyTrailingLanes(after);
    lanes = after;
    rows.push({ commit, lane, color, segments, hasHiddenParents });
  }

  return { rows, laneCount };
}
