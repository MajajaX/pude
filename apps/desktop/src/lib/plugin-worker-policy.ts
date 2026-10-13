import type { PluginManifest } from "../types";

export type PluginWorkerStatusAction =
  | { kind: "notify"; text: string }
  | { kind: "reject"; notification?: string };

export function pluginWorkerStatusAction(
  apiVersion: PluginManifest["apiVersion"],
  hasLegacyUiPermission: boolean,
  value: unknown,
): PluginWorkerStatusAction {
  if (apiVersion === "2") return { kind: "reject" };
  if (!hasLegacyUiPermission) return { kind: "reject", notification: "status messages are not permitted." };
  return { kind: "notify", text: String(value) };
}

export function pluginWorkerFailureNotification(
  apiVersion: PluginManifest["apiVersion"],
  pluginName: string,
  value: unknown,
): string {
  return apiVersion === "1"
    ? `${pluginName}: ${String(value)}`
    : `${pluginName}: plugin failed and was isolated from the editor.`;
}
