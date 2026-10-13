import { describe, expect, it } from "vitest";
import { deleteConfirmationMessage, trashLocationLabel } from "./delete-confirmation";

describe("delete confirmation", () => {
  it("names the operating system trash destination", () => {
    expect(trashLocationLabel("windows")).toBe("Recycle Bin");
    expect(trashLocationLabel("mac")).toBe("Trash");
    expect(trashLocationLabel("linux")).toBe("system trash");
  });

  it("requires explicit confirmation before discarding dirty open tabs", () => {
    expect(deleteConfirmationMessage("draft.ts", "windows", 1, true)).toBe(
      "Move draft.ts to the Recycle Bin? Unsaved changes in affected open tabs will be discarded, and those tabs will be closed.",
    );
  });

  it("warns when clean tabs will close with the trashed item", () => {
    expect(deleteConfirmationMessage("src", "mac", 2, false)).toBe(
      "Move src to the Trash? Affected open tabs will be closed.",
    );
    expect(deleteConfirmationMessage("draft.ts", "linux", 0, false)).toBe(
      "Move draft.ts to system trash?",
    );
  });
});
