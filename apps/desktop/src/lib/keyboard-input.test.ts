import { describe, expect, it } from "vitest";
import { isImeComposing, shouldSubmitOnEnter } from "./keyboard-input";

describe("IME-aware keyboard actions", () => {
  it("recognizes composing key events including the legacy 229 signal", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it("submits Enter only after composition has ended", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
    expect(shouldSubmitOnEnter({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "Enter", isComposing: false, keyCode: 13 }, true)).toBe(false);
    expect(shouldSubmitOnEnter({ key: "ArrowDown", isComposing: false, keyCode: 40 })).toBe(false);
  });
});
