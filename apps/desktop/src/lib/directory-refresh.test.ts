import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListResult } from "../types";
import { DirectoryRefreshCoordinator } from "./directory-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function listing(paths: string[] = []): DirectoryListResult {
  return {
    entries: paths.map((path) => ({ name: path.split("/").at(-1) ?? path, path, kind: "directory" })),
  };
}

function createHarness() {
  const state = {
    generation: 1,
    workspace: "/workspace",
    disposed: false,
    expanded: new Set<string>(["/workspace/a", "/workspace/b", "/workspace/a/child"]),
  };
  const list = vi.fn(async (_path: string, _requestId: string) => listing());
  const apply = vi.fn();
  const markStale = vi.fn();
  const onError = vi.fn();
  const cancelDirectoryListing = vi.fn(async () => true);
  const coordinator = new DirectoryRefreshCoordinator({
    getGeneration: () => state.generation,
    getWorkspace: () => state.workspace,
    isDisposed: () => state.disposed,
    pathKey: (path) => path.toLowerCase(),
    isPathInWorkspace: (path, workspace) => path === workspace || path.startsWith(`${workspace}/`),
    isWorkspaceRoot: (path, workspace) => path === workspace,
    isExpanded: (path) => state.expanded.has(path),
    markStale,
    list,
    apply,
    onError,
    cancelDirectoryListing,
  });
  return { state, coordinator, list, apply, markStale, onError, cancelDirectoryListing };
}

describe("DirectoryRefreshCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("debounces each canonical path independently for 140 ms", async () => {
    const { coordinator, list } = createHarness();
    coordinator.schedule("/workspace/a");
    await vi.advanceTimersByTimeAsync(80);
    coordinator.schedule("/workspace/a");
    coordinator.schedule("/workspace/b");

    await vi.advanceTimersByTimeAsync(139);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(list.mock.calls.map(([path]) => path).sort()).toEqual(["/workspace/a", "/workspace/b"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("marks collapsed directories stale without listing them", async () => {
    const { coordinator, list, markStale } = createHarness();
    coordinator.schedule("/workspace/collapsed");
    await vi.advanceTimersByTimeAsync(140);

    expect(markStale).toHaveBeenCalledWith("/workspace/collapsed");
    expect(list).not.toHaveBeenCalled();
  });

  it("handles overflow through the explicitly supplied root only", async () => {
    const { coordinator, list, apply } = createHarness();
    list.mockResolvedValue(listing(["/workspace/a", "/workspace/b"]));

    coordinator.scheduleOverflowRoot("/workspace/a");
    coordinator.scheduleOverflowRoot("/workspace");
    coordinator.scheduleOverflowRoot("/workspace");
    await vi.advanceTimersByTimeAsync(140);

    expect(list.mock.calls.map(([path]) => path)).toEqual(["/workspace"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("/workspace", expect.objectContaining({ entries: expect.any(Array) }), {
      generation: 1,
      workspace: "/workspace",
    });
  });

  it("coalesces every event during a read into one serial follow-up", async () => {
    const first = deferred<DirectoryListResult>();
    const { coordinator, list, apply } = createHarness();
    list.mockImplementationOnce(() => first.promise).mockResolvedValue(listing());

    const finished = coordinator.refresh("/workspace/a");
    expect(list).toHaveBeenCalledTimes(1);
    coordinator.schedule("/workspace/a");
    coordinator.schedule("/workspace/a");
    coordinator.schedule("/workspace/a");
    expect(list).toHaveBeenCalledTimes(1);

    first.resolve(listing());
    await finished;

    expect(list).toHaveBeenCalledTimes(2);
    const requestIds = list.mock.calls.map(([, requestId]) => requestId);
    expect(requestIds.every((requestId) => /^directory-list-[\w-]+-\d+$/.test(requestId))).toBe(true);
    expect(new Set(requestIds).size).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("coalesces duplicate immediate refresh calls without an extra listing", async () => {
    const pending = deferred<DirectoryListResult>();
    const { coordinator, list } = createHarness();
    list.mockImplementationOnce(() => pending.promise);

    const first = coordinator.refresh("/workspace/a");
    const duplicate = coordinator.refresh("/workspace/a");
    expect(duplicate).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve(listing());
    await Promise.all([first, duplicate]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("uses distinct request ID prefixes for separate coordinator instances", async () => {
    const first = createHarness();
    const second = createHarness();
    await Promise.all([
      first.coordinator.refresh("/workspace/a"),
      second.coordinator.refresh("/workspace/a"),
    ]);

    expect(first.list.mock.calls[0][1]).not.toBe(second.list.mock.calls[0][1]);
  });

  it("cancels an invalidated listing and ignores its late response after a generation change", async () => {
    const pending = deferred<DirectoryListResult>();
    const { state, coordinator, list, apply, cancelDirectoryListing } = createHarness();
    list.mockImplementationOnce(() => pending.promise);

    const finished = coordinator.refresh("/workspace/a");
    const requestId = list.mock.calls[0][1];
    state.generation += 1;
    coordinator.invalidate("/workspace/a");

    expect(cancelDirectoryListing).toHaveBeenCalledWith(requestId);
    pending.resolve(listing());
    expect(await finished).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancels active requests on dispose and ignores native cancelled results", async () => {
    const pending = deferred<DirectoryListResult>();
    const { coordinator, list, apply, cancelDirectoryListing } = createHarness();
    list.mockImplementationOnce(() => pending.promise);

    const finished = coordinator.refresh("/workspace/a");
    const requestId = list.mock.calls[0][1];
    coordinator.dispose();
    expect(cancelDirectoryListing).toHaveBeenCalledWith(requestId);
    pending.resolve(listing());
    expect(await finished).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    await expect(coordinator.refresh("/workspace/a")).resolves.toBe(false);
  });

  it("does not apply a cancelled bounded native listing", async () => {
    const { coordinator, list, apply, markStale } = createHarness();
    list.mockResolvedValue({ entries: [], incomplete: true, stopReason: "cancelled" });

    expect(await coordinator.refresh("/workspace/a")).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(markStale).toHaveBeenCalledWith("/workspace/a");
  });
});
