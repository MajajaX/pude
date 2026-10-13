import { describe, expect, it } from "vitest";
import type { EditorTab } from "../types";
import { diskMetadataChanged } from "./disk-metadata";

describe("metadata verification", () => {
  const tab = { diskModifiedAt: 123, diskSize: 20, diskIdentity: "1:2", diskFingerprint: "fnv-contents" } as EditorTab;
  const entry = { path: "file", exists: true, modifiedAt: 123, size: 20, identity: "1:2" };

  it("does not compare file identity to a content fingerprint", () => {
    for (let index = 0; index < 100; index++) expect(diskMetadataChanged(tab, entry)).toBe(false);
  });

  it("detects replacement even when mtime and size stay the same", () => {
    expect(diskMetadataChanged(tab, { ...entry, identity: "1:3" })).toBe(true);
  });

  it("reloads legacy tabs and unverifiable metadata", () => {
    expect(diskMetadataChanged({ ...tab, diskIdentity: undefined }, entry)).toBe(true);
    expect(diskMetadataChanged(tab, { ...entry, identity: null })).toBe(true);
    expect(diskMetadataChanged(tab, { ...entry, modifiedAt: 124 })).toBe(true);
  });
});
