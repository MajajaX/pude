import { describe, expect, it } from "vitest";
import { nextMenuItemIndex } from "./menu-keyboard";

describe("menu keyboard navigation", () => {
  it("moves through items and wraps in both directions", () => {
    expect(nextMenuItemIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuItemIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuItemIndex("ArrowUp", -1, 3)).toBe(2);
    expect(nextMenuItemIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("moves to either end and handles an empty menu", () => {
    expect(nextMenuItemIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuItemIndex("End", 0, 3)).toBe(2);
    expect(nextMenuItemIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
