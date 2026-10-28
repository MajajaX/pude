import type { InstalledPlugin, PluginCommandContribution } from "../types";
import { BUILTIN_COMMANDS } from "./builtin-commands";
import type { LspEvent } from "./bridge";

export type PluginActivationEvent =
  | { kind: "command"; command: string }
  | { kind: "language"; language: string }
  | { kind: "file-open" }
  | { kind: "file-save" }
  | { kind: "workspace-open" };

export type CommandPaletteItem = {
  id: string;
  title: string;
  source: "builtin" | "plugin";
  detail?: string;
  pluginId?: string;
  commandId?: string;
  /** Keyboard shortcut with `Mod` for Cmd on macOS and Ctrl elsewhere. */
  shortcut?: string;
};

export const LSP_RUNTIME_EVENTS = ["lsp.message", "lsp.state", "lsp.stderr"] as const;

export function isPluginLspEventForRun(
  run: { pluginId: string; pluginVersion: string; apiVersion: string; workspaceRoot: string; workspaceGeneration: number; disposed: boolean },
  event: LspEvent,
  workspace: { workspaceRoot: string; canonicalWorkspaceRoot: string; generation: number },
): boolean {
  return !run.disposed
    && run.apiVersion === "2"
    && run.pluginId === event.pluginId
    && run.pluginVersion === event.pluginVersion
    && run.workspaceGeneration === workspace.generation
    && run.workspaceRoot === workspace.workspaceRoot
    && event.workspaceRoot === workspace.canonicalWorkspaceRoot;
}

export { BUILTIN_COMMANDS } from "./builtin-commands";

const commandIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parsePluginActivationEvent(value: string): PluginActivationEvent | null {
  const command = /^onCommand:(.+)$/.exec(value);
  if (command && commandIdPattern.test(command[1])) return { kind: "command", command: command[1] };
  const language = /^onLanguage:(.+)$/.exec(value);
  if (language && commandIdPattern.test(language[1])) return { kind: "language", language: language[1].toLowerCase() };
  if (value === "onFileOpen") return { kind: "file-open" };
  if (value === "onFileSave") return { kind: "file-save" };
  if (value === "onWorkspaceOpen") return { kind: "workspace-open" };
  return null;
}

/**
 * Validate Worker event subscriptions against the installed manifest.
 * LSP events are runtime-only: they are available to API 2 plugins that
 * declare the controlled LSP permission and at least one server.
 */
export function isPluginEventSubscriptionAllowed(
  plugin: Pick<InstalledPlugin, "apiVersion" | "activationEvents" | "permissions" | "lspServers">,
  eventName: string,
): boolean {
  if (LSP_RUNTIME_EVENTS.some((event) => event === eventName)) {
    return plugin.apiVersion === "2"
      && plugin.permissions.includes("process.spawn:lsp")
      && (plugin.lspServers?.length ?? 0) > 0;
  }
  return plugin.activationEvents.includes(eventName) && parsePluginActivationEvent(eventName) !== null;
}

export function parsePluginEventSubscriptions(
  plugin: Pick<InstalledPlugin, "apiVersion" | "activationEvents" | "permissions" | "lspServers">,
  value: unknown,
): string[] | null {
  if (!Array.isArray(value)
      || !value.every((event): event is string => typeof event === "string")
      || new Set(value).size !== value.length
      || !value.every((event) => isPluginEventSubscriptionAllowed(plugin, event))) return null;
  return [...value];
}

type StartingCommandRun = {
  ready: boolean;
  activationCommand?: string;
  pendingActivations: Array<{ event: string; payload: unknown; commandId?: string }>;
};

export function queueCommandForStartingRun(
  runs: readonly StartingCommandRun[],
  commandId: string,
  event: string,
  payload: unknown,
): boolean {
  const starting = runs.find((run) => !run.ready && run.activationCommand === commandId);
  if (!starting) return false;
  starting.pendingActivations.push({ event, payload, commandId });
  return true;
}

export function pluginActivationMatches(plugin: Pick<InstalledPlugin, "enabled" | "activationEvents">, eventName: string): boolean {
  if (!plugin.enabled) return false;
  const emitted = parsePluginActivationEvent(eventName);
  if (!emitted) return false;
  return plugin.activationEvents.some((declaration) => {
    const subscribed = parsePluginActivationEvent(declaration);
    if (!subscribed || subscribed.kind !== emitted.kind) return false;
    if (subscribed.kind === "command" && emitted.kind === "command") return subscribed.command === emitted.command;
    if (subscribed.kind === "language" && emitted.kind === "language") return subscribed.language === emitted.language;
    return subscribed.kind === emitted.kind;
  });
}

function commandContributions(plugin: InstalledPlugin): PluginCommandContribution[] {
  const byId = new Map<string, PluginCommandContribution>();
  for (const contribution of plugin.contributes?.commands ?? []) byId.set(contribution.command, contribution);
  // API 1 plugins installed before command contributions existed still expose
  // their onCommand handlers. Keep those commands available using their ID.
  for (const event of plugin.activationEvents) {
    const parsed = parsePluginActivationEvent(event);
    if (parsed?.kind === "command" && !byId.has(parsed.command)) {
      byId.set(parsed.command, { command: parsed.command, title: parsed.command });
    }
  }
  return [...byId.values()];
}

export function collectCommandPaletteItems(plugins: readonly InstalledPlugin[], builtins = BUILTIN_COMMANDS): CommandPaletteItem[] {
  const pluginCommands = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    return commandContributions(plugin).map((contribution) => ({
      id: `plugin:${plugin.id}:${contribution.command}`,
      title: contribution.title,
      detail: plugin.name,
      source: "plugin" as const,
      pluginId: plugin.id,
      commandId: contribution.command,
    }));
  });
  return [...builtins, ...pluginCommands];
}

export function commandEventName(commandId: string): string {
  return `onCommand:${commandId}`;
}

export function languageEventName(language: string): string {
  return `onLanguage:${language.toLowerCase()}`;
}

export function activationLanguageId(label: string): string {
  const knownIds: Record<string, string> = {
    "Plain Text": "plaintext",
    TypeScript: "typescript",
    TSX: "typescriptreact",
    JSX: "javascriptreact",
    "C++": "cpp",
    "C#": "csharp",
    Shell: "shell",
  };
  return knownIds[label] ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
