import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
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

const manifest = {
  id: "pude.example.case-toggle",
  name: "Case Toggle",
  version: "2.0.0",
  apiVersion: "2" as const,
  entry: "extension.js",
  permissions: ["editor.read", "editor.write"] as const,
  activationEvents: ["onCommand:pude.example.case-toggle.toggle"],
  contributes: {
    commands: [{ command: "pude.example.case-toggle.toggle", title: "Toggle Case" }],
  },
};

describe("plugin installation bridge", () => {
  it("stages a candidate for review without committing it", async () => {
    const plan = {
      transactionId: "install-transaction",
      manifest,
      installedManifest: null,
    };
    tauri.invoke.mockResolvedValue(plan);

    await expect(bridge.inspectPluginInstall()).resolves.toEqual(plan);

    expect(tauri.invoke).toHaveBeenCalledWith("inspect_plugin_dialog");
    expect(tauri.invoke).not.toHaveBeenCalledWith("commit_plugin_install", expect.anything());
  });

  it("commits an approved same-id update as disabled and reports retained cleanup work", async () => {
    const oldManifest = { ...manifest, version: "1.0.0" };
    const plan = {
      transactionId: "update-transaction",
      manifest,
      installedManifest: oldManifest,
    };
    const nativeResult = {
      path: "/app-data/plugins/pude.example.case-toggle",
      manifest,
      cleanupPending: true,
    };
    tauri.invoke.mockResolvedValueOnce(plan).mockResolvedValueOnce(nativeResult);

    const reviewed = await bridge.inspectPluginInstall();
    expect(reviewed?.installedManifest?.version).toBe("1.0.0");
    expect(tauri.invoke).toHaveBeenCalledTimes(1);

    const committed = await bridge.commitPluginInstall(reviewed!.transactionId);
    expect(committed.plugin).toMatchObject({
      ...manifest,
      rootPath: nativeResult.path,
      enabled: false,
      status: "inactive",
      source: "local",
    });
    expect(committed.cleanupPending).toBe(true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("commit_plugin_install", {
      transactionId: "update-transaction",
    });
  });

  it("removes an uninstalled plugin from the visible list and exposes cleanup retry state", async () => {
    tauri.invoke.mockResolvedValue({ removed: true, cleanupPending: true });

    await expect(bridge.uninstallPlugin(manifest.id)).resolves.toEqual({
      removed: true,
      cleanupPending: true,
    });
    expect(tauri.invoke).toHaveBeenCalledWith("uninstall_plugin", { id: manifest.id });

    tauri.invoke.mockResolvedValue({ removed: true, cleanupPending: false });
    await expect(bridge.uninstallPlugin(manifest.id)).resolves.toEqual({
      removed: true,
      cleanupPending: false,
    });
    expect(tauri.invoke).toHaveBeenLastCalledWith("uninstall_plugin", { id: manifest.id });
  });

  it("retries cleanup without uninstalling an installed plugin", async () => {
    tauri.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(bridge.retryPluginCleanup(manifest.id)).resolves.toBe(true);
    await expect(bridge.retryPluginCleanup(manifest.id)).resolves.toBe(false);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "retry_plugin_cleanup", { id: manifest.id });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "retry_plugin_cleanup", { id: manifest.id });
  });

  it("recovers native plugin versions before App hydrates plugin workers", async () => {
    tauri.invoke.mockResolvedValue({
      plugins: [{ path: "/app-data/plugins/pude.example.case-toggle", manifest, cleanupPending: false }],
      pendingCleanupIds: ["pude.example.removed"],
    });

    await expect(bridge.recoverPluginUpdates([manifest.id])).resolves.toEqual({
      plugins: [{
        ...manifest,
        rootPath: "/app-data/plugins/pude.example.case-toggle",
        enabled: false,
        status: "inactive",
        source: "local",
      }],
      pendingCleanupIds: ["pude.example.removed"],
    });
    expect(tauri.invoke).toHaveBeenCalledWith("recover_plugin_updates", { ids: [manifest.id] });
  });

  it("cleans a staged candidate after a user cancels review", async () => {
    const plan = {
      transactionId: "cancelled-transaction",
      manifest,
      installedManifest: null,
    };
    tauri.invoke.mockResolvedValue(plan);

    const reviewed = await bridge.inspectPluginInstall();
    await bridge.cancelPluginInstall(reviewed!.transactionId);

    expect(tauri.invoke).toHaveBeenCalledWith("cancel_plugin_install", {
      transactionId: "cancelled-transaction",
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith("commit_plugin_install", expect.anything());
  });
});
