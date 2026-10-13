import { describe, expect, it, vi } from "vitest";
import { runPluginUninstallLifecycle } from "./plugin-lifecycle";

describe("plugin uninstall lifecycle", () => {
  it("persists disabled state before native uninstall and stays disabled when removal is retryable", async () => {
    let enabled = true;
    const calls: string[] = [];
    const result = await runPluginUninstallLifecycle({
      disableAndPersistPlugin: () => {
        enabled = false;
        calls.push("disable-and-persist");
        return true;
      },
      revokeAuthorizations: () => {
        calls.push("revoke-authorizations");
        return true;
      },
      stopPluginRuntime: () => { calls.push("stop-runtime"); },
      uninstallNative: async () => {
        calls.push("native-uninstall");
        return { removed: false, cleanupPending: false };
      },
    });

    expect(result).toEqual({ status: "retryable", cleanupPending: false });
    expect(enabled).toBe(false);
    expect(calls).toEqual(["disable-and-persist", "revoke-authorizations", "stop-runtime", "native-uninstall"]);
  });

  it("revokes grants and stops runtime but blocks native uninstall if disabled state cannot be persisted", async () => {
    const revokeAuthorizations = vi.fn(() => true);
    const stopPluginRuntime = vi.fn();
    const uninstallNative = vi.fn(async () => ({ removed: true, cleanupPending: false }));

    const result = await runPluginUninstallLifecycle({
      disableAndPersistPlugin: () => false,
      revokeAuthorizations,
      stopPluginRuntime,
      uninstallNative,
    });

    expect(result).toEqual({ status: "blocked", reason: "plugin-state-storage-failed" });
    expect(revokeAuthorizations).toHaveBeenCalledOnce();
    expect(stopPluginRuntime).toHaveBeenCalledOnce();
    expect(uninstallNative).not.toHaveBeenCalled();
  });

  it("keeps persisted disabled state and stops runtime when authorization storage fails", async () => {
    let enabled = true;
    const stopPluginRuntime = vi.fn();
    const uninstallNative = vi.fn(async () => ({ removed: true, cleanupPending: false }));

    const result = await runPluginUninstallLifecycle({
      disableAndPersistPlugin: () => {
        enabled = false;
        return true;
      },
      revokeAuthorizations: () => false,
      stopPluginRuntime,
      uninstallNative,
    });

    expect(result).toEqual({ status: "blocked", reason: "authorization-storage-failed" });
    expect(enabled).toBe(false);
    expect(stopPluginRuntime).toHaveBeenCalledOnce();
    expect(uninstallNative).not.toHaveBeenCalled();
  });

  it("keeps the plugin disabled if native uninstall rejects", async () => {
    let enabled = true;
    const uninstallNative = vi.fn(async () => { throw new Error("remove failed"); });

    await expect(runPluginUninstallLifecycle({
      disableAndPersistPlugin: () => {
        enabled = false;
        return true;
      },
      revokeAuthorizations: () => true,
      stopPluginRuntime: () => undefined,
      uninstallNative,
    })).rejects.toThrow("remove failed");

    expect(enabled).toBe(false);
    expect(uninstallNative).toHaveBeenCalledOnce();
  });
});
