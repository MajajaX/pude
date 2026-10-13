import { describe, expect, it } from "vitest";
import { createSaveController, type SaveControllerHooks, type SaveSnapshot } from "./save-controller";

const snapshot = (overrides: Partial<SaveSnapshot> = {}): SaveSnapshot => ({
  tabId: "tab-1",
  path: "/workspace/file.ts",
  content: "a",
  lineEnding: "lf",
  lineEndings: "uniform",
  bom: false,
  encoding: "UTF-8",
  revision: 1,
  expectedModifiedAt: 10,
  expectedSize: 1,
  expectedFingerprint: "fp-0",
  ...overrides,
});

type RecordedCall = {
  path: string;
  content: string;
  expectedModifiedAt?: number;
  expectedSize?: number;
  expectedFingerprint?: string;
};

const controlledSaveFile = () => {
  const calls: RecordedCall[] = [];
  const resolvers: ((result: { modifiedAt: number; size: number; fingerprint: string }) => void)[] = [];
  const rejecters: ((error: unknown) => void)[] = [];
  const saveFile: SaveControllerHooks["saveFile"] = (path, content, _lineEnding, _lineEndings, _bom, expectedModifiedAt, expectedSize, expectedFingerprint) => {
    calls.push({ path, content, expectedModifiedAt, expectedSize, expectedFingerprint });
    return new Promise((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return { calls, saveFile, resolvers, rejecters };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("save controller queue", () => {
  it("runs queued saves for the same tab in order and guards on the preceding result", async () => {
    const { calls, saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    const first = controller.enqueue(snapshot({ content: "a", revision: 1 }));
    const second = controller.enqueue(snapshot({ content: "b", revision: 2 }));
    await flush();
    expect(calls).toHaveLength(1);
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ content: "b", expectedModifiedAt: 11, expectedSize: 2, expectedFingerprint: "fp-1" });
    resolvers[1]({ modifiedAt: 12, size: 3, fingerprint: "fp-2" });
    expect(await first).toEqual({ ok: true, path: "/workspace/file.ts", modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    expect(await second).toEqual({ ok: true, path: "/workspace/file.ts", modifiedAt: 12, size: 3, fingerprint: "fp-2" });
  });

  it("keeps the original guard after a failed save and reports the failure", async () => {
    const { calls, saveFile, resolvers, rejecters } = controlledSaveFile();
    const failures: unknown[] = [];
    const controller = createSaveController({ saveFile, onSaveFailed: (_snapshot, error) => failures.push(error) });
    const first = controller.enqueue(snapshot({ revision: 1 }));
    const second = controller.enqueue(snapshot({ revision: 2 }));
    await flush();
    rejecters[0](new Error("disk conflict"));
    await flush();
    expect(await first).toEqual({ ok: false, path: "/workspace/file.ts" });
    expect(failures).toHaveLength(1);
    expect(calls[1]).toMatchObject({ expectedModifiedAt: 10, expectedSize: 1, expectedFingerprint: "fp-0" });
    resolvers[1]({ modifiedAt: 12, size: 3, fingerprint: "fp-2" });
    expect(await second).toMatchObject({ ok: true, modifiedAt: 12 });
  });

  it("exposes the pending snapshot only while the save is in flight", async () => {
    const { saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    const pending = snapshot({ revision: 1 });
    const queued = controller.enqueue(pending);
    expect(controller.getPendingSnapshot("tab-1")).toBeUndefined();
    await flush();
    expect(controller.getPendingSnapshot("tab-1")).toBe(pending);
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    await queued;
    expect(controller.getPendingSnapshot("tab-1")).toBeUndefined();
  });

  it("does not remove a newer pending snapshot when an older save settles", async () => {
    const { saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    const first = controller.enqueue(snapshot({ revision: 1 }));
    const second = snapshot({ revision: 2 });
    const secondQueued = controller.enqueue(second);
    await flush();
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    await flush();
    expect(controller.getPendingSnapshot("tab-1")).toBe(second);
    resolvers[1]({ modifiedAt: 12, size: 3, fingerprint: "fp-2" });
    await Promise.all([first, secondQueued]);
    expect(controller.getPendingSnapshot("tab-1")).toBeUndefined();
  });

  it("queues saves per tab independently", async () => {
    const { calls, saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    const first = controller.enqueue(snapshot({ tabId: "tab-1", revision: 1 }));
    const second = controller.enqueue(snapshot({ tabId: "tab-2", path: "/workspace/other.ts", revision: 1 }));
    await flush();
    expect(calls).toHaveLength(2);
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    resolvers[1]({ modifiedAt: 20, size: 5, fingerprint: "fp-9" });
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it("treats a thrown onSaved hook as a failed save", async () => {
    const { saveFile, resolvers } = controlledSaveFile();
    const failures: unknown[] = [];
    const saved: string[] = [];
    const controller = createSaveController({
      saveFile,
      onSaved: (snap) => saved.push(snap.content),
      onSaveFailed: (_snapshot, error) => failures.push(error),
    });
    const queued = controller.enqueue(snapshot({ revision: 1 }));
    await flush();
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    // onSaved does not throw here; assert happy path still reports ok.
    expect(await queued).toMatchObject({ ok: true });
    expect(saved).toEqual(["a"]);
    expect(failures).toEqual([]);

    const failing = createSaveController({
      saveFile,
      onSaved: () => {
        throw new Error("bookkeeping failed");
      },
      onSaveFailed: (_snapshot, error) => failures.push(error),
    });
    const failedQueued = failing.enqueue(snapshot({ revision: 1 }));
    await flush();
    resolvers[1]({ modifiedAt: 12, size: 3, fingerprint: "fp-2" });
    expect(await failedQueued).toEqual({ ok: false, path: "/workspace/file.ts" });
    expect(failures).toHaveLength(1);
  });

  it("clears queue and pending snapshots on dispose", async () => {
    const { saveFile } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    void controller.enqueue(snapshot({ revision: 1 }));
    await flush();
    expect(controller.getPendingSnapshot("tab-1")).toBeDefined();
    controller.dispose();
    expect(controller.getPendingSnapshot("tab-1")).toBeUndefined();
  });

  it("waits for atomic replacement before checking the saved file", async () => {
    const { saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    let reads = 0;
    const saved = controller.enqueue(snapshot());
    const disk = controller.readAfterSaves("tab-1", async () => { reads += 1; return "saved bytes"; });
    await flush();
    expect(reads).toBe(0);
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    await saved;
    expect(await disk).toBe("saved bytes");
    expect(reads).toBe(1);
  });

  it.each([false, true])("retries a disk read overtaken by a save, including a transient missing file (%s)", async (missing) => {
    const { saveFile, resolvers } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    let finishRead!: () => void;
    let reads = 0;
    const disk = controller.readAfterSaves("tab-1", async () => {
      reads += 1;
      if (reads > 1) return "durable saved bytes";
      return await new Promise<string>((resolve, reject) => {
        finishRead = () => missing ? reject(new Error("file missing during replacement")) : resolve("old bytes");
      });
    });
    const saved = controller.enqueue(snapshot());
    await flush();
    resolvers[0]({ modifiedAt: 11, size: 2, fingerprint: "fp-1" });
    await saved;
    finishRead();
    expect(await disk).toBe("durable saved bytes");
    expect(reads).toBe(2);
  });

  it("still verifies external changes after a failed save and does not wait on another tab", async () => {
    const { saveFile, rejecters } = controlledSaveFile();
    const controller = createSaveController({ saveFile });
    const saved = controller.enqueue(snapshot());
    const disk = controller.readAfterSaves("tab-1", async () => "external bytes");
    expect(await controller.readAfterSaves("tab-2", async () => "other tab bytes")).toBe("other tab bytes");
    await flush();
    rejecters[0](new Error("save conflict"));
    expect((await saved).ok).toBe(false);
    expect(await disk).toBe("external bytes");
  });
});
