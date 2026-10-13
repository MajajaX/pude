export type PluginUninstallLifecycleResult =
  | { status: "blocked"; reason: "plugin-state-storage-failed" | "authorization-storage-failed" }
  | { status: "removed"; cleanupPending: boolean }
  | { status: "retryable"; cleanupPending: boolean };

export async function runPluginUninstallLifecycle(input: {
  disableAndPersistPlugin: () => boolean | Promise<boolean>;
  revokeAuthorizations: () => boolean | Promise<boolean>;
  stopPluginRuntime: () => void | Promise<void>;
  uninstallNative: () => Promise<{ removed: boolean; cleanupPending: boolean }>;
}): Promise<PluginUninstallLifecycleResult> {
  const pluginStatePersisted = await input.disableAndPersistPlugin();
  const authorizationsRevoked = await input.revokeAuthorizations();
  await input.stopPluginRuntime();
  if (!pluginStatePersisted) return { status: "blocked", reason: "plugin-state-storage-failed" };
  if (!authorizationsRevoked) return { status: "blocked", reason: "authorization-storage-failed" };
  const result = await input.uninstallNative();
  return result.removed
    ? { status: "removed", cleanupPending: result.cleanupPending }
    : { status: "retryable", cleanupPending: result.cleanupPending };
}
