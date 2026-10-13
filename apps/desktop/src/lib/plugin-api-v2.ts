import type { PluginLspServer, PluginManifest, PluginPermission } from "../types";
import {
  MAX_PLUGIN_REQUEST_MESSAGE_BYTES,
  MAX_PLUGIN_RESPONSE_MESSAGE_BYTES,
  MAX_PLUGIN_API_V2_FILE_RANGE_BYTES,
  MAX_PLUGIN_API_V2_IN_FLIGHT_REQUESTS,
  MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS,
  PLUGIN_EXECUTION_TIMEOUT_MS,
  PluginMessageRateLimiter,
  isPluginMessageWithinLimit,
} from "./plugin-message-policy";

export const PLUGIN_API_V2_PROTOCOL_VERSION = 2 as const;
export const PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS = MAX_PLUGIN_API_V2_IN_FLIGHT_REQUESTS;
export const PLUGIN_API_V2_MAX_TEXT_RANGE_UNITS = MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS;
export const PLUGIN_API_V2_MAX_FILE_RANGE_BYTES = MAX_PLUGIN_API_V2_FILE_RANGE_BYTES;
export const PLUGIN_API_V2_MAX_FILE_BYTES = 20 * 1024 * 1024;

export type PluginApiV2Method =
  | "editor.getText"
  | "editor.getTextRange"
  | "editor.getSelection"
  | "editor.getCursor"
  | "editor.getFileInfo"
  | "editor.applyEdits"
  | "workspace.list"
  | "workspace.readFile"
  | "workspace.getFileInfo"
  | "workspace.readFileRange"
  | "workspace.releaseFileRead"
  | "workspace.writeFile"
  | "commands.register"
  | "ui.notify"
  | "ui.statusBar.set"
  | "ui.statusBar.remove"
  | "ui.quickPick"
  | "git.getStatus"
  | "git.getDiff"
  | "terminal.write"
  | "network.fetch"
  | "lsp.start"
  | "lsp.send"
  | "lsp.cancel"
  | "lsp.stop";

export type PluginApiV2Permission = PluginPermission;

export type PluginApiV2ResourceScope =
  | { kind: "domain"; value: string }
  | { kind: "executable"; serverId: string; language: string; executablePath: string; args: string[] };

export type PluginApiV2PermissionScope = {
  workspaceRoot: string;
  resourceScope?: PluginApiV2ResourceScope;
};

export type PluginApiV2ExecutionContext = {
  signal: AbortSignal;
  /** Unique host-generated key for native work that supports explicit cancellation. */
  nativeRequestId: string;
  plugin: PluginApiV2InstalledPlugin;
  workspaceRoot: string;
  /** Recheck workspace, installation, declaration, and authorization immediately before a write. */
  authorize: () => Promise<void>;
};

export type PluginApiV2Request = {
  type: "api-request";
  protocolVersion: typeof PLUGIN_API_V2_PROTOCOL_VERSION;
  requestId: string;
  method: PluginApiV2Method;
  params: Record<string, unknown>;
};

export type PluginApiV2Error = {
  code: string;
  message: string;
  retryable: boolean;
};

export type PluginApiV2Response = {
  type: "api-response";
  protocolVersion: typeof PLUGIN_API_V2_PROTOCOL_VERSION;
  requestId: string | null;
  ok: boolean;
  result?: unknown;
  error?: PluginApiV2Error;
};

export type PluginApiV2InstalledPlugin = PluginManifest & {
  enabled: boolean;
  rootPath?: string;
};

export type PluginApiV2Context = {
  source: unknown;
  expectedSource: unknown;
  token: unknown;
  expectedToken: string;
  installedPlugin: PluginApiV2InstalledPlugin | undefined;
  expectedPlugin: PluginApiV2InstalledPlugin;
  workspaceGeneration: number;
  expectedWorkspaceGeneration: number;
  workspaceRoot: string;
  expectedWorkspaceRoot: string;
};

export type PluginApiV2Dependencies = {
  getContext: () => PluginApiV2Context;
  resolvePermission: (
    plugin: PluginApiV2InstalledPlugin,
    permission: PluginApiV2Permission,
    scope: PluginApiV2PermissionScope,
  ) => boolean | Promise<boolean>;
  execute: (
    method: PluginApiV2Method,
    params: Record<string, unknown>,
    context: PluginApiV2ExecutionContext,
  ) => unknown | Promise<unknown>;
  /** Optional clock for deterministic rolling-rate-limit tests. */
  now?: () => number;
};

export type PluginApiV2HandleResult =
  | { accepted: false }
  | { accepted: true; response: PluginApiV2Response };

export const PLUGIN_API_V2_PERMISSION_BY_METHOD: Record<PluginApiV2Method, PluginApiV2Permission> = {
  "editor.getText": "editor.read",
  "editor.getTextRange": "editor.read",
  "editor.getSelection": "editor.read",
  "editor.getCursor": "editor.read",
  "editor.getFileInfo": "editor.read",
  "editor.applyEdits": "editor.write",
  "workspace.list": "workspace.read",
  "workspace.readFile": "workspace.read",
  "workspace.getFileInfo": "workspace.read",
  "workspace.readFileRange": "workspace.read",
  "workspace.releaseFileRead": "workspace.read",
  "workspace.writeFile": "workspace.write",
  "commands.register": "commands.register",
  "ui.notify": "ui.notification",
  "ui.statusBar.set": "ui.statusBar",
  "ui.statusBar.remove": "ui.statusBar",
  "ui.quickPick": "ui.quickPick",
  "git.getStatus": "git.read",
  "git.getDiff": "git.read",
  "terminal.write": "terminal.write",
  "network.fetch": "network",
  "lsp.start": "process.spawn:lsp",
  "lsp.send": "process.spawn:lsp",
  "lsp.cancel": "process.spawn:lsp",
  "lsp.stop": "process.spawn:lsp",
};

const MAX_EDITOR_EDITS = 1_000;
const MAX_QUICK_PICK_ITEMS = 100;
const MAX_NETWORK_BODY_LENGTH = 256 * 1024;
const FORBIDDEN_NETWORK_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const errorResponse = (requestId: string | null, code: string, message: string, retryable = false): PluginApiV2Response => ({
  type: "api-response",
  protocolVersion: PLUGIN_API_V2_PROTOCOL_VERSION,
  requestId,
  ok: false,
  error: { code, message, retryable },
});

const successResponse = (requestId: string, result: unknown): PluginApiV2Response => ({
  type: "api-response",
  protocolVersion: PLUGIN_API_V2_PROTOCOL_VERSION,
  requestId,
  ok: true,
  result: result === undefined ? null : result,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function permissionForMethod(method: string): PluginApiV2Permission | undefined {
  return Object.prototype.hasOwnProperty.call(PLUGIN_API_V2_PERMISSION_BY_METHOD, method)
    ? PLUGIN_API_V2_PERMISSION_BY_METHOD[method as PluginApiV2Method]
    : undefined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedString(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function areEditorEditsValid(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_EDITOR_EDITS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const edit = value[index];
    if (!isRecord(edit)
        || !hasExactKeys(edit, ["from", "to", "insert"])
        || !isNonNegativeSafeInteger(edit.from)
        || !isNonNegativeSafeInteger(edit.to)
        || edit.from > edit.to
        || !isBoundedString(edit.insert, PLUGIN_API_V2_MAX_FILE_BYTES)) return false;
    if (index > 0) {
      const previous = value[index - 1];
      if (!isRecord(previous) || !isNonNegativeSafeInteger(previous.to) || previous.to > edit.from) return false;
    }
  }
  return true;
}

function isRelativeWorkspacePath(value: unknown): value is string {
  if (!isBoundedString(value, 4096, 1) || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value) || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment !== ".." && segment !== "");
}

function isNetworkDomainDeclared(plugin: PluginApiV2InstalledPlugin, hostname: string): boolean {
  const domains = (plugin as PluginApiV2InstalledPlugin & { networkDomains?: unknown }).networkDomains;
  if (!Array.isArray(domains)) return false;
  return domains.some((domain) => typeof domain === "string" && hostname === domain.toLowerCase());
}

function isCommandDeclared(plugin: PluginApiV2InstalledPlugin, id: string): boolean {
  const contributes = (plugin as PluginApiV2InstalledPlugin & { contributes?: unknown }).contributes;
  if (!isRecord(contributes) || !Array.isArray(contributes.commands)) return false;
  return contributes.commands.some((command) => isRecord(command) && command.command === id);
}

function validHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function isLspRequestId(value: unknown): boolean {
  return (typeof value === "string" && value.length > 0 && value.length <= 128)
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (Object.prototype.hasOwnProperty.call(value, "method")) {
    return isBoundedString(value.method, 256, 1)
      && !Object.prototype.hasOwnProperty.call(value, "result")
      && !Object.prototype.hasOwnProperty.call(value, "error");
  }
  return Object.prototype.hasOwnProperty.call(value, "id")
    && isLspRequestId(value.id)
    && (Object.prototype.hasOwnProperty.call(value, "result") || isRecord(value.error));
}

function findDeclaredLspServer(
  plugin: PluginApiV2InstalledPlugin,
  serverId: string,
): PluginLspServer | undefined {
  const matches = (plugin.lspServers ?? []).filter((server) => server.serverId === serverId);
  return matches.length === 1 ? matches[0] : undefined;
}

function validateParams(method: PluginApiV2Method, value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  switch (method) {
    case "editor.getText":
    case "editor.getSelection":
    case "editor.getCursor":
    case "editor.getFileInfo":
    case "git.getStatus":
      return hasExactKeys(value, []) ? value : undefined;
    case "editor.getTextRange":
      return hasExactKeys(value, ["revision", "from", "to"])
        && isNonNegativeSafeInteger(value.revision)
        && isNonNegativeSafeInteger(value.from)
        && isNonNegativeSafeInteger(value.to)
        && value.from <= value.to
        && value.to - value.from <= PLUGIN_API_V2_MAX_TEXT_RANGE_UNITS
        ? value
        : undefined;
    case "editor.applyEdits":
      return hasExactKeys(value, ["revision", "edits"])
        && isNonNegativeSafeInteger(value.revision)
        && areEditorEditsValid(value.edits)
        ? value
        : undefined;
    case "workspace.list":
      return (hasExactKeys(value, []) || hasExactKeys(value, ["path"]))
        && (value.path === undefined || isRelativeWorkspacePath(value.path))
        ? value
        : undefined;
    case "workspace.readFile":
      return hasExactKeys(value, ["path"]) && isRelativeWorkspacePath(value.path) ? value : undefined;
    case "workspace.getFileInfo":
      return hasExactKeys(value, ["path"]) && isRelativeWorkspacePath(value.path) ? value : undefined;
    case "workspace.releaseFileRead":
      return hasExactKeys(value, ["path", "revision"])
        && isRelativeWorkspacePath(value.path)
        && isBoundedString(value.revision, 512, 1)
        ? value
        : undefined;
    case "workspace.readFileRange":
      return hasExactKeys(value, ["path", "revision", "offsetBytes", "maxBytes"])
        && isRelativeWorkspacePath(value.path)
        && isBoundedString(value.revision, 512, 1)
        && isNonNegativeSafeInteger(value.offsetBytes)
        && Number.isSafeInteger(value.maxBytes)
        && (value.maxBytes as number) >= 1
        && (value.maxBytes as number) <= PLUGIN_API_V2_MAX_FILE_RANGE_BYTES
        ? value
        : undefined;
    case "workspace.writeFile":
      return (hasExactKeys(value, ["path", "content"]) || hasExactKeys(value, ["path", "content", "expectedFingerprint"]))
        && isRelativeWorkspacePath(value.path)
        && isBoundedString(value.content, PLUGIN_API_V2_MAX_FILE_BYTES)
        && (value.expectedFingerprint === undefined || (typeof value.expectedFingerprint === "string" && /^[a-fA-F0-9]{16,128}$/.test(value.expectedFingerprint)))
        ? value
        : undefined;
    case "commands.register":
      return hasExactKeys(value, ["id"])
        && typeof value.id === "string"
        && value.id.length <= 128
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id)
        ? value
        : undefined;
    case "ui.notify":
      return hasExactKeys(value, ["message"])
        && typeof value.message === "string"
        && value.message.length > 0
        && value.message.length <= 500
        ? value
        : undefined;
    case "ui.statusBar.set":
      return (hasExactKeys(value, ["id", "text"]) || hasExactKeys(value, ["id", "text", "tooltip"]))
        && typeof value.id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)
        && isBoundedString(value.text, 120, 1)
        && (value.tooltip === undefined || isBoundedString(value.tooltip, 256))
        ? value
        : undefined;
    case "ui.statusBar.remove":
      return hasExactKeys(value, ["id"])
        && typeof value.id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)
        ? value
        : undefined;
    case "ui.quickPick":
      return (hasExactKeys(value, ["items"]) || hasExactKeys(value, ["items", "placeholder"]))
        && Array.isArray(value.items)
        && value.items.length > 0
        && value.items.length <= MAX_QUICK_PICK_ITEMS
        && value.items.every((item) => isRecord(item)
          && (hasExactKeys(item, ["id", "label"]) || hasExactKeys(item, ["id", "label", "description"]))
          && isBoundedString(item.id, 128, 1)
          && isBoundedString(item.label, 256, 1)
          && (item.description === undefined || isBoundedString(item.description, 512)))
        && (value.placeholder === undefined || isBoundedString(value.placeholder, 256))
        ? value
        : undefined;
    case "git.getDiff":
      return (hasExactKeys(value, ["path"]) || hasExactKeys(value, ["path", "staged"]))
        && isRelativeWorkspacePath(value.path)
        && (value.staged === undefined || typeof value.staged === "boolean")
        ? value
        : undefined;
    case "terminal.write":
      return (hasExactKeys(value, ["data"]) || hasExactKeys(value, ["data", "binary"]))
        && isBoundedString(value.data, 64 * 1024, 1)
        && (value.binary === undefined || typeof value.binary === "boolean")
        ? value
        : undefined;
    case "network.fetch": {
      const allowedKeys = ["url", "method", "headers", "body"];
      if (Object.keys(value).some((key) => !allowedKeys.includes(key)) || !Object.prototype.hasOwnProperty.call(value, "url")) return undefined;
      if (!isBoundedString(value.url, 8192, 1)) return undefined;
      if (value.method !== undefined && (typeof value.method !== "string" || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(value.method))) return undefined;
      if (value.body !== undefined && !isBoundedString(value.body, MAX_NETWORK_BODY_LENGTH)) return undefined;
      if (value.headers !== undefined) {
        if (!isRecord(value.headers) || Object.keys(value.headers).length > 32) return undefined;
        for (const [name, headerValue] of Object.entries(value.headers)) {
          if (!validHeaderName(name) || FORBIDDEN_NETWORK_HEADERS.has(name.toLowerCase()) || !isBoundedString(headerValue, 4096)) return undefined;
        }
      }
      return value;
    }
    case "lsp.start":
    case "lsp.stop":
      return hasExactKeys(value, ["serverId"])
        && isBoundedString(value.serverId, 128, 1)
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.serverId)
        ? value
        : undefined;
    case "lsp.send":
      return hasExactKeys(value, ["serverId", "message"])
        && isBoundedString(value.serverId, 128, 1)
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.serverId)
        && isJsonRpcMessage(value.message)
        ? value
        : undefined;
    case "lsp.cancel":
      return hasExactKeys(value, ["serverId", "requestId"])
        && isBoundedString(value.serverId, 128, 1)
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.serverId)
        && isLspRequestId(value.requestId)
        ? value
        : undefined;
  }
}

export function permissionScopeForRequest(
  plugin: PluginApiV2InstalledPlugin,
  method: PluginApiV2Method,
  params: Record<string, unknown>,
  workspaceRoot: string,
): PluginApiV2PermissionScope | PluginApiV2Error {
  if (method.startsWith("lsp.")) {
    const server = findDeclaredLspServer(plugin, params.serverId as string);
    if (!server) {
      return { code: "manifest.lsp_not_declared", message: "Language server is not declared by this plugin manifest.", retryable: false };
    }
    if (!isBoundedString(server.executable, 4096, 1)
        || !(server.executable.startsWith("/") || /^[A-Za-z]:[\\/]/.test(server.executable) || server.executable.startsWith("\\\\"))
        || !Array.isArray(server.args)
        || server.args.length > 128
        || server.args.some((argument) => !isBoundedString(argument, 8192) || argument.includes("\0"))) {
      return { code: "manifest.lsp_invalid", message: "Language server declaration is invalid.", retryable: false };
    }
    return {
      workspaceRoot,
      resourceScope: {
        kind: "executable",
        serverId: server.serverId,
        language: server.language,
        executablePath: server.executable,
        args: [...server.args],
      },
    };
  }
  if (method !== "network.fetch") return { workspaceRoot };
  try {
    const url = new URL(params.url as string);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
      return { code: "network.invalid_url", message: "Network requests must use an HTTPS URL without credentials.", retryable: false };
    }
    const hostname = url.hostname.toLowerCase();
    if (!isNetworkDomainDeclared(plugin, hostname)) {
      return { code: "permission.domain_not_declared", message: "Network request host is not declared by this plugin.", retryable: false };
    }
    return { workspaceRoot, resourceScope: { kind: "domain", value: hostname } };
  } catch {
    return { code: "network.invalid_url", message: "Network request URL is invalid.", retryable: false };
  }
}

function validateEnvelope(value: unknown): { requestId: string | null; request?: PluginApiV2Request; error?: PluginApiV2Response } {
  if (!isRecord(value)) {
    return { requestId: null, error: errorResponse(null, "protocol.invalid_request", "Plugin API request must be an object.") };
  }
  const requestId = isValidRequestId(value.requestId) ? value.requestId : null;
  if (requestId === null) {
    return { requestId, error: errorResponse(null, "protocol.invalid_request_id", "Plugin API request ID is invalid.") };
  }
  if (!hasExactKeys(value, ["type", "protocolVersion", "requestId", "method", "params"]) || value.type !== "api-request") {
    return { requestId, error: errorResponse(requestId, "protocol.invalid_request", "Plugin API request has an invalid shape.") };
  }
  if (value.protocolVersion !== PLUGIN_API_V2_PROTOCOL_VERSION) {
    return { requestId, error: errorResponse(requestId, "protocol.unsupported_version", "Plugin API protocol version is unsupported.") };
  }
  if (typeof value.method !== "string") {
    return { requestId, error: errorResponse(requestId, "protocol.invalid_request", "Plugin API method must be a string.") };
  }
  const permission = permissionForMethod(value.method);
  if (!permission) {
    return { requestId, error: errorResponse(requestId, "api.method_not_found", "Plugin API method is not available.") };
  }
  const params = validateParams(value.method as PluginApiV2Method, value.params);
  if (!params) {
    return { requestId, error: errorResponse(requestId, "protocol.invalid_params", "Plugin API method parameters are invalid.") };
  }
  return {
    requestId,
    request: {
      type: "api-request",
      protocolVersion: PLUGIN_API_V2_PROTOCOL_VERSION,
      requestId,
      method: value.method as PluginApiV2Method,
      params,
    },
  };
}

function sameManifest(left: PluginApiV2InstalledPlugin, right: PluginApiV2InstalledPlugin): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.version === right.version
    && left.apiVersion === right.apiVersion
    && left.entry === right.entry
    && left.rootPath === right.rootPath
    && JSON.stringify(left.permissions) === JSON.stringify(right.permissions)
    && JSON.stringify(left.activationEvents) === JSON.stringify(right.activationEvents)
    && JSON.stringify((left as PluginApiV2InstalledPlugin & { contributes?: unknown }).contributes)
      === JSON.stringify((right as PluginApiV2InstalledPlugin & { contributes?: unknown }).contributes)
    && JSON.stringify((left as PluginApiV2InstalledPlugin & { networkDomains?: unknown }).networkDomains)
      === JSON.stringify((right as PluginApiV2InstalledPlugin & { networkDomains?: unknown }).networkDomains)
    && JSON.stringify((left as PluginApiV2InstalledPlugin & { lspServers?: unknown }).lspServers)
      === JSON.stringify((right as PluginApiV2InstalledPlugin & { lspServers?: unknown }).lspServers);
}

export class PluginApiV2OperationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

function permissionFailure(permission: PluginApiV2Permission, granted: boolean): PluginApiV2OperationError {
  return granted
    ? new PluginApiV2OperationError("permission.not_declared", `Plugin has not declared ${permission}.`)
    : new PluginApiV2OperationError("permission.denied", `Permission ${permission} has not been approved.`);
}

function errorForPermissionScope(value: PluginApiV2PermissionScope | PluginApiV2Error): PluginApiV2Error | undefined {
  return "code" in value ? value : undefined;
}

function validateContext(context: PluginApiV2Context): PluginApiV2Error | undefined {
  if (context.source !== context.expectedSource || context.token !== context.expectedToken) {
    return { code: "security.invalid_source", message: "Plugin API source or token is invalid.", retryable: false };
  }
  const installed = context.installedPlugin;
  if (!installed || installed.id !== context.expectedPlugin.id || !sameManifest(installed, context.expectedPlugin)) {
    return { code: "plugin.not_installed", message: "Plugin installation changed during this request.", retryable: false };
  }
  if (!installed.enabled) {
    return { code: "plugin.disabled", message: "Plugin is disabled.", retryable: false };
  }
  if (installed.apiVersion !== "2") {
    return { code: "plugin.manifest_changed", message: "Installed plugin API version changed.", retryable: false };
  }
  if (!Number.isSafeInteger(context.workspaceGeneration)
      || context.workspaceGeneration !== context.expectedWorkspaceGeneration
      || context.workspaceRoot !== context.expectedWorkspaceRoot) {
    return { code: "workspace.context_changed", message: "Workspace changed during this plugin request.", retryable: false };
  }
  return undefined;
}

export function createPluginApiV2Host(dependencies: PluginApiV2Dependencies) {
  const pendingRequestIds = new Set<string>();
  const pendingControllers = new Map<string, AbortController>();
  const rateLimiter = new PluginMessageRateLimiter();
  let nativeRequestSequence = 0;
  let stopped = false;

  return {
    async handle(rawRequest: unknown, source: unknown, token: unknown): Promise<PluginApiV2HandleResult> {
      if (stopped) return { accepted: false };

      const context = dependencies.getContext();
      const initialContextError = validateContext({ ...context, source, token });
      if (initialContextError?.code === "security.invalid_source") return { accepted: false };

      if (!isPluginMessageWithinLimit(rawRequest, MAX_PLUGIN_REQUEST_MESSAGE_BYTES)) {
        return { accepted: true, response: errorResponse(null, "protocol.message_too_large", "Plugin API request exceeds the message size or structure limit.") };
      }

      const envelope = validateEnvelope(rawRequest);
      if (!envelope.request) {
        return { accepted: true, response: envelope.error! };
      }
      const { requestId, method, params } = envelope.request;
      // Sending any reply with an in-flight ID could settle the earlier
      // promise in the Worker, so a duplicate is ignored without a response.
      if (pendingRequestIds.has(requestId)) return { accepted: false };
      if (!rateLimiter.allow(dependencies.now?.())) {
        return { accepted: true, response: errorResponse(requestId, "protocol.rate_limit", "Plugin API request rate limit was reached.", true) };
      }
      if (initialContextError) {
        return { accepted: true, response: errorResponse(requestId, initialContextError.code, initialContextError.message) };
      }
      if (pendingRequestIds.size >= PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS) {
        return { accepted: true, response: errorResponse(requestId, "protocol.in_flight_limit", "Plugin API has reached its in-flight request limit.", true) };
      }
      pendingRequestIds.add(requestId);
      const controller = new AbortController();
      pendingControllers.set(requestId, controller);
      nativeRequestSequence += 1;
      const nativeRequestId = globalThis.crypto?.randomUUID
        ? `pude_native_${globalThis.crypto.randomUUID()}`
        : `pude_native_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${nativeRequestSequence.toString(36)}`;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let rejectOnAbort!: (error: Error) => void;
      const abortPromise = new Promise<never>((_resolve, reject) => { rejectOnAbort = reject; });
      // Mark the abort promise handled even if the request fails before its first async wait.
      void abortPromise.catch(() => undefined);
      const onAbort = () => rejectOnAbort(new PluginApiV2OperationError(
        timedOut ? "host.operation_timeout" : "plugin.cancelled",
        timedOut ? "Plugin API operation exceeded its time limit." : "Plugin operation was cancelled.",
        timedOut,
      ));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, PLUGIN_EXECUTION_TIMEOUT_MS);
      const awaitRequest = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, abortPromise]);
      try {
        const currentContext = dependencies.getContext();
        const contextError = validateContext({ ...currentContext, source, token });
        if (contextError) return { accepted: true, response: errorResponse(requestId, contextError.code, contextError.message) };
        const plugin = currentContext.installedPlugin!;
        const permission = PLUGIN_API_V2_PERMISSION_BY_METHOD[method];
        if (!plugin.permissions.includes(permission)) {
          return { accepted: true, response: errorResponse(requestId, "permission.not_declared", `Plugin has not declared ${permission}.`) };
        }
        if (method === "commands.register" && !isCommandDeclared(plugin, params.id as string)) {
          return { accepted: true, response: errorResponse(requestId, "manifest.command_not_declared", "Command is not declared by this plugin manifest.") };
        }
        const initialScope = permissionScopeForRequest(plugin, method, params, currentContext.workspaceRoot);
        const scopeError = errorForPermissionScope(initialScope);
        if (scopeError) return { accepted: true, response: errorResponse(requestId, scopeError.code, scopeError.message, scopeError.retryable) };
        const scope = initialScope as PluginApiV2PermissionScope;

        const authorize = async () => {
          if (stopped || controller.signal.aborted) throw new PluginApiV2OperationError("plugin.cancelled", "Plugin operation was cancelled.");
          const liveContext = dependencies.getContext();
          const liveContextError = validateContext({ ...liveContext, source, token });
          if (liveContextError) throw new PluginApiV2OperationError(liveContextError.code, liveContextError.message, liveContextError.retryable);
          const livePlugin = liveContext.installedPlugin!;
          if (!livePlugin.permissions.includes(permission)) throw permissionFailure(permission, true);
          if (method === "commands.register" && !isCommandDeclared(livePlugin, params.id as string)) {
            throw new PluginApiV2OperationError("manifest.command_not_declared", "Command is not declared by this plugin manifest.");
          }
          let granted: boolean;
          try {
            granted = await awaitRequest(Promise.resolve(dependencies.resolvePermission(livePlugin, permission, scope)));
          } catch {
            throw new PluginApiV2OperationError("permission.resolver_failed", "Plugin permission could not be verified.", true);
          }
          if (stopped || controller.signal.aborted) throw new PluginApiV2OperationError("plugin.cancelled", "Plugin operation was cancelled.");
          if (!granted) throw permissionFailure(permission, false);
          const afterGrant = dependencies.getContext();
          const afterGrantError = validateContext({ ...afterGrant, source, token });
          if (afterGrantError) throw new PluginApiV2OperationError(afterGrantError.code, afterGrantError.message, afterGrantError.retryable);
          if (!afterGrant.installedPlugin!.permissions.includes(permission)) throw permissionFailure(permission, true);
        };

        const executionContext: PluginApiV2ExecutionContext = {
          signal: controller.signal,
          nativeRequestId,
          plugin,
          workspaceRoot: currentContext.workspaceRoot,
          authorize,
        };
        await authorize();
        const result = await awaitRequest(Promise.resolve().then(() => dependencies.execute(method, params, executionContext)));
        if (stopped) return { accepted: false };
        if (method === "editor.getText" && typeof result === "string" && result.length > PLUGIN_API_V2_MAX_TEXT_RANGE_UNITS) {
          return { accepted: true, response: errorResponse(requestId, "editor.range_required", "The active document is too large for one response; use editor.getTextRange with the current file revision.") };
        }
        if (method === "workspace.readFile" && isRecord(result) && typeof result.content === "string"
            && new TextEncoder().encode(result.content).byteLength > PLUGIN_API_V2_MAX_FILE_RANGE_BYTES) {
          return { accepted: true, response: errorResponse(requestId, "workspace.file_requires_ranges", "The workspace file is too large for one response; use workspace.getFileInfo and workspace.readFileRange.") };
        }
        const response = successResponse(requestId, result);
        if (!isPluginMessageWithinLimit(response, MAX_PLUGIN_RESPONSE_MESSAGE_BYTES)) {
          return { accepted: true, response: errorResponse(requestId, "protocol.response_too_large", "Plugin API response exceeds the response size or structure limit.") };
        }
        return { accepted: true, response };
      } catch (error) {
        if (stopped) return { accepted: false };
        if (error instanceof PluginApiV2OperationError) {
          return { accepted: true, response: errorResponse(requestId, error.code, error.message, error.retryable) };
        }
        if (controller.signal.aborted) return { accepted: false };
        return { accepted: true, response: errorResponse(requestId, "host.operation_failed", "Plugin API operation failed.", true) };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        controller.signal.removeEventListener("abort", onAbort);
        pendingControllers.delete(requestId);
        pendingRequestIds.delete(requestId);
      }
    },
    stop() {
      stopped = true;
      for (const controller of pendingControllers.values()) controller.abort();
      pendingControllers.clear();
      pendingRequestIds.clear();
      rateLimiter.clear();
    },
    get pendingCount() {
      return pendingRequestIds.size;
    },
  };
}
