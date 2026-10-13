import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let bridge: typeof import("./bridge");

beforeEach(async () => {
  vi.resetModules();
  tauri.invoke.mockReset();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
  bridge = await import("./bridge");
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("plugin workspace bridge", () => {
  it("forwards range reads with their snapshot identity and byte bounds", async () => {
    const fileInfo = { path: "src/main.rs", revision: "revision-1", sizeBytes: 800_000 };
    const range = {
      path: fileInfo.path,
      revision: fileInfo.revision,
      offsetBytes: 128 * 1024,
      nextOffsetBytes: 256 * 1024,
      totalBytes: 800_000,
      content: "next chunk",
      eof: false,
    };
    tauri.invoke.mockResolvedValueOnce(fileInfo).mockResolvedValueOnce(range);

    await expect(bridge.pluginWorkspaceFileInfo("/work/project", fileInfo.path)).resolves.toEqual(fileInfo);
    await expect(bridge.pluginWorkspaceReadFileRange(
      "/work/project",
      fileInfo.path,
      fileInfo.revision,
      range.offsetBytes,
      128 * 1024,
      "native-request-1",
      new AbortController().signal,
    )).resolves.toEqual(range);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "plugin_workspace_file_info", {
      workspace: "/work/project",
      path: fileInfo.path,
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "plugin_workspace_read_file_range", {
      workspace: "/work/project",
      path: fileInfo.path,
      revision: fileInfo.revision,
      offsetBytes: range.offsetBytes,
      maxBytes: 128 * 1024,
      requestId: "native-request-1",
    });
  });

  it("does not leave a native cancel marker when a cold lazy read is aborted before it starts", async () => {
    const controller = new AbortController();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "plugin_workspace_read_file_range") return new Promise(() => undefined);
      return Promise.resolve(true);
    });
    const reading = bridge.pluginWorkspaceReadFileRange(
      "/work/project",
      "src/main.rs",
      "revision-1",
      0,
      128 * 1024,
      "native-request-2",
      controller.signal,
    );
    controller.abort();

    await expect(reading).rejects.toThrow("workspace.read_cancelled");
    await Promise.resolve();
    expect(tauri.invoke).not.toHaveBeenCalledWith("plugin_workspace_read_file_range", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("cancel_plugin_workspace_file_read", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("plugin_workspace_release_file_read", expect.anything());
  });

  it("does not cancel a pre-aborted range and allows its request ID to be reused", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(bridge.pluginWorkspaceReadFileRange(
      "/work/project",
      "src/main.rs",
      "revision-1",
      0,
      128 * 1024,
      "native-request-3",
      controller.signal,
    )).rejects.toThrow("workspace.read_cancelled");
    await Promise.resolve();

    expect(tauri.invoke).not.toHaveBeenCalledWith("plugin_workspace_read_file_range", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("cancel_plugin_workspace_file_read", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("plugin_workspace_release_file_read", expect.anything());

    const range = {
      path: "src/main.rs",
      revision: "revision-1",
      offsetBytes: 0,
      nextOffsetBytes: 8,
      totalBytes: 8,
      content: "contents",
      eof: true,
    };
    tauri.invoke.mockResolvedValueOnce(range);
    await expect(bridge.pluginWorkspaceReadFileRange(
      "/work/project",
      "src/main.rs",
      "revision-1",
      0,
      128 * 1024,
      "native-request-3",
      new AbortController().signal,
    )).resolves.toEqual(range);
    expect(tauri.invoke).toHaveBeenCalledWith("plugin_workspace_read_file_range", expect.objectContaining({
      requestId: "native-request-3",
    }));
  });
});
