import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh module per test, since the timeline keeps its count for the whole page. */
async function timeline() {
  vi.resetModules();
  performance.clearMarks();
  return import("./startup-timeline");
}

const marks = () => performance.getEntriesByType("mark");

describe("startup timeline", () => {
  beforeEach(() => performance.clearMarks());

  it("records marked events in order with monotonic timestamps", async () => {
    const { markStartupEvent } = await timeline();
    markStartupEvent("a");
    markStartupEvent("b");
    expect(marks().map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(marks()[0].startTime).toBeLessThanOrEqual(marks()[1].startTime);
  });

  it("records the animation-frame observation separately from show success", async () => {
    const { markFirstFrameShown } = await timeline();
    markFirstFrameShown();
    expect(marks().map((entry) => entry.name)).toEqual(["frame-after-show"]);
  });

  it("caps the number of recorded events", async () => {
    const { markStartupEvent } = await timeline();
    for (let index = 0; index < 250; index += 1) markStartupEvent(`event-${index}`);
    expect(marks()).toHaveLength(200);
    expect(marks()[0].name).toBe("event-0");
  });
});
