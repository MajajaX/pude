import { describe, expect, it } from "vitest";
import { isImeComposing, shortcutKey, shouldSubmitOnEnter } from "./keyboard-input";

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

describe("shortcutKey", () => {
  it("matches Option+S and Option+F by physical key on macOS", () => {
    expect(shortcutKey({ key: "ß", code: "KeyS", altKey: true }, true)).toBe("s");
    expect(shortcutKey({ key: "ƒ", code: "KeyF", altKey: true }, true)).toBe("f");
  });

  it("keeps the typed key without Option or off macOS", () => {
    expect(shortcutKey({ key: "S", code: "KeyS", altKey: false }, true)).toBe("s");
    expect(shortcutKey({ key: "ś", code: "KeyS", altKey: true }, false)).toBe("ś");
    expect(shortcutKey({ key: "s", code: "KeyS", altKey: true }, false)).toBe("s");
  });

  it("does not remap other Option letters", () => {
    expect(shortcutKey({ key: "∑", code: "KeyW", altKey: true }, true)).toBe("∑");
  });
});
