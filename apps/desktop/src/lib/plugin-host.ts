// Plugin host controller.
//
// The plugin host libraries below are ~100 KB of source that the shell only
// needs when a plugin is actually installed/enabled or the plugin UI is
// opened. `App.tsx` loads this module through a single dynamic `import()` so
// none of it lands in the entry chunk. Loading is fail-closed: nothing here
// runs until the module is explicitly requested, and authorization state is
// still read from storage before any permission check (see
// `ensureAuthorizationManager` in App.tsx).
export {
  PLUGIN_SANDBOX_FLAGS,
  createPluginSandboxBootstrap,
  createPluginSandboxDocument,
  createPluginWorkerSource,
  createPluginWorkerV2Source,
} from "./plugin-sandbox";
export {
  createPluginApiV2Host,
  PLUGIN_API_V2_MAX_FILE_BYTES,
  PLUGIN_API_V2_MAX_FILE_RANGE_BYTES,
  PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS,
  PLUGIN_API_V2_MAX_TEXT_RANGE_UNITS,
  PluginApiV2OperationError,
} from "./plugin-api-v2";
export { PluginEditorRevisionTracker } from "./plugin-editor-revisions";
export { writeToActivePluginTerminal } from "./plugin-terminal";
export { PluginWorkerMessageGate } from "./plugin-message-policy";
export {
  PLUGIN_AUTHORIZATION_STORAGE_KEY,
  PluginAuthorizationManager,
  loadPluginAuthorizationStore,
  matchesResolvedPluginLspGrant,
  serializePluginAuthorizationStore,
} from "./plugin-authorization";
export { pluginWorkerFailureNotification, pluginWorkerStatusAction } from "./plugin-worker-policy";
export { runPluginUninstallLifecycle } from "./plugin-lifecycle";
export {
  collectCommandPaletteItems,
  commandEventName,
  activationLanguageId,
  languageEventName,
  isPluginEventSubscriptionAllowed,
  isPluginLspEventForRun,
  parsePluginEventSubscriptions,
  pluginActivationMatches,
  queueCommandForStartingRun,
} from "./plugin-activation";

import type { InstalledPlugin } from "../types";
import { errorMessage } from "./core";
import { PLUGIN_SANDBOX_FLAGS, createPluginSandboxDocument, createPluginWorkerSource, createPluginWorkerV2Source } from "./plugin-sandbox";
import { createPluginApiV2Host, type PluginApiV2Dependencies } from "./plugin-api-v2";
import { PluginEditorRevisionTracker } from "./plugin-editor-revisions";
import { PluginWorkerMessageGate } from "./plugin-message-policy";
import { PLUGIN_AUTHORIZATION_STORAGE_KEY, PluginAuthorizationManager, loadPluginAuthorizationStore, serializePluginAuthorizationStore, type PluginAuthorizationChange } from "./plugin-authorization";
import { pluginWorkerFailureNotification, pluginWorkerStatusAction } from "./plugin-worker-policy";
import { parsePluginEventSubscriptions } from "./plugin-activation";

export type PluginRun = {
  pluginId: string;
  pluginVersion: string;
  workspaceRoot: string;
  workspaceGeneration: number;
  frame: HTMLIFrameElement;
  timeout: number;
  generation: number;
  token: string;
  messageHandler: (event: MessageEvent) => void;
  apiVersion: "1" | "2";
  stopApi: () => void;
  send: (message: Record<string, unknown>) => void;
  activationEvent: string;
  activationPayload: unknown;
  activationCommand?: string;
  subscriptions: Set<string>;
  commands: Set<string>;
  pendingActivations: Array<{ event: string; payload: unknown; commandId?: string }>;
  hadSubscriptions: boolean;
  messageGate: PluginWorkerMessageGate;
  ready: boolean;
  disposed: boolean;
};

function createPluginRunToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type PluginHostOptions = {
  pluginsRecovered: () => boolean;
  plugins: () => InstalledPlugin[];
  workspace: () => string;
  workspaceGeneration: () => number;
  isDisposed: () => boolean;
  notify: (message: string) => void;
  readPluginEntry: (root: string, entry: string) => Promise<string>;
  getEditorText: () => string;
  setPluginStatus: (id: string, status: "active" | "inactive" | "failed") => void;
  resolveApiPermission: PluginApiV2Dependencies["resolvePermission"];
  executeApi: (plugin: InstalledPlugin, revisions: PluginEditorRevisionTracker) => PluginApiV2Dependencies["execute"];
  readStorage: (key: string) => string | null;
  writeStorage: (key: string, value: string) => boolean;
  onAuthorizationChange: (change: PluginAuthorizationChange, manager: PluginAuthorizationManager) => void;
};

export function createPluginHostController(options: PluginHostOptions) {
  const { pluginsRecovered, plugins, workspace, notify, readPluginEntry, getEditorText, setPluginStatus, resolveApiPermission, executeApi } = options;
  const getWorkspaceGeneration = options.workspaceGeneration;
  const host = { PLUGIN_SANDBOX_FLAGS, createPluginSandboxDocument, createPluginWorkerSource, createPluginWorkerV2Source, PluginWorkerMessageGate, PluginEditorRevisionTracker, createPluginApiV2Host, parsePluginEventSubscriptions, pluginWorkerFailureNotification, pluginWorkerStatusAction };
  const pluginRuns = new Map<string, Set<PluginRun>>();
  const pluginRunGenerations = new Map<string, number>();
  let disposed = false;
  let manager: PluginAuthorizationManager | undefined;
  let unsubscribe: (() => void) | undefined;
  const authorization = () => {
    manager ??= new PluginAuthorizationManager(
      loadPluginAuthorizationStore(options.readStorage(PLUGIN_AUTHORIZATION_STORAGE_KEY)),
      (store) => options.writeStorage(PLUGIN_AUTHORIZATION_STORAGE_KEY, serializePluginAuthorizationStore(store)),
    );
    if (!disposed && !options.isDisposed() && !unsubscribe) {
      if (workspace()) manager.notifyWorkspaceChanged("", workspace());
      const current = manager;
      unsubscribe = current.subscribe((change) => options.onAuthorizationChange(change, current));
    }
    return manager;
  };
  const disposePluginRun = (run: PluginRun) => {
    if (run.disposed) return;
    run.disposed = true;
    run.messageGate.clear();
    window.clearTimeout(run.timeout);
    window.removeEventListener("message", run.messageHandler);
    run.stopApi();
    try {
      run.frame.contentWindow?.postMessage({ type: "stop", token: run.token }, "*");
    } catch {
      // Removing the opaque-origin frame below still terminates its worker.
    }
    if (run.apiVersion === "2") window.setTimeout(() => run.frame.remove(), 60);
    else run.frame.remove();
  };

  const pluginRunsFor = (pluginId: string) => [...(pluginRuns.get(pluginId) ?? [])];

  const isPluginRunLive = (run: PluginRun) => !run.disposed && (pluginRuns.get(run.pluginId)?.has(run) ?? false);

  const stopPluginRun = (pluginId: string, onlyRun?: PluginRun) => {
    const runs = pluginRuns.get(pluginId);
    if (!runs) return;
    if (onlyRun) {
      runs.delete(onlyRun);
      disposePluginRun(onlyRun);
      if (!runs.size) pluginRuns.delete(pluginId);
      return;
    }
    pluginRuns.delete(pluginId);
    for (const run of runs) disposePluginRun(run);
  };

  const nextPluginRunGeneration = (pluginId: string) => {
    const generation = (pluginRunGenerations.get(pluginId) ?? 0) + 1;
    pluginRunGenerations.set(pluginId, generation);
    return generation;
  };

  const isCurrentPluginRun = (pluginId: string, generation: number) => !disposed && !options.isDisposed() && (pluginRunGenerations.get(pluginId) ?? 0) === generation;

  const invalidateAllPluginRuns = () => {
    const pluginIds = new Set([...pluginRunGenerations.keys(), ...pluginRuns.keys()]);
    for (const pluginId of pluginIds) {
      nextPluginRunGeneration(pluginId);
      stopPluginRun(pluginId);
    }
  };

  const runPlugin = async (plugin: InstalledPlugin, activationEvent: string, activationPayload: unknown, activationCommand?: string) => {
    if (!pluginsRecovered()) {
      notify("Plugin state is still being verified; plugins are temporarily unavailable.");
      return;
    }
    if (!plugin.enabled) return;
    const generation = pluginRunGenerations.get(plugin.id) ?? 0;
    const expectedWorkspaceGeneration = getWorkspaceGeneration();
    const expectedWorkspaceRoot = workspace();
    const isCurrent = () => isCurrentPluginRun(plugin.id, generation)
      && expectedWorkspaceGeneration === getWorkspaceGeneration()
      && expectedWorkspaceRoot === workspace()
      && plugins().some((current) => current.id === plugin.id && current.enabled
        && current.version === plugin.version && current.rootPath === plugin.rootPath);
    const isLive = () => isCurrent() && isPluginRunLive(run);
    setPluginStatus(plugin.id, "active");
    if (!plugin.rootPath) {
      if (isCurrent()) {
        setPluginStatus(plugin.id, "failed");
        notify("Plugin entry path is unavailable.");
      }
      return;
    }
    let pluginSource: string;
    try {
      pluginSource = await readPluginEntry(plugin.rootPath, plugin.entry);
      const current = plugins().find((item) => item.id === plugin.id);
      if (!isCurrent()) return;
      if (!current?.enabled) return;
    } catch (error) {
      if (!isCurrent() || !plugins().some((item) => item.id === plugin.id && item.enabled)) return;
      setPluginStatus(plugin.id, "failed");
      notify(errorMessage(error, "Unable to read plugin entry."));
      return;
    }
    if (!isCurrent()) return;
    const canResolveLegacyPermission = async (permission: "editor.read" | "commands.register" | "ui.notification" | "ui.statusBar") => {
      if (!plugin.permissions.includes(permission)) return false;
      try {
        return await resolveApiPermission(plugin, permission, { workspaceRoot: expectedWorkspaceRoot });
      } catch {
        return false;
      }
    };
    let canReadEditor = plugin.permissions.includes("editor.read");
    let canRegisterCommands = plugin.permissions.includes("commands.register");
    let canNotify = plugin.permissions.includes("ui.notification");
    let canUseStatusBar = plugin.permissions.includes("ui.statusBar");
    if (plugin.apiVersion === "1") {
      [canReadEditor, canRegisterCommands, canNotify, canUseStatusBar] = await Promise.all([
        canResolveLegacyPermission("editor.read"),
        canResolveLegacyPermission("commands.register"),
        canResolveLegacyPermission("ui.notification"),
        canResolveLegacyPermission("ui.statusBar"),
      ]);
      if (!isCurrent()) return;
    }
    const workerSource = plugin.apiVersion === "2"
      ? host.createPluginWorkerV2Source({ pluginSource })
      : host.createPluginWorkerSource({
        pluginSource,
        editorText: canReadEditor ? getEditorText() : "",
        facadeSource: [
          canReadEditor ? "editor: { getText: () => editorText }," : "",
          canRegisterCommands ? "commands: { register: (id, handler) => { commandHandlers.set(id, handler); self.postMessage({ type: \"commands\", commands: [...commandHandlers.keys()] }); } }," : "",
          canNotify || canUseStatusBar ? `ui: { ${canNotify ? "notify: sendStatus," : ""}${canUseStatusBar ? "statusBar: { set: sendStatus }" : ""} },` : "",
        ].join("\n"),
        activationCommand: activationCommand ?? activationEvent,
      });
    const token = createPluginRunToken();
    const messageGate = new host.PluginWorkerMessageGate();
    const editorRevisionTracker = new host.PluginEditorRevisionTracker();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", host.PLUGIN_SANDBOX_FLAGS);
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
    frame.srcdoc = host.createPluginSandboxDocument(token);
    let finished = false;
    let run: PluginRun;
    let apiHost: ReturnType<typeof createPluginApiV2Host> | undefined;
    const runWorkspaceGeneration = getWorkspaceGeneration();
    const runWorkspaceRoot = workspace();
    const sendToSandbox = (message: Record<string, unknown>) => {
      if (run.disposed) return;
      try {
        run.frame.contentWindow?.postMessage({ ...message, token }, "*");
      } catch {
        finishPlugin("failed");
        notify(`${plugin.name}: plugin sandbox is unavailable.`);
      }
    };
    const finishPlugin = (status: "inactive" | "failed") => {
      if (finished) return;
      finished = true;
      apiHost?.stop();
      editorRevisionTracker.clear();
      stopPluginRun(plugin.id, run);
      if (!isCurrent()) return;
      const remaining = pluginRunsFor(plugin.id).length > 0;
      setPluginStatus(plugin.id, remaining ? "active" : status);
    };
    const sendActivation = (eventName: string, payload: unknown, commandId?: string) => {
      if (commandId) sendToSandbox({ type: "command", command: commandId });
      else sendToSandbox({ type: "host-event", event: eventName, payload });
    };
    const handleWorkerMessage = (data: any, source: unknown, messageToken: unknown) => {
      if (data?.type !== "api-request" && !messageGate.allow(data)) {
        finishPlugin("failed");
        notify(`${plugin.name}: plugin exceeded its host message limits.`);
        return;
      }
      if (data?.type === "api-request" && apiHost) {
        void apiHost.handle(data, source, messageToken).then((result) => {
          if (result.accepted && isLive()) sendToSandbox({ type: "api-response", response: result.response });
        });
        return;
      }
      if (data?.type === "subscriptions") {
        const accepted = host.parsePluginEventSubscriptions(plugin, data.events);
        if (accepted === null) {
          finishPlugin("failed");
          notify(`${plugin.name}: attempted to subscribe to an unavailable event.`);
          return;
        }
        run.hadSubscriptions ||= accepted.length > 0;
        run.subscriptions.clear();
        accepted.forEach((event: string) => run.subscriptions.add(event));
        if (run.ready && run.hadSubscriptions && run.subscriptions.size === 0) finishPlugin("inactive");
        return;
      }
      if (data?.type === "commands") {
        if (plugin.apiVersion === "1" && !canRegisterCommands) {
          run.commands.clear();
          return;
        }
        const declared = new Set([
          ...(plugin.contributes?.commands ?? []).map((command) => command.command),
          ...plugin.activationEvents.filter((event) => event.startsWith("onCommand:")).map((event) => event.slice("onCommand:".length)),
        ]);
        run.commands.clear();
        if (Array.isArray(data.commands)) for (const command of data.commands) if (typeof command === "string" && declared.has(command)) run.commands.add(command);
        return;
      }
      if (data?.type === "ready") {
        run.ready = true;
        window.clearTimeout(run.timeout);
        run.timeout = 0;
        sendActivation(activationEvent, activationPayload, activationCommand);
        for (const pending of run.pendingActivations.splice(0)) sendActivation(pending.event, pending.payload, pending.commandId);
        return;
      }
      if (data?.type === "status") {
        const statusAction = host.pluginWorkerStatusAction(plugin.apiVersion, canNotify || canUseStatusBar, data.text);
        if (statusAction.kind === "reject") {
          finishPlugin("failed");
          if (statusAction.notification) notify(`${plugin.name}: ${statusAction.notification}`);
          return;
        }
        notify(`${plugin.name}: ${statusAction.text}`);
        return;
      }
      if (data?.type === "error") {
        notify(host.pluginWorkerFailureNotification(plugin.apiVersion, plugin.name, data.text));
        finishPlugin("failed");
        return;
      }
      if (data?.type === "done") finishPlugin("inactive");
    };
    const messageHandler = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.token !== token) return;
      if (!isLive()) return;
      const message = event.data;
      if (message.type === "frame-ready") {
        sendToSandbox({ type: "start", source: workerSource, apiVersion: plugin.apiVersion === "2" ? 2 : 1 });
        return;
      }
      if (message.type === "sandbox-error") {
        finishPlugin("failed");
        notify(`${plugin.name}: plugin sandbox could not enforce an isolated origin.`);
        return;
      }
      if (message.type === "worker-message") {
        handleWorkerMessage(message.data, event.source, event.data?.token);
        return;
      }
      if (message.type === "worker-start-error") {
        finishPlugin("failed");
        notify(`${plugin.name}: unable to start its isolated worker.`);
        return;
      }
      if (message.type === "worker-error") {
        finishPlugin("failed");
        notify(`${plugin.name}: plugin failed and was isolated from the editor.`);
      }
    };
    run = {
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      workspaceRoot: runWorkspaceRoot,
      workspaceGeneration: runWorkspaceGeneration,
      frame,
      timeout: 0,
      generation,
      token,
      messageHandler,
      apiVersion: plugin.apiVersion,
      stopApi: () => { apiHost?.stop(); editorRevisionTracker.clear(); },
      send: sendToSandbox,
      activationEvent,
      activationPayload,
      activationCommand,
      subscriptions: new Set(),
      commands: new Set(),
      pendingActivations: [],
      hadSubscriptions: false,
      messageGate,
      ready: false,
      disposed: false,
    };
    const runs = pluginRuns.get(plugin.id) ?? new Set<PluginRun>();
    runs.add(run);
    pluginRuns.set(plugin.id, runs);
    if (plugin.apiVersion === "2") {
      apiHost = host.createPluginApiV2Host({
        getContext: () => ({
          source: undefined,
          expectedSource: frame.contentWindow,
          token: undefined,
          expectedToken: token,
          installedPlugin: plugins().find((item) => item.id === plugin.id),
          expectedPlugin: plugin,
          workspaceGeneration: getWorkspaceGeneration(),
          expectedWorkspaceGeneration: runWorkspaceGeneration,
          workspaceRoot: workspace(),
          expectedWorkspaceRoot: runWorkspaceRoot,
        }),
        resolvePermission: resolveApiPermission,
        execute: executeApi(plugin, editorRevisionTracker),
      });
    }
    window.addEventListener("message", messageHandler);
    run.timeout = window.setTimeout(() => {
      if (!isLive()) return;
      finishPlugin("failed");
      notify(`${plugin.name}: activation timed out.`);
    }, 5000);
    frame.onerror = () => {
      if (!isLive()) return;
      finishPlugin("failed");
      notify(`${plugin.name}: plugin sandbox could not be loaded.`);
    };
    document.body.append(frame);
  };

  return {
    authorization,
    runPlugin,
    runsFor: pluginRunsFor,
    isLive: isPluginRunLive,
    stop: stopPluginRun,
    nextGeneration: nextPluginRunGeneration,
    invalidate: invalidateAllPluginRuns,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      invalidateAllPluginRuns();
    },
  };
}
