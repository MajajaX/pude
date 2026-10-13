import { Channel, invoke } from "@tauri-apps/api/core";
import type { DiffResult, InstalledPlugin, PluginManifest, ReadFileResult } from "../types";
import type {
  LspApprovalRequest,
  LspEvent,
  LspServerDeclaration,
  LspServerIdentity,
  LspServerRequest,
  PluginInstallPlan,
  PluginInstallResult,
  PluginNetworkResponse,
  PluginWorkspaceFileInfo,
  PluginWorkspaceFileRange,
  PluginWorkspaceListResult,
  PluginWorkspaceWriteResult,
  ResolvedLspServer,
} from "./bridge";
import type { PluginResolvedLspServer } from "./plugin-authorization";

export async function inspectPluginInstall(): Promise<PluginInstallPlan | null> {
  return invoke<PluginInstallPlan | null>("inspect_plugin_dialog");
}

export async function commitPluginInstall(transactionId: string): Promise<PluginInstallResult> {
  const result = await invoke<{ path: string; manifest: PluginManifest; cleanupPending: boolean }>("commit_plugin_install", { transactionId });
  return {
    plugin: { ...result.manifest, rootPath: result.path, enabled: false, status: "inactive", source: "local" },
    cleanupPending: result.cleanupPending,
  };
}

export async function cancelPluginInstall(transactionId: string): Promise<void> {
  await invoke("cancel_plugin_install", { transactionId });
}

export async function uninstallPlugin(id: string): Promise<{ removed: boolean; cleanupPending: boolean }> {
  return invoke("uninstall_plugin", { id });
}

export async function rollbackPluginUpdate(id: string): Promise<InstalledPlugin> {
  const result = await invoke<{ path: string; manifest: PluginManifest }>("rollback_plugin_update", { id });
  return { ...result.manifest, rootPath: result.path, enabled: false, status: "inactive", source: "local" };
}

export async function retryPluginCleanup(id: string): Promise<boolean> {
  return invoke<boolean>("retry_plugin_cleanup", { id });
}

export async function readPluginEntry(rootPath: string, entry: string): Promise<string> {
  return invoke<string>("read_plugin_entry", { rootPath, entry });
}

export async function canonicalizeWorkspaceRoot(workspace: string): Promise<string> {
  return invoke<string>("plugin_workspace_canonicalize", { workspace });
}

export async function pluginWorkspaceList(workspace: string, path = "."): Promise<PluginWorkspaceListResult> {
  return invoke<PluginWorkspaceListResult>("plugin_workspace_list", { workspace, path });
}

export async function pluginWorkspaceReadFile(workspace: string, path: string): Promise<ReadFileResult> {
  return invoke<ReadFileResult>("plugin_workspace_read_file", { workspace, path });
}

export async function pluginWorkspaceFileInfo(workspace: string, path: string): Promise<PluginWorkspaceFileInfo> {
  return invoke<PluginWorkspaceFileInfo>("plugin_workspace_file_info", { workspace, path });
}

export async function pluginWorkspaceReleaseFileRead(workspace: string, path: string, revision: string): Promise<void> {
  await invoke("plugin_workspace_release_file_read", { workspace, path, revision });
}

export async function pluginWorkspaceReadFileRange(
  workspace: string,
  path: string,
  revision: string,
  offsetBytes: number,
  maxBytes: number,
  requestId: string,
  signal: AbortSignal,
): Promise<PluginWorkspaceFileRange> {
  const cancel = () => {
    void invoke("cancel_plugin_workspace_file_read", { requestId }).catch(() => undefined);
    void pluginWorkspaceReleaseFileRead(workspace, path, revision).catch(() => undefined);
  };
  if (signal.aborted) throw new Error("workspace.read_cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke<PluginWorkspaceFileRange>("plugin_workspace_read_file_range", { workspace, path, revision, offsetBytes, maxBytes, requestId });
    if (signal.aborted) { cancel(); throw new Error("workspace.read_cancelled"); }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function pluginWorkspaceWriteFile(
  workspace: string,
  path: string,
  content: string,
  expectedFingerprint?: string,
): Promise<PluginWorkspaceWriteResult> {
  return invoke<PluginWorkspaceWriteResult>("plugin_workspace_write_file", {
    workspace,
    path,
    content,
    expectedFingerprint: expectedFingerprint ?? null,
  });
}

export async function pluginGitDiff(workspace: string, path: string, staged = false): Promise<DiffResult> {
  return invoke<DiffResult>("plugin_git_diff", { workspace, path, staged });
}

export async function authorizePluginNetwork(
  pluginId: string,
  pluginVersion: string,
  workspace: string,
  domain: string,
): Promise<string> {
  return invoke<string>("plugin_network_authorize", { pluginId, pluginVersion, workspace, domain });
}

export async function pluginNetworkRequest(
  authorizationToken: string,
  workspace: string,
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<PluginNetworkResponse> {
  return invoke<PluginNetworkResponse>("plugin_network_request", {
    authorizationToken,
    workspace,
    url,
    method,
    headers,
    body: body ?? null,
  });
}

export async function revokePluginNetwork(pluginId: string, workspace?: string): Promise<void> {
  await invoke("plugin_network_revoke", { pluginId, workspace: workspace ?? null });
}

export async function cancelPluginNetworkRequest(authorizationToken: string, workspace: string): Promise<void> {
  await invoke("plugin_network_cancel", { authorizationToken, workspace });
}

export async function resolveLspServer(
  workspaceRoot: string,
  server: LspServerDeclaration,
): Promise<ResolvedLspServer> {
  return invoke<ResolvedLspServer>("lsp_resolve_server", { request: { workspaceRoot, server } });
}

export async function resolvePluginLspServer(
  workspaceRoot: string,
  server: LspServerDeclaration,
): Promise<PluginResolvedLspServer> {
  return resolveLspServer(workspaceRoot, server);
}

export async function approveLspServer(request: LspApprovalRequest): Promise<void> {
  await invoke("lsp_approve_server", { grant: request });
}

export async function revokeLspServer(request: LspServerRequest): Promise<void> {
  await invoke("lsp_revoke_server", {
    pluginId: request.pluginId,
    pluginVersion: request.pluginVersion,
    workspaceRoot: request.workspaceRoot,
    serverId: request.server.serverId,
    language: request.server.language,
  });
}

export async function startLspServer(request: LspServerRequest, onEvent: (event: LspEvent) => void = () => undefined): Promise<void> {
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  await invoke("lsp_start_server", { request, events: channel });
}

export async function sendLspMessage(
  identity: LspServerIdentity,
  message: Record<string, unknown>,
): Promise<void> {
  await invoke("lsp_send_message", { request: { ...identity, message } });
}

export async function cancelLspRequest(
  identity: LspServerIdentity,
  requestId: string | number,
): Promise<void> {
  await invoke("lsp_cancel_request", { request: { ...identity, requestId } });
}

export async function stopLspServer(identity: LspServerIdentity): Promise<void> {
  await invoke("lsp_stop_server", identity);
}

export async function stopPluginLsp(pluginId: string): Promise<void> {
  await invoke("lsp_stop_plugin", { pluginId });
}

export async function stopWorkspaceLsp(workspaceRoot: string): Promise<void> {
  await invoke("lsp_stop_workspace", { workspaceRoot });
}
