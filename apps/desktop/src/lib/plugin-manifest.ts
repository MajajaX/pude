import type { InstalledPlugin, PluginManifest, PluginPermission } from "../types";

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const supportedExactActivationEvents = new Set(["onFileOpen", "onFileSave", "onWorkspaceOpen"]);

function isValidActivationEvent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (supportedExactActivationEvents.has(value)) return true;
  const command = /^onCommand:(.+)$/.exec(value);
  if (command) return pluginIdPattern.test(command[1]);
  const language = /^onLanguage:(.+)$/.exec(value);
  return Boolean(language && pluginIdPattern.test(language[1]));
}

function parseContributes(value: unknown): PluginManifest["contributes"] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "commands")) return null;
  if (value.commands === undefined) return {};
  if (!Array.isArray(value.commands)) return null;
  const commands = value.commands.flatMap((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== "command" && key !== "title")
        || typeof item.command !== "string" || !pluginIdPattern.test(item.command)
        || typeof item.title !== "string" || !item.title.trim() || item.title.length > 128) return [];
    return [{ command: item.command, title: item.title.trim() }];
  });
  if (commands.length !== value.commands.length || new Set(commands.map((command) => command.command)).size !== commands.length) return null;
  return { commands };
}

function isValidHttpsDomain(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 253 || value.trim() !== value || /[\s/@?#]/.test(value)) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.protocol === "https:" && url.hostname === value && !url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isAbsoluteExecutable(value: string): boolean {
  return value.length <= 4096 && !value.includes("\u0000")
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));
}

function parseNetworkDomains(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isValidHttpsDomain) || new Set(value).size !== value.length) return null;
  return [...value];
}

function parseLspServers(value: unknown): PluginManifest["lspServers"] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const servers = value.flatMap((server) => {
    if (!isRecord(server)
        || typeof server.serverId !== "string" || !pluginIdPattern.test(server.serverId)
        || typeof server.language !== "string" || !pluginIdPattern.test(server.language)
        || typeof server.executable !== "string" || !isAbsoluteExecutable(server.executable)
        || !Array.isArray(server.args) || server.args.length > 64
        || !server.args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\u0000"))) return [];
    return [{ serverId: server.serverId, language: server.language, executable: server.executable, args: [...server.args] as string[] }];
  });
  if (servers.length !== value.length || new Set(servers.map((server) => server.serverId)).size !== servers.length) return null;
  return servers;
}

const legacyPermissions = new Set<PluginPermission>([
  "editor.read",
  "commands.register",
  "ui.notification",
  "ui.statusBar",
]);

const apiV2Permissions = new Set<PluginPermission>([
  "editor.read",
  "editor.write",
  "workspace.read",
  "workspace.write",
  "commands.register",
  "ui.notification",
  "ui.statusBar",
  "ui.quickPick",
  "git.read",
  "terminal.write",
  "network",
  "process.spawn:lsp",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePluginManifest(value: unknown): PluginManifest | null {
  if (!isRecord(value)
      || typeof value.id !== "string"
      || typeof value.name !== "string"
      || typeof value.version !== "string"
      || (value.apiVersion !== "1" && value.apiVersion !== "2")
      || typeof value.entry !== "string"
      || !Array.isArray(value.permissions)
      || !Array.isArray(value.activationEvents)) return null;
  const supportedPermissions = value.apiVersion === "1" ? legacyPermissions : apiV2Permissions;
  if (!value.permissions.every((permission) => typeof permission === "string" && supportedPermissions.has(permission as PluginPermission))
      || !value.activationEvents.every(isValidActivationEvent)
      || new Set(value.activationEvents).size !== value.activationEvents.length) return null;
  const contributes = parseContributes(value.contributes);
  if (contributes === null) return null;
  const manifest: PluginManifest = {
    id: value.id,
    name: value.name,
    version: value.version,
    apiVersion: value.apiVersion,
    entry: value.entry,
    permissions: value.permissions as PluginPermission[],
    activationEvents: value.activationEvents as string[],
  };
  if (contributes !== undefined) manifest.contributes = contributes;
  const networkDomains = parseNetworkDomains(value.networkDomains);
  if (networkDomains === null) return null;
  if (networkDomains !== undefined) manifest.networkDomains = networkDomains;
  const lspServers = parseLspServers(value.lspServers);
  if (lspServers === null) return null;
  if (lspServers !== undefined) manifest.lspServers = lspServers;
  return manifest;
}

export function parseInstalledPlugin(value: unknown): InstalledPlugin | null {
  if (!isRecord(value) || value.source !== "local" || typeof value.rootPath !== "string") return null;
  const manifest = parsePluginManifest(value);
  if (!manifest) return null;
  return {
    ...manifest,
    enabled: value.enabled === true,
    status: "inactive",
    source: "local",
    rootPath: value.rootPath,
  };
}
