import { invoke } from "@tauri-apps/api/core";
import type { InstalledPlugin, PluginManifest } from "../types";
import type { PluginStartupRecoveryResult } from "./bridge";

export async function recoverPluginUpdates(ids: string[]): Promise<PluginStartupRecoveryResult> {
  const result = await invoke<{
    plugins: Array<{ path: string; manifest: PluginManifest; cleanupPending: boolean }>;
    pendingCleanupIds: string[];
  }>("recover_plugin_updates", { ids });
  return {
    plugins: result.plugins.map(({ path, manifest }) => ({
      ...manifest,
      rootPath: path,
      enabled: false,
      status: "inactive",
      source: "local",
    })),
    pendingCleanupIds: result.pendingCleanupIds,
  };
}
