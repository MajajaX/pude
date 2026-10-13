import {
  MAX_PLUGIN_REQUEST_MESSAGE_BYTES,
  PLUGIN_REQUEST_RATE_LIMIT,
  PLUGIN_REQUEST_RATE_WINDOW_MS,
} from "./plugin-message-policy";

export const PLUGIN_SANDBOX_FLAGS = "allow-scripts";

export type PluginWorkerSourceOptions = {
  pluginSource: string;
  editorText: string;
  facadeSource: string;
  activationCommand: string;
};

export type PluginWorkerV2SourceOptions = {
  pluginSource: string;
};

const workerEventFacade = [
  "const eventHandlers = new Map();",
  "const sendSubscriptions = () => self.postMessage({ type: \"subscriptions\", events: [...eventHandlers.keys()] });",
  "const eventApi = Object.freeze({",
  "on: (eventName, handler) => {",
  "if (typeof eventName !== \"string\" || !eventName || typeof handler !== \"function\") throw new TypeError(\"Event subscription is invalid.\");",
  "const handlers = eventHandlers.get(eventName) ?? new Set();",
  "handlers.add(handler); eventHandlers.set(eventName, handlers); sendSubscriptions();",
  "let active = true;",
  "return () => { if (!active) return; active = false; handlers.delete(handler); if (!handlers.size) eventHandlers.delete(eventName); sendSubscriptions(); };",
  "},",
  "off: (eventName, handler) => { const handlers = eventHandlers.get(eventName); if (!handlers) return; handlers.delete(handler); if (!handlers.size) eventHandlers.delete(eventName); sendSubscriptions(); },",
  "});",
].join("\n");

const workerEventDispatch = [
  "const runHostEvent = async (message) => {",
  "const handlers = [...(eventHandlers.get(message.event) ?? [])];",
  "for (const handler of handlers) await handler(message.payload);",
  "self.postMessage({ type: \"event-done\", event: message.event });",
  "if (eventHandlers.size === 0) self.postMessage({ type: \"done\" });",
  "};",
].join("\n");

/**
 * Build the code that runs in a plugin worker.
 *
 * The worker is created by the opaque-origin sandbox document returned by
 * createPluginSandboxDocument. Keeping the worker source separate from the
 * document means plugin code is transferred over postMessage instead of
 * being interpolated into HTML.
 */
export function createPluginWorkerSource({ pluginSource, editorText, facadeSource, activationCommand }: PluginWorkerSourceOptions): string {
  return [
    `const editorText = ${JSON.stringify(editorText)};`,
    "const commandHandlers = new Map();",
    workerEventFacade,
    "const sendStatus = (text) => self.postMessage({ type: \"status\", text: String(text) });",
    "const pude = {",
    facadeSource,
    "events: eventApi,",
    "};",
    workerEventDispatch,
    "self.pude = pude;",
    "try {",
    pluginSource,
    "self.onmessage = async (event) => {",
    "try {",
    "const message = event.data;",
    "if (message?.type === \"host-event\") { await runHostEvent(message); return; }",
    "if (message?.type === \"command\" || message?.command) {",
    `const commandId = typeof message.command === \"string\" ? message.command : message.command?.command ?? ${JSON.stringify(activationCommand)};`,
    "const handler = commandHandlers.get(commandId);",
    "if (typeof handler === \"function\") await handler(); else sendStatus(\"Activated\");",
    "const eventHandlersForCommand = [...(eventHandlers.get(`onCommand:${commandId}`) ?? [])];",
    "for (const eventHandler of eventHandlersForCommand) await eventHandler({ command: commandId });",
    "self.postMessage({ type: \"command-done\", command: commandId });",
    "if (eventHandlers.size === 0) self.postMessage({ type: \"done\" });",
    "return;",
    "}",
    "} catch (error) {",
    "self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) });",
    "}",
    "};",
    "self.postMessage({ type: \"ready\" });",
    "} catch (error) {",
    "self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) });",
    "}",
  ].join("\n");
}

/** Build an API 2 Worker whose only host connection is the versioned message protocol. */
export function createPluginWorkerV2Source({ pluginSource }: PluginWorkerV2SourceOptions): string {
  return [
    "const commandHandlers = new Map();",
    "const pendingRequests = new Map();",
    workerEventFacade,
    "const pendingCommandRegistrations = new Set();",
    "let requestSequence = 0;",
    "const request = (method, params) => new Promise((resolve, reject) => {",
    "const requestId = `pude_${++requestSequence}`;",
    "pendingRequests.set(requestId, { resolve, reject });",
    "self.postMessage({ type: \"api-request\", protocolVersion: 2, requestId, method, params });",
    "});",
    "const rejectPendingRequests = () => {",
    "for (const pending of pendingRequests.values()) pending.reject(new Error(\"Plugin stopped.\"));",
    "pendingRequests.clear();",
    "};",
    "const registeredCommands = new Set();",
  "const sendCommands = () => self.postMessage({ type: \"commands\", commands: [...registeredCommands] });",
  "const pude = Object.freeze({",
    "editor: Object.freeze({",
    "getText: () => request(\"editor.getText\", {}),",
    "getTextRange: (revision, from, to) => request(\"editor.getTextRange\", { revision, from, to }),",
    "getSelection: () => request(\"editor.getSelection\", {}),",
    "getCursor: () => request(\"editor.getCursor\", {}),",
    "getFileInfo: () => request(\"editor.getFileInfo\", {}),",
    "applyEdits: (revision, edits) => request(\"editor.applyEdits\", { revision, edits }),",
    "}),",
    "workspace: Object.freeze({",
    "list: (options = {}) => request(\"workspace.list\", options),",
    "readFile: (options) => request(\"workspace.readFile\", options),",
    "getFileInfo: (options) => request(\"workspace.getFileInfo\", options),",
    "readFileRange: (options) => request(\"workspace.readFileRange\", options),",
    "releaseFileRead: (options) => request(\"workspace.releaseFileRead\", options),",
    "writeFile: (options) => request(\"workspace.writeFile\", options),",
    "}),",
    "commands: Object.freeze({ register: (id, handler) => {",
    "if (typeof handler !== \"function\") return Promise.reject(new TypeError(\"Command handler must be a function.\"));",
    "commandHandlers.set(id, handler);",
    "const registration = request(\"commands.register\", { id }).then((result) => { registeredCommands.add(id); sendCommands(); return result; });",
    "pendingCommandRegistrations.add(registration);",
    "registration.then(() => pendingCommandRegistrations.delete(registration), () => pendingCommandRegistrations.delete(registration));",
    "void registration.catch(() => undefined);",
    "return registration;",
    "} }),",
    "events: eventApi,",
    "ui: Object.freeze({",
    "notify: (message) => request(\"ui.notify\", { message }),",
    "statusBar: Object.freeze({",
    "set: (id, text, tooltip) => request(\"ui.statusBar.set\", tooltip === undefined ? { id, text } : { id, text, tooltip }),",
    "remove: (id) => request(\"ui.statusBar.remove\", { id }),",
    "}),",
    "quickPick: (options) => request(\"ui.quickPick\", options),",
    "}),",
    "git: Object.freeze({",
    "getStatus: () => request(\"git.getStatus\", {}),",
    "getDiff: (options) => request(\"git.getDiff\", options),",
    "}),",
    "terminal: Object.freeze({ write: (options) => request(\"terminal.write\", options) }),",
    "network: Object.freeze({ fetch: (options) => request(\"network.fetch\", options) }),",
    "lsp: Object.freeze({",
    "start: (serverId) => request(\"lsp.start\", { serverId }),",
    "send: (serverId, message) => request(\"lsp.send\", { serverId, message }),",
    "cancel: (serverId, requestId) => request(\"lsp.cancel\", { serverId, requestId }),",
    "stop: (serverId) => request(\"lsp.stop\", { serverId }),",
    "}),",
    "});",
    workerEventDispatch,
    "self.pude = pude;",
    "try {",
    pluginSource,
    "self.onmessage = async (event) => {",
    "const message = event.data;",
    "if (message?.type === \"api-stop\" && message.protocolVersion === 2) {",
    "rejectPendingRequests();",
    "self.postMessage({ type: \"api-stopped\", protocolVersion: 2 });",
    "self.close?.();",
    "return;",
    "}",
    "if (message?.type === \"api-response\" && message.protocolVersion === 2) {",
    "const pending = pendingRequests.get(message.requestId);",
    "if (!pending) return;",
    "pendingRequests.delete(message.requestId);",
    "if (message.ok === true) pending.resolve(message.result);",
    "else { const error = new Error(message.error?.message || \"Plugin API request failed.\"); error.code = message.error?.code || \"host.operation_failed\"; error.retryable = message.error?.retryable === true; pending.reject(error); }",
    "return;",
    "}",
    "if (message?.type === \"host-event\") {",
    "try { await runHostEvent(message); } catch (error) { self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) }); }",
    "return;",
    "}",
    "if (message?.type !== \"command\") return;",
    "try {",
    "const commandId = typeof message.command === \"string\" ? message.command : message.command?.command;",
    "const handler = commandHandlers.get(commandId);",
    "if (typeof handler === \"function\") await handler();",
    "for (const eventHandler of [...(eventHandlers.get(`onCommand:${commandId}`) ?? [])]) await eventHandler({ command: commandId });",
    "self.postMessage({ type: \"command-done\", command: commandId });",
    "if (eventHandlers.size === 0) self.postMessage({ type: \"done\" });",
    "} catch (error) {",
    "self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) });",
    "}",
    "};",
    "Promise.all([...pendingCommandRegistrations]).then(() => self.postMessage({ type: \"ready\" })).catch((error) => self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) }));",
    "} catch (error) {",
    "self.postMessage({ type: \"error\", text: error instanceof Error ? error.message : String(error) });",
    "}",
  ].join("\n");
}

/**
 * The sandbox deliberately omits allow-same-origin. Its document and the
 * worker it creates therefore have an opaque origin and cannot open the
 * editor's IndexedDB or local/session storage. The only bridge back to the
 * host is the narrow postMessage protocol handled by App.tsx.
 */
export function createPluginSandboxBootstrap(): string {
  return `
const token = document.currentScript.dataset.token;
const maxForwardBytes = ${MAX_PLUGIN_REQUEST_MESSAGE_BYTES};
const maxForwardNodes = 4096;
const maxForwardDepth = 32;
const forwardRateLimit = ${PLUGIN_REQUEST_RATE_LIMIT};
const forwardRateWindowMs = ${PLUGIN_REQUEST_RATE_WINDOW_MS};
const forwardEncoder = new TextEncoder();
const forwardedAt = [];
let workerPolicyFailed = false;
let worker;
let workerUrl;
let workerApiVersion = 1;
let stopTimer;
const terminateWorker = () => {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = undefined;
  worker?.terminate();
  worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
};
const send = (message) => {
  try { parent.postMessage({ ...message, token }, "*"); } catch (_) {}
};
const isBoundedWorkerMessage = (value) => {
  const pending = [{ value, depth: 0 }];
  const visited = new WeakSet();
  let bytes = 0;
  let nodes = 0;
  const addBytes = (amount) => {
    bytes += amount;
    return bytes <= maxForwardBytes;
  };
  while (pending.length > 0) {
    const item = pending.pop();
    nodes += 1;
    if (nodes > maxForwardNodes || item.depth > maxForwardDepth) return false;
    const current = item.value;
    if (current === null) {
      if (!addBytes(4)) return false;
    } else if (typeof current === "string") {
      if (current.length > maxForwardBytes) return false;
      if (!addBytes(forwardEncoder.encode(current).byteLength + 2)) return false;
    } else if (typeof current === "boolean") {
      if (!addBytes(current ? 4 : 5)) return false;
    } else if (typeof current === "number") {
      if (!Number.isFinite(current) || !addBytes(String(current).length)) return false;
    } else if (Array.isArray(current)) {
      if (visited.has(current) || current.length > maxForwardNodes) return false;
      visited.add(current);
      if (!addBytes(2 + Math.max(0, current.length - 1))) return false;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(current, String(index)); } catch (_) { return false; }
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else if (typeof current === "object") {
      if (visited.has(current)) return false;
      let prototype;
      let keys;
      try {
        prototype = Object.getPrototypeOf(current);
        keys = Object.keys(current);
      } catch (_) { return false; }
      if (prototype !== Object.prototype && prototype !== null) return false;
      visited.add(current);
      if (keys.length > maxForwardNodes - nodes) return false;
      if (!addBytes(2 + Math.max(0, keys.length - 1))) return false;
      for (const key of keys) {
        if (key.length > maxForwardBytes || !addBytes(forwardEncoder.encode(key).byteLength + 3)) return false;
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch (_) { return false; }
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else {
      return false;
    }
  }
  return bytes <= maxForwardBytes;
};
const failWorkerPolicy = () => {
  if (workerPolicyFailed) return;
  workerPolicyFailed = true;
  terminateWorker();
  send({ type: "worker-error", text: "Plugin worker exceeded message size or rate limits." });
};
const sendWorkerMessage = (data) => {
  if (workerPolicyFailed) return;
  const now = performance.now();
  if (!Number.isFinite(now)) { failWorkerPolicy(); return; }
  while (forwardedAt.length > 0 && forwardedAt[0] <= now - forwardRateWindowMs) forwardedAt.shift();
  if (forwardedAt.length >= forwardRateLimit || !isBoundedWorkerMessage(data)) {
    failWorkerPolicy();
    return;
  }
  forwardedAt.push(now);
  send({ type: "worker-message", data });
};
const stop = () => {
  if (!worker) { terminateWorker(); return; }
  if (workerApiVersion === 2) {
    try { worker.postMessage({ type: "api-stop", protocolVersion: 2 }); } catch (_) { terminateWorker(); return; }
    stopTimer = setTimeout(terminateWorker, 50);
    return;
  }
  terminateWorker();
};
window.addEventListener("pagehide", stop);
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.token !== token) return;
  const message = event.data;
  if (message.type === "stop") { stop(); return; }
  if (message.type === "command") { worker?.postMessage(message); return; }
  if (message.type === "host-event") { worker?.postMessage(message); return; }
  if (message.type === "api-response" && message.response?.protocolVersion === 2) { worker?.postMessage(message.response); return; }
  if (message.type !== "start" || worker) return;
  try {
    workerApiVersion = message.apiVersion === 2 ? 2 : 1;
    forwardedAt.length = 0;
    workerPolicyFailed = false;
    workerUrl = URL.createObjectURL(new Blob([message.source], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    worker.onmessage = (workerEvent) => {
      if (workerEvent.data?.type === "api-stopped" && workerEvent.data.protocolVersion === 2) { terminateWorker(); return; }
      sendWorkerMessage(workerEvent.data);
    };
    worker.onerror = (workerEvent) => {
      sendWorkerMessage({ type: "worker-error", text: workerEvent.message || "Plugin worker failed." });
      stop();
    };
    worker.onmessageerror = () => {
      sendWorkerMessage({ type: "worker-error", text: "Plugin worker message could not be cloned." });
      stop();
    };
  } catch (error) {
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = undefined;
    send({ type: "worker-start-error", text: error instanceof Error ? error.message : String(error) });
  }
});
if (location.origin === "null") send({ type: "frame-ready" });
else send({ type: "sandbox-error", text: "Plugin sandbox did not receive an opaque origin." });
`;
}

/** Only this fixed bootstrap may execute inline; plugin source travels over postMessage. */
export const PLUGIN_SANDBOX_BOOTSTRAP_HASH = "sha256-zyyvc4zXOoI6dJqHZsv+hBoU2GyuCSJJyEPu/BK1OnM=";

/** This second policy intersects with the parent CSP and removes host IPC access. */
export const PLUGIN_SANDBOX_CSP = `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; script-src blob: '${PLUGIN_SANDBOX_BOOTSTRAP_HASH}'; worker-src blob:; connect-src 'none'`;

export function createPluginSandboxDocument(token: string): string {
  const safeToken = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PLUGIN_SANDBOX_CSP}">
<script data-token="${safeToken}">${createPluginSandboxBootstrap()}</script>`;
}
