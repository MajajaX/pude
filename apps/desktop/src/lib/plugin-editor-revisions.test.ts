import { describe, expect, it } from "vitest";
import { PluginEditorRevisionTracker } from "./plugin-editor-revisions";

describe("PluginEditorRevisionTracker", () => {
  it("rejects a token after switching to another document with the same revision", () => {
    const tracker = new PluginEditorRevisionTracker();
    const token = tracker.capture("tab-a", 4, 10);

    expect(tracker.matches(token, "tab-b", 4, 11)).toBe(false);
  });

  it("rejects a token after the active-tab selection changes away and back", () => {
    const tracker = new PluginEditorRevisionTracker();
    const token = tracker.capture("tab-a", 4, 10);

    expect(tracker.matches(token, "tab-a", 4, 12)).toBe(false);
  });

  it("rejects edits after the document revision changes", () => {
    const tracker = new PluginEditorRevisionTracker();
    const token = tracker.capture("tab-a", 4, 10);

    expect(tracker.matches(token, "tab-a", 5, 10)).toBe(false);
    expect(tracker.matches(token, "tab-a", 4, 10)).toBe(true);
  });

  it("drops old snapshots and clears them when the run is disposed", () => {
    const tracker = new PluginEditorRevisionTracker();
    const firstToken = tracker.capture("tab-a", 1, 1);
    let latestToken = firstToken;
    for (let index = 1; index < 1_025; index += 1) {
      latestToken = tracker.capture("tab-a", index + 1, 1);
    }

    expect(tracker.matches(firstToken, "tab-a", 1, 1)).toBe(false);
    expect(tracker.matches(latestToken, "tab-a", 1_025, 1)).toBe(true);

    tracker.clear();
    expect(tracker.matches(latestToken, "tab-a", 1_025, 1)).toBe(false);
  });
});
