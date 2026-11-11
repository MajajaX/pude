import { describe, expect, it } from "vitest";
import { groupMatchesByFile, replaceSummary } from "./project-search";

describe("replaceSummary", () => {
  it("counts replacements and reports skipped, failed and unchecked files", () => {
    expect(
      replaceSummary({ changedFiles: ["/a"], replacements: 1, skippedUnsaved: 0, failedFiles: [], truncated: false }),
    ).toBe("Replaced 1 match in 1 file.");
    expect(
      replaceSummary({
        changedFiles: ["/a", "/b"],
        replacements: 5,
        skippedUnsaved: 2,
        failedFiles: [{ path: "/c", message: "Read-only." }],
        truncated: true,
      }),
    ).toBe(
      "Replaced 5 matches in 2 files. Skipped 2 files with unsaved changes. 1 file could not be changed: Read-only. Some files were not checked because the project is very large.",
    );
  });
});

describe("groupMatchesByFile", () => {
  it("keeps every file once, in the order its first match appears", () => {
    const match = (path: string, line: number) => ({ path, relativePath: path.slice(1), line, preview: "" });
    const groups = groupMatchesByFile([match("/a", 1), match("/b", 2), match("/a", 9)]);
    expect(groups.map((group) => [group.relativePath, group.matches.map((item) => item.line)])).toEqual([
      ["a", [1, 9]],
      ["b", [2]],
    ]);
  });
});
