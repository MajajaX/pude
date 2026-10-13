import { describe, expect, it, vi } from "vitest";
import type { GitCommit, GitHistoryPage } from "../types";
import { GIT_HISTORY_PAGE_SIZE, GitHistoryController, type GitHistoryViewState } from "./git-history-controller";

function commit(hash: string, parents: string[] = []): GitCommit {
  return {
    hash,
    parents,
    shortHash: hash.slice(0, 7),
    author: "Test Author",
    date: "2026-10-01",
    subject: `commit ${hash}`,
    refs: [],
    files: [],
  };
}

function page(
  commits: GitCommit[],
  cursor: string | null,
  hasMore = cursor !== null,
  overrides: Partial<GitHistoryPage> = {},
): GitHistoryPage {
  return {
    commits,
    cursor,
    hasMore,
    complete: true,
    unresolvedRefs: [],
    incompleteReason: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const context = { workspace: "/repo-a", snapshotKey: "repo-a:main:head-a" };
  const commits: GitCommit[] = [];
  const states: GitHistoryViewState[] = [];
  const setCommits = vi.fn((next: GitCommit[]) => commits.splice(0, commits.length, ...next));
  const onLoaded = vi.fn();
  const notify = vi.fn();
  const loadPage = vi.fn(async (_workspace: string, _cursor: string | null, _pageSize: number) => page([], null, false));
  const controller = new GitHistoryController({
    getWorkspace: () => context.workspace,
    getSnapshotKey: () => context.snapshotKey,
    getCurrentCommits: () => commits,
    setCommits,
    onState: (state) => states.push(state),
    onLoaded,
    notify,
    loadPage,
  });
  return { context, commits, states, controller, setCommits, onLoaded, notify, loadPage };
}

describe("GitHistoryController", () => {
  it("loads one fixed-size first page and exposes incomplete results with an action", async () => {
    const { controller, loadPage, commits, states, onLoaded } = createHarness();
    loadPage.mockResolvedValue(page([commit("c3", ["c2"])], "cursor-1", true, {
      complete: false,
      unresolvedRefs: ["refs/heads/feature"],
      incompleteReason: "The history scan reached its time budget.",
    }));

    expect(await controller.load()).toBe(true);
    expect(loadPage).toHaveBeenCalledWith("/repo-a", null, GIT_HISTORY_PAGE_SIZE);
    expect(GIT_HISTORY_PAGE_SIZE).toBe(60);
    expect(commits.map(({ hash }) => hash)).toEqual(["c3"]);
    expect(states.at(-1)).toMatchObject({ loading: false, loadingOlder: false, hasMore: true });
    expect(states.at(-1)?.incomplete).toContain("1 refs remain unresolved.");
    expect(states.at(-1)?.incomplete).toContain("Use Load older or Refresh history");
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it("returns the same promise for duplicate same-snapshot initial loads", async () => {
    const pending = deferred<GitHistoryPage>();
    const { controller, loadPage, commits } = createHarness();
    loadPage.mockImplementationOnce(() => pending.promise);

    const first = controller.load();
    const duplicate = controller.load();
    expect(duplicate).toBe(first);
    expect(loadPage).toHaveBeenCalledTimes(1);
    pending.resolve(page([commit("first")], null, false));
    expect(await first).toBe(true);
    expect(commits.map(({ hash }) => hash)).toEqual(["first"]);
  });

  it("advances changed cursors and appends graph pages with OID deduplication", async () => {
    const { controller, loadPage, commits, states } = createHarness();
    const tip = commit("c3", ["c2", "x2"]);
    const mainParent = commit("c2", ["c1"]);
    const sideParent = commit("x2", ["x1"]);
    const root = commit("c1");
    const sideRoot = commit("x1");
    const older = commit("c0", ["c1"]);
    loadPage
      .mockResolvedValueOnce(page([tip, mainParent], "cursor-page-2"))
      .mockResolvedValueOnce(page([commit("C2", ["c1"]), sideParent, root, sideRoot], "cursor-page-3"))
      .mockResolvedValueOnce(page([older], null, false));

    await controller.load();
    await controller.loadOlder();
    await controller.loadOlder();

    expect(loadPage.mock.calls).toEqual([
      ["/repo-a", null, 60],
      ["/repo-a", "cursor-page-2", 60],
      ["/repo-a", "cursor-page-3", 60],
    ]);
    expect(commits.map(({ hash }) => hash)).toEqual(["c3", "c2", "x2", "c1", "x1", "c0"]);
    expect(commits[0].parents).toEqual(["c2", "x2"]);
    expect(states.at(-1)).toMatchObject({ loadingOlder: false, hasMore: false, incomplete: undefined });
  });

  it("coalesces duplicate older-page calls while one cursor is being advanced", async () => {
    const pending = deferred<GitHistoryPage>();
    const { controller, loadPage } = createHarness();
    loadPage.mockResolvedValueOnce(page([commit("new")], "cursor-1"));
    await controller.load();
    loadPage.mockImplementationOnce(() => pending.promise);

    const first = controller.loadOlder();
    const duplicate = controller.loadOlder();
    expect(duplicate).toBe(first);
    expect(loadPage).toHaveBeenCalledTimes(2);
    pending.resolve(page([commit("old")], null, false));
    await first;
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("does not issue an older-page request before a loaded page supplies a cursor", async () => {
    const { controller, loadPage } = createHarness();
    expect(await controller.loadOlder()).toBe(false);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("drops a response invalidated while it is in flight", async () => {
    const pending = deferred<GitHistoryPage>();
    const { controller, loadPage, setCommits, onLoaded, states } = createHarness();
    loadPage.mockImplementationOnce(() => pending.promise);

    const request = controller.load();
    controller.invalidate();
    const stateCountAfterInvalidation = states.length;
    pending.resolve(page([commit("stale")], null, false));

    expect(await request).toBe(false);
    expect(setCommits).not.toHaveBeenCalled();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(states).toHaveLength(stateCountAfterInvalidation);
    expect(controller.getState()).toMatchObject({ loading: false, loadingOlder: false, hasMore: false });
  });

  it("reconciles workspace and snapshot changes before accepting old replies", async () => {
    const oldPage = deferred<GitHistoryPage>();
    const { context, controller, loadPage, commits, setCommits } = createHarness();
    loadPage.mockImplementationOnce(() => oldPage.promise).mockResolvedValueOnce(page([commit("new-head")], null, false));

    const oldRequest = controller.load();
    context.workspace = "/repo-b";
    context.snapshotKey = "repo-b:main:head-b";
    const newRequest = controller.load();
    oldPage.resolve(page([commit("old-head")], "old-cursor"));
    await oldRequest;
    expect(await newRequest).toBe(true);

    expect(setCommits).toHaveBeenCalledTimes(1);
    expect(commits.map(({ hash }) => hash)).toEqual(["new-head"]);
    expect(loadPage.mock.calls).toEqual([
      ["/repo-a", null, 60],
      ["/repo-b", null, 60],
    ]);
  });

  it("clears an expired cursor and gives the user a reload action", async () => {
    const { controller, loadPage, states, notify } = createHarness();
    loadPage
      .mockResolvedValueOnce(page([commit("tip")], "expired-cursor"))
      .mockRejectedValueOnce({ kind: "failed", message: "Git history cursor expired; reload history to continue." })
      .mockResolvedValueOnce(page([commit("reloaded-tip")], null, false));

    await controller.load();
    expect(await controller.loadOlder()).toBe(false);
    expect(states.at(-1)).toMatchObject({ hasMore: false });
    expect(states.at(-1)?.incomplete).toContain("Use Refresh history");
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Use Refresh history");
    expect(await controller.load()).toBe(true);
    expect(loadPage.mock.calls.map(([, cursor]) => cursor)).toEqual([null, "expired-cursor", null]);
  });

  it("reports native cancellation with an actionable refresh message", async () => {
    const { controller, loadPage, states, notify } = createHarness();
    loadPage.mockRejectedValueOnce({ kind: "cancelled", message: "Git command was cancelled." });

    expect(await controller.load()).toBe(false);
    expect(states.at(-1)).toMatchObject({ hasMore: false, loading: false });
    expect(states.at(-1)?.incomplete).toContain("Use Refresh history");
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Use Refresh history");
  });

  it("treats native ref-snapshot cancellation as an expired cursor", async () => {
    const { controller, loadPage, states, notify } = createHarness();
    loadPage
      .mockResolvedValueOnce(page([commit("tip")], "cursor-1"))
      .mockRejectedValueOnce({
        kind: "cancelled",
        message: "Git refs or repository identity changed; reload history before continuing.",
      });

    await controller.load();
    await controller.loadOlder();

    expect(states.at(-1)).toMatchObject({ hasMore: false });
    expect(states.at(-1)?.incomplete).toContain("cursor expired or became invalid");
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Use Refresh history");
  });

  it("reset clears commits and dispose drops a pending reply without callbacks", async () => {
    const pending = deferred<GitHistoryPage>();
    const { controller, loadPage, commits, setCommits, states, onLoaded } = createHarness();
    loadPage.mockResolvedValueOnce(page([commit("loaded")], "cursor-1"));
    await controller.load();
    controller.reset();
    expect(commits).toEqual([]);
    expect(controller.getState()).toMatchObject({ hasMore: false, incomplete: undefined });
    expect(setCommits).toHaveBeenCalledTimes(2);

    loadPage.mockImplementationOnce(() => pending.promise);
    const request = controller.load();
    const stateCount = states.length;
    const loadedCount = onLoaded.mock.calls.length;
    controller.dispose();
    pending.resolve(page([commit("after-dispose")], null, false));
    expect(await request).toBe(false);
    expect(commits).toEqual([]);
    expect(states).toHaveLength(stateCount);
    expect(onLoaded).toHaveBeenCalledTimes(loadedCount);
  });
});
