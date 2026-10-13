import { afterEach, describe, expect, it } from "vitest";
import { registerActivePluginTerminal, writeToActivePluginTerminal } from "./plugin-terminal";

describe("plugin terminal bridge", () => {
  let unregister: (() => void) | undefined;

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("writes only to the active terminal registered for the current workspace", async () => {
    const writes: Array<[string, boolean]> = [];
    unregister = registerActivePluginTerminal("/workspace/project", "pty-1", async (data, binary) => {
      writes.push([data, binary]);
    });

    await writeToActivePluginTerminal("/workspace/project", "echo hi\n");
    await writeToActivePluginTerminal("/workspace/project", "\u0000", true);

    expect(writes).toEqual([["echo hi\n", false], ["\u0000", true]]);
    await expect(writeToActivePluginTerminal("/workspace/other", "nope")).rejects.toThrow("No active user-opened terminal");
  });

  it("removes the writer when its active session unregisters", async () => {
    unregister = registerActivePluginTerminal("/workspace/project", "pty-2", async () => undefined);
    unregister();
    unregister = undefined;

    await expect(writeToActivePluginTerminal("/workspace/project", "nope")).rejects.toThrow("No active user-opened terminal");
  });

  it("rejects an aborted write before dispatching it to the active terminal", async () => {
    let called = false;
    unregister = registerActivePluginTerminal("/workspace/project", "pty-3", async () => { called = true; });
    const controller = new AbortController();
    controller.abort();

    await expect(writeToActivePluginTerminal("/workspace/project", "echo hi\n", false, controller.signal))
      .rejects.toThrow("Plugin terminal write was cancelled.");
    expect(called).toBe(false);
  });

  it("passes the final authorization guard through to the queued PTY writer", async () => {
    let authorized = false;
    unregister = registerActivePluginTerminal("/workspace/project", "pty-4", async (_data, _binary, _signal, guard) => {
      await guard?.();
    });

    await writeToActivePluginTerminal(
      "/workspace/project",
      "echo hi\n",
      false,
      undefined,
      async () => { authorized = true; },
    );

    expect(authorized).toBe(true);
  });
});
