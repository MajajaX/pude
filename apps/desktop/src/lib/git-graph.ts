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
  const lanes: Array<ActiveLane | undefined> = [];
  let nextColor = 0;
  let nextPriority = 0;
  let laneCount = 0;
  // A lane crossing a row looks the same on every row it crosses. Sharing that
  // one segment keeps long histories from allocating millions of equal objects.
  const crossingSegments = new Map<number, GitGraphSegment>();
  const crossingSegment = (lane: number, color: number): GitGraphSegment => {
    const key = lane * GIT_GRAPH_PALETTE_SIZE + color;
    let segment = crossingSegments.get(key);
    if (!segment) {
      segment = { fromLane: lane, toLane: lane, fromY: 0, toY: 1, color };
      crossingSegments.set(key, segment);
    }
    return segment;
  };

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
    const lane =
      incomingLanes.length > 0
        ? incomingLanes.reduce((preferred, candidate) =>
            lanes[candidate]!.priority < lanes[preferred]!.priority ? candidate : preferred,
          )
        : firstFreeLane(lanes);
    noteLane(lane);

    const color = incomingLanes.length > 0 ? lanes[lane]!.color : nextColor++ % GIT_GRAPH_PALETTE_SIZE;
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
        segments.push(crossingSegment(activeLane, active.color));
      }
    }

    for (const incomingLane of incomingLanes) lanes[incomingLane] = undefined;

    for (const parent of laterParents) {
      const isFirstParent = parents[0] === parent;
      const existingLanes = isFirstParent
        ? []
        : lanes.map((activeLane, index) => (activeLane?.target === parent ? index : -1)).filter((index) => index >= 0);

      if (isFirstParent) {
        // Keep the first-parent color attached to this path until it reaches
        // its parent, even when another child already has that parent queued.
        let parentLane = lane;
        if (lanes[parentLane] !== undefined) parentLane = firstFreeLane(lanes);
        noteLane(parentLane);
        lanes[parentLane] = { target: parent, color, priority };
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color,
        });
      } else if (existingLanes.length > 0) {
        const parentLane = existingLanes.reduce((preferred, candidate) =>
          lanes[candidate]!.priority < lanes[preferred]!.priority ? candidate : preferred,
        );
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color: lanes[parentLane]!.color,
        });
      } else {
        const hiddenFirstParent = parents[0] !== undefined && !visibleParents.has(parents[0]);
        const parentLane = firstFreeLane(lanes, hiddenFirstParent ? lane : undefined);
        noteLane(parentLane);
        const parentColor = nextColor++ % GIT_GRAPH_PALETTE_SIZE;
        lanes[parentLane] = { target: parent, color: parentColor, priority: nextPriority++ };
        segments.push({
          fromLane: lane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color: parentColor,
        });
      }
    }

    // A hidden first parent gets a visible dashed stub. If a visible first
    // parent already uses the same path, hasHiddenParents carries the hidden
    // ancestry signal without obscuring that solid first-parent connection.
    if (hasHiddenParents && !visibleParents.has(parents[0])) {
      segments.push({
        fromLane: lane,
        toLane: lane,
        fromY: 0.5,
        toY: 1,
        color,
        dashed: true,
      });
    }

    trimEmptyTrailingLanes(lanes);
    rows.push({ commit, lane, color, segments, hasHiddenParents });
  }

  return { rows, laneCount };
}

/**
 * Moves a commit that was listed before one of its children to just after its
 * last child, leaving every other commit in place. History pages list a quiet
 * ref's tip ahead of the walk that later reaches its children.
 */
export function orderCommitsAfterChildren(commits: readonly GitCommit[]): GitCommit[] {
  const commitByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const unlistedChildren = new Map<string, number>();
  for (const commit of commits) {
    for (const parent of new Set(commit.parents ?? [])) {
      if (commitByHash.has(parent)) unlistedChildren.set(parent, (unlistedChildren.get(parent) ?? 0) + 1);
    }
  }

  const ordered: GitCommit[] = [];
  const waiting = new Set<string>();
  const list = (first: GitCommit) => {
    const pending = [first];
    while (pending.length) {
      const commit = pending.pop()!;
      ordered.push(commit);
      for (const parent of new Set(commit.parents ?? [])) {
        const remaining = unlistedChildren.get(parent);
        if (remaining === undefined) continue;
        unlistedChildren.set(parent, remaining - 1);
        if (remaining === 1 && waiting.delete(parent)) pending.push(commitByHash.get(parent)!);
      }
    }
  };
  for (const commit of commits) {
    if (unlistedChildren.get(commit.hash)) waiting.add(commit.hash);
    else list(commit);
  }
  return ordered;
}
