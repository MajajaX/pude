import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  // bridge.startLspServer creates a per-start tauri::ipc::Channel
  // and passes it as the `events` invoke argument.
  Channel: class MockChannel {
    onmessage: ((message: unknown) => void) | undefined;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: tauri.Channel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let bridge: typeof import("./bridge");

beforeEach(async () => {
  vi.resetModules();
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
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

const server = {
  serverId: "rust-analyzer",
  language: "rust",
  executable: "/usr/local/bin/rust-analyzer",
  args: ["--stdio"],
};

const request = {
  pluginId: "pude.example.lsp",
  pluginVersion: "1.0.0",
  workspaceRoot: "/work/project",
  server,
};

describe("plugin LSP bridge", () => {
  it("resolves the reviewed executable and binds native approval to that canonical path", async () => {
    const resolved = {
      workspaceRoot: "/work/project",
      serverId: server.serverId,
      language: server.language,
      executablePath: "/opt/tools/rust-analyzer",
      args: server.args,
    };
    tauri.invoke.mockResolvedValue(resolved);

    await expect(bridge.resolvePluginLspServer("/work/project", server)).resolves.toEqual(resolved);
    expect(tauri.invoke).toHaveBeenCalledWith("lsp_resolve_server", {
      request: { workspaceRoot: "/work/project", server },
    });

    await bridge.approveLspServer({ ...request, expectedExecutablePath: resolved.executablePath });
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_approve_server", {
      grant: { ...request, expectedExecutablePath: resolved.executablePath },
    });
  });

  it("keeps start, send, cancel, stop, revoke, and cleanup on named native commands", async () => {
    await bridge.startLspServer(request);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_start_server", {
      request,
      events: expect.any(tauri.Channel),
    });

    const identity = {
      pluginId: request.pluginId,
      pluginVersion: request.pluginVersion,
      workspaceRoot: request.workspaceRoot,
      language: server.language,
    };
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    await bridge.sendLspMessage(identity, message);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_send_message", { request: { ...identity, message } });
    await bridge.cancelLspRequest(identity, 1);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_cancel_request", { request: { ...identity, requestId: 1 } });
    await bridge.stopLspServer(identity);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_stop_server", identity);
    await bridge.revokeLspServer(request);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_revoke_server", {
      pluginId: request.pluginId,
      pluginVersion: request.pluginVersion,
      workspaceRoot: request.workspaceRoot,
      serverId: server.serverId,
      language: server.language,
    });
    await bridge.stopPluginLsp(request.pluginId);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_stop_plugin", { pluginId: request.pluginId });
    await bridge.stopWorkspaceLsp(request.workspaceRoot);
    expect(tauri.invoke).toHaveBeenLastCalledWith("lsp_stop_workspace", { workspaceRoot: request.workspaceRoot });
  });

  it("forwards managed LSP events through the channel passed to start", async () => {
    const event = {
      type: "message",
      pluginId: request.pluginId,
      pluginVersion: request.pluginVersion,
      workspaceRoot: request.workspaceRoot,
      language: "rust",
      serverId: server.serverId,
      message: { jsonrpc: "2.0", id: 1, result: null },
    };
    const received: unknown[] = [];

    await bridge.startLspServer(request, (payload) => received.push(payload));

    const [, args] = tauri.invoke.mock.calls.at(-1) ?? [];
    const channel = (args as { events: InstanceType<typeof tauri.Channel> }).events;
    expect(channel).toBeInstanceOf(tauri.Channel);
    // The native side delivers events by sending on the start-time channel;
    // simulate one native event arriving on it.
    channel.onmessage?.(event);
    expect(received).toEqual([event]);
    expect(tauri.listen).not.toHaveBeenCalled();
  });
});
