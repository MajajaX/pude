import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginHostController } from "./plugin-host";
import type { InstalledPlugin } from "../types";
import type { PluginApiV2InstalledPlugin, PluginApiV2Permission, PluginApiV2PermissionScope } from "./plugin-api-v2";

const plugin: InstalledPlugin = {
  id: "pude.test", name: "Test", version: "1.0.0", apiVersion: "2", entry: "main.js",
  rootPath: "/plugins/test", permissions: [], activationEvents: ["onWorkspaceOpen"],
  enabled: true, status: "inactive", source: "local",
};
const windowHandlers = new Map<string, (event: any) => void>();

function setup(
  resolveApiPermission: Parameters<typeof createPluginHostController>[0]["resolveApiPermission"] = () => false,
  getEditorText: () => string = () => "",
) {
  let installed = [plugin];
  let generation = 0;
  let recovered = true;
  const frames: Array<{ remove: ReturnType<typeof vi.fn>; contentWindow: { postMessage: ReturnType<typeof vi.fn> }; setAttribute: ReturnType<typeof vi.fn>; style: { cssText: string }; srcdoc: string; onerror?: () => void }> = [];
  const append = vi.fn();
  vi.stubGlobal("document", {
    body: { append }, createElement: () => {
      const frame = { remove: vi.fn(), contentWindow: { postMessage: vi.fn() }, setAttribute: vi.fn(), style: { cssText: "" }, srcdoc: "" };
      frames.push(frame);
      return frame;
    },
  });
  const options: Parameters<typeof createPluginHostController>[0] = {
    pluginsRecovered: () => recovered, plugins: () => installed, workspace: () => "/workspace",
    workspaceGeneration: () => generation, isDisposed: () => false, notify: vi.fn(),
    readPluginEntry: vi.fn(async () => "export function activate() {}"), getEditorText,
    setPluginStatus: vi.fn(), resolveApiPermission, executeApi: () => vi.fn(),
    readStorage: vi.fn(() => null), writeStorage: vi.fn(() => true), onAuthorizationChange: vi.fn(),
  };
  const controller = createPluginHostController(options);
  return { controller, options, append, frames, windowHandlers,
    changeWorkspace: () => { generation += 1; },
    replacePlugin: () => { installed = [{ ...plugin, version: "2.0.0" }]; },
    setPlugins: (items: InstalledPlugin[]) => { installed = items; },
    setRecovered: (value: boolean) => { recovered = value; },
  };
}

describe("plugin host controller lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    windowHandlers.clear();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn((type: string, handler: (event: any) => void) => windowHandlers.set(type, handler)),
      removeEventListener: vi.fn((type: string, handler: (event: any) => void) => {
        if (windowHandlers.get(type) === handler) windowHandlers.delete(type);
      }),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("fails closed until recovery finishes and while a plugin is disabled", async () => {
    const test = setup();
    test.setRecovered(false);
    await test.controller.runPlugin(plugin, "onWorkspaceOpen", {});
    test.setRecovered(true);
    await test.controller.runPlugin({ ...plugin, enabled: false }, "onWorkspaceOpen", {});
    expect(test.options.readPluginEntry).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });

  it.each(["workspace", "version", "dispose"])("drops a delayed entry after %s changes", async (change) => {
    const test = setup();
    let release!: (source: string) => void;
    vi.mocked(test.options.readPluginEntry).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const start = test.controller.runPlugin(plugin, "onWorkspaceOpen", {});
    if (change === "workspace") test.changeWorkspace();
    if (change === "version") test.replacePlugin();
    if (change === "dispose") test.controller.dispose();
    release("source");
    await start;
    expect(test.append).not.toHaveBeenCalled();
    expect(test.controller.runsFor(plugin.id)).toEqual([]);
  });

  it("owns and disposes its frame, listener, timeout and API exactly once", async () => {
    const test = setup();
    await test.controller.runPlugin(plugin, "onWorkspaceOpen", {});
    const [run] = test.controller.runsFor(plugin.id);
    expect(test.append).toHaveBeenCalledOnce();
    expect(test.controller.isLive(run)).toBe(true);
    test.controller.dispose();
    test.controller.dispose();
    expect(test.controller.runsFor(plugin.id)).toEqual([]);
    expect(run.disposed).toBe(true);
    expect(window.removeEventListener).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(test.frames[0].remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops authorization subscriptions on dispose and loads persisted grants lazily", () => {
    const test = setup();
    expect(test.options.readStorage).not.toHaveBeenCalled();
    const manager = test.controller.authorization();
    expect(test.controller.authorization()).toBe(manager);
    expect(test.options.readStorage).toHaveBeenCalledOnce();
    manager.notifyWorkspaceChanged("/workspace", "/second");
    expect(test.options.onAuthorizationChange).toHaveBeenCalledOnce();
    test.controller.dispose();
    manager.notifyWorkspaceChanged("/second", "/third");
    expect(test.options.onAuthorizationChange).toHaveBeenCalledOnce();
  });

  it("filters API 1's initial editor text and legacy facade through saved grants", async () => {
    const granted = new Set(["commands.register", "ui.notification"]);
    const resolveApiPermission = vi.fn(async (_installed: PluginApiV2InstalledPlugin, permission: PluginApiV2Permission, _scope: PluginApiV2PermissionScope) => granted.has(permission));
    const getEditorText = vi.fn(() => "private editor sentinel");
    const test = setup(resolveApiPermission, getEditorText);
    const legacyPlugin: InstalledPlugin = {
      ...plugin,
      apiVersion: "1",
      permissions: ["editor.read", "commands.register", "ui.notification", "ui.statusBar"],
      activationEvents: ["onCommand:pude.test.run"],
      contributes: { commands: [{ command: "pude.test.run", title: "Run" }] },
    };
    test.setPlugins([legacyPlugin]);
    vi.mocked(test.options.readPluginEntry).mockResolvedValue(
      "self.exposed = { editor: !!pude.editor, text: editorText, commands: !!pude.commands, notify: !!pude.ui?.notify, statusBar: !!pude.ui?.statusBar };",
    );
    await test.controller.runPlugin(legacyPlugin, "onCommand:pude.test.run", {}, "pude.test.run");
    const [run] = test.controller.runsFor(legacyPlugin.id);
    test.windowHandlers.get("message")?.({
      source: run.frame.contentWindow,
      data: { type: "frame-ready", token: run.token },
    });
    const start = test.frames[0].contentWindow.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "start");
    expect(start).toBeDefined();
    const worker = { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn>; exposed?: unknown };
    new Function("self", start.source)(worker);

    expect(getEditorText).not.toHaveBeenCalled();
    expect(worker.exposed).toEqual({ editor: false, text: "", commands: true, notify: true, statusBar: false });
    expect(start.source).not.toContain("private editor sentinel");
    expect(resolveApiPermission).toHaveBeenCalledWith(legacyPlugin, "editor.read", { workspaceRoot: "/workspace" });
    expect(resolveApiPermission).toHaveBeenCalledWith(legacyPlugin, "commands.register", { workspaceRoot: "/workspace" });
  });

  it("provides API 1 editor data when editor.read was approved", async () => {
    const resolveApiPermission = vi.fn(async (_installed: PluginApiV2InstalledPlugin, permission: PluginApiV2Permission, _scope: PluginApiV2PermissionScope) => permission === "editor.read");
    const getEditorText = vi.fn(() => "approved editor sentinel");
    const test = setup(resolveApiPermission, getEditorText);
    const legacyPlugin: InstalledPlugin = { ...plugin, apiVersion: "1", permissions: ["editor.read"] };
    test.setPlugins([legacyPlugin]);
    vi.mocked(test.options.readPluginEntry).mockResolvedValue("self.exposed = pude.editor.getText();");
    await test.controller.runPlugin(legacyPlugin, "onWorkspaceOpen", {});
    const [run] = test.controller.runsFor(legacyPlugin.id);
    test.windowHandlers.get("message")?.({
      source: run.frame.contentWindow,
      data: { type: "frame-ready", token: run.token },
    });
    const start = test.frames[0].contentWindow.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "start");
    const worker = { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn>; exposed?: unknown };
    new Function("self", start.source)(worker);

    expect(getEditorText).toHaveBeenCalledOnce();
    expect(start.source).toContain('const editorText = "approved editor sentinel";');
    expect(worker.exposed).toBe("approved editor sentinel");
  });
});
