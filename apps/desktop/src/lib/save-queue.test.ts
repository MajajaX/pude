import { describe, expect, it } from "vitest";
import { resolveQueuedSaveExpectation } from "./save-queue";

describe("queued save expectations", () => {
  it("uses the metadata returned by the preceding save on the same path", () => {
    expect(resolveQueuedSaveExpectation({ path: "/workspace/file.ts", modifiedAt: 10, size: 3, fingerprint: "old" }, {
      ok: true,
      path: "/workspace/file.ts",
      modifiedAt: 11,
      size: 4,
      fingerprint: "first-save",
    })).toEqual({ path: "/workspace/file.ts", modifiedAt: 11, size: 4, fingerprint: "first-save" });
  });

  it("keeps the original guard after a failed save or a path change", () => {
    const snapshot = { path: "/workspace/file.ts", modifiedAt: 10, size: 3, fingerprint: "old" };
    expect(resolveQueuedSaveExpectation(snapshot, { ok: false, path: snapshot.path, modifiedAt: 11, size: 4, fingerprint: "unknown" })).toEqual(snapshot);
    expect(resolveQueuedSaveExpectation(snapshot, { ok: true, path: "/workspace/other.ts", modifiedAt: 11, size: 4, fingerprint: "other" })).toEqual(snapshot);
  });
});
