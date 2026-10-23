import { describe, expect, it } from "vitest";
import { replaceSummary } from "./project-search";

describe("replaceSummary", () => {
  it("counts replacements and reports skipped, failed and unchecked files", () => {
    expect(replaceSummary({ changedFiles: ["/a"], replacements: 1, skippedUnsaved: 0, failedFiles: [], truncated: false }))
      .toBe("Replaced 1 match in 1 file.");
    expect(replaceSummary({ changedFiles: ["/a", "/b"], replacements: 5, skippedUnsaved: 2, failedFiles: [{ path: "/c", message: "Read-only." }], truncated: true }))
      .toBe("Replaced 5 matches in 2 files. Skipped 2 files with unsaved changes. 1 file could not be changed: Read-only. Some files were not checked because the project is very large.");
  });
});
