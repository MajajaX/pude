import { describe, expect, it } from "vitest";
import { tabNavigationAction, tabRovingIndex } from "./tab-navigation";

const horizontal = (key: string, overrides: Partial<Parameters<typeof tabNavigationAction>[0]> = {}) => tabNavigationAction({
  key,
  count: 4,
  focusedIndex: 1,
  orientation: "horizontal",
  ...overrides,
});

describe("tab navigation", () => {
  it("wraps horizontal arrows and handles Home and End", () => {
    expect(horizontal("ArrowRight").focusIndex).toBe(2);
    expect(horizontal("ArrowLeft").focusIndex).toBe(0);
    expect(horizontal("ArrowLeft", { focusedIndex: 0 }).focusIndex).toBe(3);
    expect(horizontal("ArrowRight", { focusedIndex: 3 }).focusIndex).toBe(0);
    expect(horizontal("Home").focusIndex).toBe(0);
    expect(horizontal("End").focusIndex).toBe(3);
  });

  it("reverses horizontal arrows for RTL and uses vertical arrows for vertical lists", () => {
    expect(horizontal("ArrowLeft", { direction: "rtl" }).focusIndex).toBe(2);
    expect(horizontal("ArrowRight", { direction: "rtl" }).focusIndex).toBe(0);
    expect(tabNavigationAction({ key: "ArrowDown", count: 3, focusedIndex: 2, orientation: "vertical" }).focusIndex).toBe(0);
    expect(tabNavigationAction({ key: "ArrowUp", count: 3, focusedIndex: 0, orientation: "vertical" }).focusIndex).toBe(2);
    expect(tabNavigationAction({ key: "ArrowUp", count: 3, focusedIndex: 0, orientation: "horizontal" }).handled).toBe(false);
  });

  it("automatically selects arrow destinations and supports manual activation", () => {
    expect(horizontal("ArrowRight")).toMatchObject({ handled: true, preventDefault: true, focusIndex: 2, selectedIndex: 2 });
    expect(horizontal("ArrowRight", { activation: "manual" })).toMatchObject({ handled: true, focusIndex: 2 });
    expect(horizontal("ArrowRight", { activation: "manual" }).selectedIndex).toBeUndefined();
    expect(horizontal("Enter", { activation: "manual" })).toMatchObject({ handled: true, selectedIndex: 1 });
    expect(horizontal(" ", { activation: "manual", focusedIndex: 3 })).toMatchObject({ handled: true, selectedIndex: 3 });
  });

  it("leaves unrelated, composing, and empty-list keys to the caller", () => {
    expect(horizontal("Tab")).toMatchObject({ handled: false, preventDefault: false });
    expect(horizontal("ArrowRight", { isComposing: true }).handled).toBe(false);
    expect(horizontal("ArrowRight", { keyCode: 229 }).handled).toBe(false);
    expect(horizontal("ArrowRight", { ctrlKey: true }).handled).toBe(false);
    expect(horizontal("ArrowRight", { metaKey: true }).handled).toBe(false);
    expect(horizontal("ArrowRight", { altKey: true }).handled).toBe(false);
    expect(horizontal("Tab", { shiftKey: true }).handled).toBe(false);
    expect(tabNavigationAction({ key: "Home", count: 0, focusedIndex: 0, orientation: "horizontal" })).toMatchObject({ handled: false });
  });

  it("makes exactly the focused tab the single sequential tab stop", () => {
    expect([0, 1, 2, 3].map((index) => tabRovingIndex(index, 2))).toEqual([-1, -1, 0, -1]);
  });
});
