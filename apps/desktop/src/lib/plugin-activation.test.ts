import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { BUILTIN_COMMANDS, collectCommandPaletteItems, isPluginEventSubscriptionAllowed, isPluginLspEventForRun, languageEventName, parsePluginEventSubscriptions, pluginActivationMatches, queueCommandForStartingRun } from "./plugin-activation";
import type { LspEvent } from "./bridge";

const plugin = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "pude.example",
  name: "Example plugin",
  version: "1.0.0",
  apiVersion: "2",
  entry: "dist/extension.js",
  permissions: ["commands.register"],
  activationEvents: ["onCommand:pude.example.run", "onLanguage:typescript", "onFileOpen", "onFileSave", "onWorkspaceOpen"],
  enabled: true,
  status: "inactive",
  source: "local",
  contributes: { commands: [{ command: "pude.example.run", title: "Example: Run" }] },
  ...overrides,
});

describe("plugin activation events", () => {
  it("routes canonical Windows LSP replies only to the current plugin run and workspace", () => {
    const run = { pluginId: "pude.example", pluginVersion: "1.0.0", apiVersion: "2", workspaceRoot: "C:\\work\\project", workspaceGeneration: 3, disposed: false };
    const event: LspEvent = { type: "message", pluginId: run.pluginId, pluginVersion: run.pluginVersion, workspaceRoot: "\\\\?\\C:\\work\\project", language: "plaintext", serverId: "probe", message: { jsonrpc: "2.0", id: "initialize", result: {} } };
    const workspace = { workspaceRoot: run.workspaceRoot, canonicalWorkspaceRoot: event.workspaceRoot, generation: 3 };
    expect(isPluginLspEventForRun(run, event, workspace)).toBe(true);
    for (const overrides of [{ pluginId: "pude.other" }, { pluginVersion: "2.0.0" }, { workspaceRoot: "\\\\?\\C:\\work\\other" }, { workspaceRoot: "\\\\?\\C:\\work\\project." }, { workspaceRoot: "\\\\?\\C:\\work\\Project" }]) {
      expect(isPluginLspEventForRun(run, { ...event, ...overrides }, workspace)).toBe(false);
    }
    expect(isPluginLspEventForRun(run, event, { ...workspace, generation: 4 })).toBe(false);
    expect(isPluginLspEventForRun(run, event, { ...workspace, workspaceRoot: "C:\\work\\other" })).toBe(false);
    expect(isPluginLspEventForRun({ ...run, disposed: true }, event, workspace)).toBe(false);
    expect(isPluginLspEventForRun({ ...run, apiVersion: "1" }, event, workspace)).toBe(false);
  });
  it("matches only enabled plugins and only the declared event and language", () => {
    const installed = plugin();
    expect(pluginActivationMatches(installed, "onCommand:pude.example.run")).toBe(true);
    expect(pluginActivationMatches(installed, languageEventName("TypeScript"))).toBe(true);
    expect(pluginActivationMatches(installed, "onLanguage:rust")).toBe(false);
    expect(pluginActivationMatches(installed, "onCommand:pude.other.run")).toBe(false);
    expect(pluginActivationMatches(installed, "onFileOpen")).toBe(true);
    expect(pluginActivationMatches(installed, "onFileSave")).toBe(true);
    expect(pluginActivationMatches(installed, "onWorkspaceOpen")).toBe(true);
    expect(pluginActivationMatches({ ...installed, enabled: false }, "onFileOpen")).toBe(false);
  });

  it("lists built-ins and enabled plugin commands without starting plugin workers", () => {
    const enabled = plugin();
    const legacy = plugin({
      id: "pude.legacy",
      name: "Legacy plugin",
      activationEvents: ["onCommand:pude.legacy.run"],
      contributes: undefined,
    });
    const disabled = plugin({ id: "pude.disabled", enabled: false, contributes: { commands: [{ command: "pude.disabled.run", title: "Disabled" }] } });
    const items = collectCommandPaletteItems([enabled, legacy, disabled]);
    expect(items.slice(0, BUILTIN_COMMANDS.length)).toEqual(BUILTIN_COMMANDS);
    expect(items).toContainEqual(expect.objectContaining({ id: "plugin:pude.example:pude.example.run", title: "Example: Run", source: "plugin" }));
    expect(items).toContainEqual(expect.objectContaining({ id: "plugin:pude.legacy:pude.legacy.run", title: "pude.legacy.run", source: "plugin" }));
    expect(items.some((item) => item.pluginId === "pude.disabled")).toBe(false);
  });

  it("allows declared activation subscriptions and gates runtime LSP subscriptions by manifest capability", () => {
    const installed = plugin({
      permissions: ["commands.register", "process.spawn:lsp"],
      lspServers: [{ serverId: "rust-analyzer", language: "rust", executable: "/usr/bin/rust-analyzer", args: [] }],
    });
    expect(isPluginEventSubscriptionAllowed(installed, "onFileOpen")).toBe(true);
    expect(isPluginEventSubscriptionAllowed(installed, "onFileClose")).toBe(false);
    for (const event of ["lsp.message", "lsp.state", "lsp.stderr"]) {
      expect(isPluginEventSubscriptionAllowed(installed, event)).toBe(true);
    }
    expect(isPluginEventSubscriptionAllowed({ ...installed, apiVersion: "1" }, "lsp.message")).toBe(false);
    expect(isPluginEventSubscriptionAllowed({ ...installed, permissions: ["commands.register"] }, "lsp.state")).toBe(false);
    expect(isPluginEventSubscriptionAllowed({ ...installed, lspServers: [] }, "lsp.stderr")).toBe(false);
  });

  it("rejects malformed subscriptions instead of silently dropping entries", () => {
    const installed = plugin();
    expect(parsePluginEventSubscriptions(installed, ["onFileOpen"])).toEqual(["onFileOpen"]);
    expect(parsePluginEventSubscriptions(installed, [])).toEqual([]);
    expect(parsePluginEventSubscriptions(installed, undefined)).toBeNull();
    expect(parsePluginEventSubscriptions(installed, ["onFileOpen", 42])).toBeNull();
    expect(parsePluginEventSubscriptions(installed, ["onFileOpen", "onFileOpen"])).toBeNull();
    expect(parsePluginEventSubscriptions(installed, ["onFileClose"])).toBeNull();
  });

  it("queues every repeated command invocation while its command Worker starts", () => {
    const run = {
      ready: false,
      activationCommand: "pude.example.run",
      pendingActivations: [] as Array<{ event: string; payload: unknown; commandId?: string }>,
    };
    const payload = { command: "pude.example.run" };
    expect(queueCommandForStartingRun([run], "pude.example.run", "onCommand:pude.example.run", payload)).toBe(true);
    expect(queueCommandForStartingRun([run], "pude.example.run", "onCommand:pude.example.run", payload)).toBe(true);
    expect(run.pendingActivations).toEqual([
      { event: "onCommand:pude.example.run", payload, commandId: "pude.example.run" },
      { event: "onCommand:pude.example.run", payload, commandId: "pude.example.run" },
    ]);
    run.ready = true;
    expect(queueCommandForStartingRun([run], "pude.example.run", "onCommand:pude.example.run", payload)).toBe(false);
  });
});
