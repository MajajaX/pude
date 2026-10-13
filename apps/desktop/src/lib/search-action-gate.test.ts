import { describe, expect, it } from "vitest";
import { createSearchActionGate } from "./search-action-gate";

describe("search action consumption", () => {
  it("consumes each globally numbered request once and accepts later requests for the same tab", () => {
    const gate = createSearchActionGate();

    expect(gate.consume("tab-a", 1)).toBe(true);
    expect(gate.consume("tab-a", 1)).toBe(false);
    expect(gate.consume("tab-b", 2)).toBe(true);
    expect(gate.consume("tab-a", 3)).toBe(true);
    expect(gate.consume("tab-b", 2)).toBe(false);
    expect(gate.getTrackedTabCount()).toBe(2);
  });

  it("releases per-tab keys when tabs close but rejects delayed replays", () => {
    const gate = createSearchActionGate();
    expect(gate.consume("tab-a", 4)).toBe(true);
    expect(gate.consume("tab-b", 5)).toBe(true);

    gate.releaseClosedTabs(["tab-b"]);
    expect(gate.getTrackedTabCount()).toBe(1);
    expect(gate.consume("tab-a", 4)).toBe(false);
    expect(gate.consume("tab-a", 3)).toBe(false);
    expect(gate.consume("tab-b", 5)).toBe(false);
    expect(gate.consume("tab-b", 6)).toBe(true);
    expect(gate.getTrackedTabCount()).toBe(1);
  });

  it("rejects invalid targets and action ids", () => {
    const gate = createSearchActionGate();
    expect(gate.consume("", 1)).toBe(false);
    expect(gate.consume("tab-a", 0)).toBe(false);
    expect(gate.consume("tab-a", Number.NaN)).toBe(false);
    expect(gate.getTrackedTabCount()).toBe(0);
  });
});
