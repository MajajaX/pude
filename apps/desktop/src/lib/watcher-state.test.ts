import { describe, expect, it } from "vitest";
import { createWatcherEventBuffer, watcherRetryDelay } from "./watcher-state";
import type { FileChangedEvent } from "../types";

const event = (sequence: number, path = "/workspace/file.ts"): FileChangedEvent => ({ sequence, paths: [path] });

describe("watcher event buffer", () => {
  it("retains events received before a snapshot commits", () => {
    const buffer = createWatcherEventBuffer();
    const token = buffer.snapshot();
    expect(buffer.record(event(1)).dispatch).toBe(false);
    expect(buffer.isCurrent(token)).toBe(false);

    const pending = buffer.endBuffering();
    expect(pending.events).toEqual([event(1)]);
    expect(pending.revision).toBe(1);
    expect(pending.needsRescan).toBe(false);
  });

  it("rejects duplicate sequences and marks gaps for a conservative rescan", () => {
    const buffer = createWatcherEventBuffer();
    expect(buffer.record(event(1)).accepted).toBe(true);
    expect(buffer.record(event(1)).accepted).toBe(false);
    expect(buffer.record(event(3)).accepted).toBe(true);
    expect(buffer.endBuffering().needsRescan).toBe(true);
  });

  it("marks a gap from the first sequence as a rescan", () => {
    const buffer = createWatcherEventBuffer();
    expect(buffer.record(event(3)).needsRescan).toBe(true);
  });

  it("does not repeat a live rescan after the gap is acknowledged", () => {
    const buffer = createWatcherEventBuffer();
    buffer.endBuffering();
    expect(buffer.record(event(3)).needsRescan).toBe(true);
    expect(buffer.record(event(4)).needsRescan).toBe(false);
  });

  it("resets sequence ordering when a restarted watcher emits a new session", () => {
    const buffer = createWatcherEventBuffer();
    buffer.endBuffering();
    expect(buffer.record({ sessionId: "old", sequence: 9, paths: [], changes: [] }).accepted).toBe(true);
    expect(buffer.record({ sessionId: "new", sequence: 1, paths: [], changes: [] })).toMatchObject({ accepted: true, dispatch: true, needsRescan: true });
    expect(buffer.record({ sessionId: "new", sequence: 2, paths: [], changes: [] })).toMatchObject({ accepted: true, dispatch: true, needsRescan: false });
  });

  it("does not make an old snapshot current after a reset", () => {
    const buffer = createWatcherEventBuffer();
    const token = buffer.snapshot();
    buffer.clear();
    expect(buffer.isCurrent(token)).toBe(false);
  });

  it("invalidates snapshot tokens across watcher sequence resets", () => {
    const buffer = createWatcherEventBuffer();
    const token = buffer.snapshot();
    buffer.resetSequence();
    expect(buffer.isCurrent(token)).toBe(false);
  });

  it("bounds queued events and escalates overflow to a rescan", () => {
    const buffer = createWatcherEventBuffer(1);
    buffer.record(event(1));
    buffer.record(event(2));
    const pending = buffer.endBuffering();
    expect(pending.events).toHaveLength(1);
    expect(pending.needsRescan).toBe(true);
  });
});

describe("watcher retry backoff", () => {
  it("uses bounded exponential delays", () => {
    expect(watcherRetryDelay(0)).toBe(250);
    expect(watcherRetryDelay(3)).toBe(2_000);
    expect(watcherRetryDelay(99)).toBe(30_000);
  });
});
