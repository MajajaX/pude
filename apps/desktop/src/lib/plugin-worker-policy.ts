import type { PluginManifest } from "../types";
import { t } from "./i18n";

export type PluginWorkerStatusAction =
  | { kind: "notify"; text: string }
  | { kind: "reject"; notification?: string };

export function pluginWorkerStatusAction(
  apiVersion: PluginManifest["apiVersion"],
  hasLegacyUiPermission: boolean,
  value: unknown,
  pluginName: string,
): PluginWorkerStatusAction {
  if (apiVersion === "2") return { kind: "reject" };
  if (!hasLegacyUiPermission) return { kind: "reject", notification: t("{name}: status messages are not permitted.", { name: pluginName }) };
  return { kind: "notify", text: String(value) };
}

export function pluginWorkerFailureNotification(
  apiVersion: PluginManifest["apiVersion"],
  pluginName: string,
  value: unknown,
): string {
  return apiVersion === "1"
    ? t("{name}: {message}", { name: pluginName, message: String(value) })
    : t("{name}: plugin failed and was isolated from the editor.", { name: pluginName });
}
