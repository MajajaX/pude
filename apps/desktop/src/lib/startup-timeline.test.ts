import { describe, expect, it } from "vitest";
import {
  drainStartupTimeline,
  markFirstFrameShown,
  markStartupEvent,
} from "./startup-timeline";

describe("startup timeline", () => {
  it("records marked events in order with monotonic timestamps", () => {
    drainStartupTimeline();
    markStartupEvent("a");
    markStartupEvent("b");
    const drained = drainStartupTimeline();
    expect(drained.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(drained[0].at).toBeLessThanOrEqual(drained[1].at);
  });

  it("drain empties the timeline", () => {
    drainStartupTimeline();
    markStartupEvent("a");
    expect(drainStartupTimeline()).toHaveLength(1);
    expect(drainStartupTimeline()).toHaveLength(0);
  });

  it("records the animation-frame observation separately from show success", () => {
    drainStartupTimeline();
    markFirstFrameShown();
    const drained = drainStartupTimeline();
    expect(drained.map((entry) => entry.name)).toEqual(["frame-after-show"]);
  });

  it("caps the number of retained entries", () => {
    drainStartupTimeline();
    for (let index = 0; index < 250; index += 1) {
      markStartupEvent(`event-${index}`);
    }
    const drained = drainStartupTimeline();
    expect(drained).toHaveLength(200);
    expect(drained[0].name).toBe("event-0");
  });
});
