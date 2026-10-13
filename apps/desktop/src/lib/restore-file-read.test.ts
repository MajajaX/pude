import { describe, expect, it } from "vitest";
import { readFileForRestore, isMissingFileReadError } from "./restore-file-read";
import { IoBusyError, IoStaleGenerationError } from "./io-limiter";
import { FileChangedDuringReadError } from "./versioned-file-reader";

describe("file restoration read failures", () => {
  const missing = (error: unknown) => isMissingFileReadError(error, "posix");
  it("retains the complete successful read result", async () => {
    const file = { content: "existing complete content", fingerprint: "saved-disk" };
    expect(await readFileForRestore(async () => file, missing)).toEqual({ status: "available", file });
  });
  it("allows orphan restoration only for a confirmed missing file", async () => {
    expect(await readFileForRestore(async () => { throw new Error("Unable to read file. No such file or directory (os error 2)"); }, missing)).toEqual({ status: "missing" });
  });
  it.each([
    new IoBusyError(), new IoStaleGenerationError(), new FileChangedDuringReadError("existing.txt"),
    new Error("permission denied"), undefined,
    new FileChangedDuringReadError("/workspace/no such file.txt"),
    new Error("Unable to read file. Permission denied: not found.txt (os error 13)"),
  ])("keeps an unavailable existing-file read distinct from empty content: %s", async (error) => {
    const result = await readFileForRestore(async () => { throw error; }, missing);
    expect(result).toEqual({ status: "read-failed", error });
    expect("file" in result).toBe(false);
  });
  it("uses platform error codes rather than localized text or path words", () => {
    expect(isMissingFileReadError("Unable to read file. 找不到路徑 (os error 3)", "windows")).toBe(true);
    expect(isMissingFileReadError("Unable to read file. Unknown process (os error 3)", "posix")).toBe(false);
    expect(isMissingFileReadError("No such file: user-controlled-path (os error 2)", "posix")).toBe(false);
  });
  it("does not hide successful siblings when one read fails", async () => {
    const results = await Promise.all([
      readFileForRestore(async () => { throw new IoBusyError(); }, missing),
      readFileForRestore(async () => ({ content: "sibling" }), missing),
    ]);
    expect(results[0].status).toBe("read-failed");
    expect(results[1]).toEqual({ status: "available", file: { content: "sibling" } });
  });
});
