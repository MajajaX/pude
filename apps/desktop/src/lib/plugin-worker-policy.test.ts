import { describe, expect, it, vi } from "vitest";
import { pluginWorkerFailureNotification, pluginWorkerStatusAction } from "./plugin-worker-policy";

describe("plugin worker host effects", () => {
  it("does not turn an API 2 forged status message into a notification", () => {
    const notify = vi.fn();
    const action = pluginWorkerStatusAction("2", true, "forged toast");

    if (action.kind === "notify") notify(action.text);

    expect(action).toEqual({ kind: "reject" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps API 1 status behavior and hides API 2 worker error text", () => {
    expect(pluginWorkerStatusAction("1", true, "legacy status")).toEqual({ kind: "notify", text: "legacy status" });
    expect(pluginWorkerStatusAction("1", false, "legacy status")).toEqual({ kind: "reject", notification: "status messages are not permitted." });
    expect(pluginWorkerFailureNotification("1", "Example", "legacy error")).toBe("Example: legacy error");
    expect(pluginWorkerFailureNotification("2", "Example", "forged notification")).toBe("Example: plugin failed and was isolated from the editor.");
  });
});
