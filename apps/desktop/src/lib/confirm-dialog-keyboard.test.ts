import { describe, expect, it } from "vitest";
import { confirmDialogKeyAction } from "./confirm-dialog-keyboard";

const key = (keyName: string, overrides: Partial<{ isComposing: boolean; keyCode: number }> = {}) => ({
  key: keyName,
  isComposing: overrides.isComposing ?? false,
  keyCode: overrides.keyCode ?? 0,
});

describe("confirmation dialog keyboard behavior", () => {
  it("cancels on Escape unless a confirmation is busy", () => {
    expect(confirmDialogKeyAction(key("Escape"), false)).toBe("cancel");
    expect(confirmDialogKeyAction(key("Escape"), true)).toBe("prevent");
  });

  it("suppresses Enter used by an IME candidate instead of triggering a dialog action", () => {
    expect(confirmDialogKeyAction(key("Enter", { isComposing: true, keyCode: 13 }), false)).toBe("prevent");
    expect(confirmDialogKeyAction(key("Enter", { keyCode: 229 }), false)).toBe("prevent");
    expect(confirmDialogKeyAction(key("Enter", { keyCode: 13 }), false)).toBe("none");
  });
});
