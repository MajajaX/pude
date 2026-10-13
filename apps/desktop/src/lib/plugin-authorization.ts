import type { PluginLspServer, PluginManifest, PluginPermission } from "../types";

export const PLUGIN_AUTHORIZATION_STORAGE_KEY = "pude-plugin-authorizations-v1";
export const PLUGIN_AUTHORIZATION_STORE_VERSION = 1 as const;
const MAX_AUTHORIZATION_GRANTS = 2_000;

export type PluginAuthorizationPlugin = Pick<PluginManifest, "id" | "version" | "permissions"> & {
  networkDomains?: string[];
  lspServers?: PluginLspServer[];
};

export type PluginPermissionResourceScope =
  | { kind: "domain"; value: string }
  | {
      kind: "executable";
      serverId: string;
      language: string;
      executablePath: string;
      args: string[];
    };

export type PluginPermissionGrantRequest = {
  pluginId: string;
  pluginVersion: string;
  permission: PluginPermission;
  workspaceRoot: string | null;
  resourceScope?: PluginPermissionResourceScope;
};

export type PluginPermissionGrant = PluginPermissionGrantRequest & {
  id: string;
  approvedAt: string;
};

export type PluginAuthorizationStore = {
  version: typeof PLUGIN_AUTHORIZATION_STORE_VERSION;
  grants: PluginPermissionGrant[];
};

export type PluginAuthorizationChange =
  | { type: "grant"; pluginId: string; permission: PluginPermission; workspaceRoot: string | null }
  | { type: "revoke"; grant: PluginPermissionGrant }
  | { type: "plugin-revoke"; pluginId: string; grants: PluginPermissionGrant[] }
  | { type: "workspace-change"; previousWorkspaceRoot: string; workspaceRoot: string };

export type PluginAuthorizationResource = PluginPermissionResourceScope;

export type PluginPermissionReviewItem = {
  key: string;
  permission: PluginPermission;
  label: string;
  details: string[];
  added: boolean;
  previouslyGranted: boolean;
  requiresFreshApproval: boolean;
  grantRequest: PluginPermissionGrantRequest;
  available: boolean;
  unavailableReason?: string;
};

export function pluginAuthorizationActionLabels(hasCurrentPlugin: boolean, selectedPermissionCount: number): {
  cancel: string;
  approve: string;
} {
  const count = Math.max(0, Math.floor(selectedPermissionCount));
  const action = hasCurrentPlugin ? "Update" : "Install";
  return {
    cancel: hasCurrentPlugin ? "Keep current version" : "Cancel install",
    approve: count === 0
      ? `${action} without permissions`
      : `${action} with ${count} ${count === 1 ? "permission" : "permissions"}`,
  };
}

export type PluginAuthorizationReviewManifest = PluginManifest & {
  networkDomains?: string[];
  lspServers?: PluginLspServer[];
  resolvedLspServers?: PluginResolvedLspServer[];
};

export type PluginResolvedLspServer = {
  workspaceRoot: string;
  serverId: string;
  language: string;
  executablePath: string;
  args: string[];
};

const allPermissions = new Set<PluginPermission>([
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

const highRiskPermissions = new Set<PluginPermission>([
  "workspace.write",
  "terminal.write",
  "network",
  "process.spawn:lsp",
]);

const workspaceScopedPermissions = new Set<PluginPermission>([
  "editor.read",
  "editor.write",
  "workspace.read",
  "workspace.write",
  "git.read",
  "terminal.write",
  "network",
  "process.spawn:lsp",
]);

const permissionLabels: Record<PluginPermission, string> = {
  "editor.read": "Read active editor content",
  "editor.write": "Edit the active document",
  "workspace.read": "Read files in the workspace",
  "workspace.write": "Create or modify workspace files",
  "commands.register": "Register commands",
  "ui.notification": "Show notifications",
  "ui.statusBar": "Add status bar items",
  "ui.quickPick": "Show quick picks",
  "git.read": "Read Git status and diffs",
  "terminal.write": "Write to an existing terminal",
  network: "Access approved HTTPS domains",
  "process.spawn:lsp": "Start approved language servers",
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && allPermissions.has(value as PluginPermission);
}

function normalizeWorkspaceRoot(value: string | null): string | null {
  return value;
}

export function normalizePluginNetworkDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("*") || /[\s@?#]/.test(trimmed)) return null;
  const includesScheme = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed);
  if (!includesScheme && /[/:]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeResourceScope(scope: PluginPermissionResourceScope): PluginPermissionResourceScope | null {
  if (scope.kind === "domain") {
    const value = normalizePluginNetworkDomain(scope.value);
    return value ? { kind: "domain", value } : null;
  }
  if (scope.kind !== "executable"
      || !scope.serverId.trim()
      || !scope.language.trim()
      || !isAbsoluteExecutablePath(scope.executablePath)
      || !Array.isArray(scope.args)
      || scope.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) return null;
  return {
    kind: "executable",
    serverId: scope.serverId,
    language: scope.language,
    executablePath: normalizeExecutablePath(scope.executablePath),
    args: [...scope.args],
  };
}

export function isAbsoluteExecutablePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeExecutablePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

export function matchesResolvedPluginLspGrant(server: PluginResolvedLspServer, request: PluginPermissionGrantRequest): boolean {
  const scope = request.resourceScope;
  return request.permission === "process.spawn:lsp" && scope?.kind === "executable"
    && server.workspaceRoot === request.workspaceRoot
    && server.serverId === scope.serverId
    && server.language === scope.language
    && normalizeExecutablePath(server.executablePath) === normalizeExecutablePath(scope.executablePath)
    && JSON.stringify(server.args) === JSON.stringify(scope.args);
}

function grantIdFor(request: PluginPermissionGrantRequest): string {
  return JSON.stringify([
    request.pluginId,
    request.pluginVersion,
    request.permission,
    normalizeWorkspaceRoot(request.workspaceRoot),
    request.resourceScope?.kind === "domain" ? request.resourceScope.value : null,
    request.resourceScope?.kind === "executable"
      ? [request.resourceScope.serverId, request.resourceScope.language, request.resourceScope.executablePath, request.resourceScope.args]
      : null,
  ]);
}

function parseResourceScope(value: unknown): PluginPermissionResourceScope | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "domain" && typeof value.value === "string") {
    return normalizeResourceScope({ kind: "domain", value: value.value });
  }
  if (value.kind === "executable"
      && typeof value.serverId === "string"
      && typeof value.language === "string"
      && typeof value.executablePath === "string"
      && Array.isArray(value.args)
      && value.args.every((argument) => typeof argument === "string")) {
    return normalizeResourceScope({
      kind: "executable",
      serverId: value.serverId,
      language: value.language,
      executablePath: value.executablePath,
      args: value.args,
    });
  }
  return null;
}

function parseGrant(value: unknown): PluginPermissionGrant | null {
  if (!isRecord(value)
      || typeof value.pluginId !== "string"
      || !value.pluginId.trim()
      || typeof value.pluginVersion !== "string"
      || !value.pluginVersion.trim()
      || !isPluginPermission(value.permission)
      || (typeof value.workspaceRoot !== "string" && value.workspaceRoot !== null)
      || typeof value.approvedAt !== "string"
      || !Number.isFinite(Date.parse(value.approvedAt))) return null;
  if (workspaceScopedPermissions.has(value.permission) && (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0)) return null;
  const scope = parseResourceScope(value.resourceScope);
  if (scope === null) return null;
  if (value.permission === "network" && scope?.kind !== "domain") return null;
  if (value.permission === "process.spawn:lsp" && scope?.kind !== "executable") return null;
  if (value.permission !== "network" && scope?.kind === "domain") return null;
  if (value.permission !== "process.spawn:lsp" && scope?.kind === "executable") return null;
  const request: PluginPermissionGrantRequest = {
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    permission: value.permission,
    workspaceRoot: value.workspaceRoot,
    ...(scope ? { resourceScope: scope } : {}),
  };
  const id = grantIdFor(request);
  if (typeof value.id !== "string" || value.id !== id) return null;
  return { ...request, id, approvedAt: value.approvedAt };
}

export function emptyPluginAuthorizationStore(): PluginAuthorizationStore {
  return { version: PLUGIN_AUTHORIZATION_STORE_VERSION, grants: [] };
}

export function parsePluginAuthorizationStore(value: unknown): PluginAuthorizationStore {
  if (!isRecord(value) || value.version !== PLUGIN_AUTHORIZATION_STORE_VERSION || !Array.isArray(value.grants)) {
    return emptyPluginAuthorizationStore();
  }
  const grants = value.grants.slice(0, MAX_AUTHORIZATION_GRANTS)
    .map(parseGrant)
    .filter((grant): grant is PluginPermissionGrant => Boolean(grant));
  return {
    version: PLUGIN_AUTHORIZATION_STORE_VERSION,
    grants: grants.filter((grant, index, all) => all.findIndex((candidate) => candidate.id === grant.id) === index),
  };
}

export function loadPluginAuthorizationStore(serialized: string | null | undefined): PluginAuthorizationStore {
  if (!serialized) return emptyPluginAuthorizationStore();
  try {
    return parsePluginAuthorizationStore(JSON.parse(serialized));
  } catch {
    return emptyPluginAuthorizationStore();
  }
}

export function serializePluginAuthorizationStore(store: PluginAuthorizationStore): string {
  return JSON.stringify(parsePluginAuthorizationStore(store));
}

export function isPluginPermissionHighRisk(permission: PluginPermission): boolean {
  return highRiskPermissions.has(permission);
}

function sameResourceScope(left: PluginPermissionResourceScope | undefined, right: PluginPermissionResourceScope | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameWorkspace(grant: PluginPermissionGrant, workspaceRoot: string): boolean {
  return grant.workspaceRoot === null || grant.workspaceRoot === workspaceRoot;
}

export function isPluginPermissionAuthorized(input: {
  store: PluginAuthorizationStore;
  plugin: Pick<PluginAuthorizationPlugin, "id" | "version">;
  permission: PluginPermission;
  workspaceRoot: string;
  resourceScope?: PluginAuthorizationResource;
}): boolean {
  if (!input.plugin.id || !input.plugin.version) return false;
  const parsedScope = input.resourceScope ? normalizeResourceScope(input.resourceScope) : undefined;
  if (input.resourceScope && !parsedScope) return false;
  const normalizedScope = parsedScope ?? undefined;
  if (input.permission === "network" && normalizedScope?.kind !== "domain") return false;
  if (input.permission === "process.spawn:lsp" && normalizedScope?.kind !== "executable") return false;
  return input.store.grants.some((grant) => grant.pluginId === input.plugin.id
    && grant.pluginVersion === input.plugin.version
    && grant.permission === input.permission
    && sameWorkspace(grant, input.workspaceRoot)
    && sameResourceScope(grant.resourceScope, normalizedScope));
}

function manifestDomainList(manifest: PluginAuthorizationReviewManifest): string[] {
  return (manifest.networkDomains ?? [])
    .filter((domain): domain is string => typeof domain === "string")
    .map(normalizePluginNetworkDomain)
    .filter((domain): domain is string => Boolean(domain))
    .filter((domain, index, domains) => domains.indexOf(domain) === index);
}

function manifestServers(manifest: PluginAuthorizationReviewManifest, workspaceRoot: string): Array<{
  serverId: string;
  language: string;
  executablePath: string;
  args: string[];
  available: boolean;
  unavailableReason?: string;
}> {
  return (manifest.lspServers ?? []).filter((server) => server
    && typeof server.serverId === "string"
    && typeof server.language === "string"
    && typeof server.executable === "string"
    && Array.isArray(server.args)
    && server.args.every((argument) => typeof argument === "string" && !argument.includes("\0")))
    .map((server) => {
      const resolved = manifest.resolvedLspServers?.find((candidate) => candidate.serverId === server.serverId
        && candidate.language === server.language
        && JSON.stringify(candidate.args) === JSON.stringify(server.args));
      const canonicalPath = resolved?.executablePath;
      const scopeMatchesWorkspace = Boolean(resolved && resolved.workspaceRoot === workspaceRoot);
      const hasCanonicalPath = Boolean(canonicalPath && isAbsoluteExecutablePath(canonicalPath));
      return {
        serverId: server.serverId,
        language: server.language,
        executablePath: canonicalPath && hasCanonicalPath ? normalizeExecutablePath(canonicalPath) : "",
        args: [...server.args],
        available: Boolean(scopeMatchesWorkspace && hasCanonicalPath),
        unavailableReason: !resolved
          ? "The host could not resolve this server to a canonical executable path."
          : !scopeMatchesWorkspace
            ? "Resolve this server again for the current canonical workspace."
            : !hasCanonicalPath
              ? "The resolved server executable path is not absolute."
              : undefined,
      };
    });
}

function requestFor(
  plugin: PluginAuthorizationPlugin,
  permission: PluginPermission,
  workspaceRoot: string,
  resourceScope?: PluginPermissionResourceScope,
): PluginPermissionGrantRequest {
  return {
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    permission,
    workspaceRoot: workspaceScopedPermissions.has(permission) ? workspaceRoot || null : null,
    ...(resourceScope ? { resourceScope: normalizeResourceScope(resourceScope) ?? resourceScope } : {}),
  };
}

function hasMatchingGrant(
  grants: PluginPermissionGrant[],
  request: PluginPermissionGrantRequest,
  pluginId: string,
  requireVersion: boolean,
): boolean {
  return grants.some((grant) => grant.pluginId === pluginId
    && grant.permission === request.permission
    && (!requireVersion || grant.pluginVersion === request.pluginVersion)
    && grant.workspaceRoot === request.workspaceRoot
    && sameResourceScope(grant.resourceScope, request.resourceScope));
}

export function buildPluginPermissionReview(input: {
  current?: PluginAuthorizationReviewManifest;
  proposed: PluginAuthorizationReviewManifest;
  existingGrants: PluginPermissionGrant[];
  workspaceRoot: string;
}): PluginPermissionReviewItem[] {
  const { current, proposed, existingGrants, workspaceRoot } = input;
  const permissions = [...new Set(proposed.permissions)];
  const items: PluginPermissionReviewItem[] = [];
  for (const permission of permissions) {
    if (!isPluginPermission(permission)) continue;
    const added = !current?.permissions.includes(permission);
    if (permission === "network") {
      const domains = manifestDomainList(proposed);
      for (const domain of domains) {
        const resourceScope: PluginPermissionResourceScope = { kind: "domain", value: domain };
        const grantRequest = requestFor(proposed, permission, workspaceRoot, resourceScope);
        const previouslyGranted = hasMatchingGrant(existingGrants, grantRequest, proposed.id, false);
        const domainAdded = !current || !manifestDomainList(current).includes(domain);
        items.push({
          key: `${permission}:${domain}`,
          permission,
          label: `${permissionLabels[permission]} · ${domain}`,
          details: [`Workspace: ${grantRequest.workspaceRoot || "No workspace"}`, `HTTPS requests to ${domain} only`],
          added: added || domainAdded,
          previouslyGranted,
          requiresFreshApproval: !hasMatchingGrant(existingGrants, grantRequest, proposed.id, true),
          grantRequest,
          available: Boolean(grantRequest.workspaceRoot),
          unavailableReason: grantRequest.workspaceRoot ? undefined : "Open a workspace before granting network access.",
        });
      }
      if (!domains.length) {
        items.push({
          key: permission,
          permission,
          label: permissionLabels[permission],
          details: [],
          added,
          previouslyGranted: false,
          requiresFreshApproval: true,
          grantRequest: requestFor(proposed, permission, workspaceRoot),
          available: false,
          unavailableReason: "The manifest does not declare a valid HTTPS domain.",
        });
      }
      continue;
    }
    if (permission === "process.spawn:lsp") {
      const servers = manifestServers(proposed, workspaceRoot);
      for (const server of servers) {
        const resourceScope: PluginPermissionResourceScope = {
          kind: "executable",
          serverId: server.serverId,
          language: server.language,
          executablePath: server.executablePath,
          args: server.args,
        };
        const grantRequest = requestFor(proposed, permission, workspaceRoot, resourceScope);
        const matchingServer = current?.resolvedLspServers?.some((candidate) => candidate.workspaceRoot === workspaceRoot
          && candidate.serverId === server.serverId
          && candidate.language === server.language
          && normalizeExecutablePath(candidate.executablePath) === server.executablePath
          && JSON.stringify(candidate.args) === JSON.stringify(server.args)) ?? false;
        const previouslyGranted = hasMatchingGrant(existingGrants, grantRequest, proposed.id, false);
        items.push({
          key: `${permission}:${server.serverId}`,
          permission,
          label: `${permissionLabels[permission]} · ${server.serverId}`,
          details: [`Workspace: ${grantRequest.workspaceRoot || "No workspace"}`, server.language, server.executablePath || "Unresolved executable", `Arguments: ${JSON.stringify(server.args)}`],
          added: added || !matchingServer,
          previouslyGranted,
          requiresFreshApproval: !hasMatchingGrant(existingGrants, grantRequest, proposed.id, true),
          grantRequest,
          available: server.available,
          unavailableReason: server.unavailableReason,
        });
      }
      if (!servers.length) {
        items.push({
          key: permission,
          permission,
          label: permissionLabels[permission],
          details: [],
          added,
          previouslyGranted: false,
          requiresFreshApproval: true,
          grantRequest: requestFor(proposed, permission, workspaceRoot),
          available: false,
          unavailableReason: "The manifest does not declare an absolute language-server executable and exact arguments.",
        });
      }
      continue;
    }
    const grantRequest = requestFor(proposed, permission, workspaceRoot);
    const previouslyGranted = hasMatchingGrant(existingGrants, grantRequest, proposed.id, false);
    const alreadyGrantedForVersion = hasMatchingGrant(existingGrants, grantRequest, proposed.id, true);
    const requiresWorkspace = workspaceScopedPermissions.has(permission) && !grantRequest.workspaceRoot;
    items.push({
      key: permission,
      permission,
      label: permissionLabels[permission],
      details: grantRequest.workspaceRoot ? [`Workspace: ${grantRequest.workspaceRoot}`] : [],
      added,
      previouslyGranted,
      requiresFreshApproval: !alreadyGrantedForVersion,
      grantRequest,
      available: !requiresWorkspace,
      unavailableReason: requiresWorkspace ? "Open a workspace before granting this permission." : undefined,
    });
  }
  return items;
}

function normalizeGrantRequest(request: PluginPermissionGrantRequest): PluginPermissionGrantRequest | null {
  if (!request.pluginId.trim() || !request.pluginVersion.trim() || !isPluginPermission(request.permission)) return null;
  const resourceScope = request.resourceScope ? normalizeResourceScope(request.resourceScope) : undefined;
  const workspaceRoot = normalizeWorkspaceRoot(request.workspaceRoot);
  if (workspaceScopedPermissions.has(request.permission) && (!workspaceRoot || !workspaceRoot.length)) return null;
  if (request.resourceScope && !resourceScope) return null;
  if (request.permission === "network" && resourceScope?.kind !== "domain") return null;
  if (request.permission === "process.spawn:lsp" && resourceScope?.kind !== "executable") return null;
  if (request.permission !== "network" && resourceScope?.kind === "domain") return null;
  if (request.permission !== "process.spawn:lsp" && resourceScope?.kind === "executable") return null;
  return {
    ...request,
    workspaceRoot,
    ...(resourceScope ? { resourceScope } : {}),
  };
}

export function addPluginPermissionGrants(
  store: PluginAuthorizationStore,
  requests: PluginPermissionGrantRequest[],
  approvedAt = new Date().toISOString(),
): PluginAuthorizationStore {
  const grants = [...store.grants];
  for (const request of requests) {
    const normalized = normalizeGrantRequest(request);
    if (!normalized) continue;
    const id = grantIdFor(normalized);
    if (grants.some((grant) => grant.id === id)) continue;
    if (grants.length >= MAX_AUTHORIZATION_GRANTS) break;
    grants.push({ ...normalized, id, approvedAt });
  }
  return { version: PLUGIN_AUTHORIZATION_STORE_VERSION, grants };
}

export function replacePluginPermissionGrants(
  store: PluginAuthorizationStore,
  pluginId: string,
  pluginVersion: string,
  requests: PluginPermissionGrantRequest[],
  approvedAt = new Date().toISOString(),
): PluginAuthorizationStore | null {
  if (!pluginId.trim() || !pluginVersion.trim()) return null;
  const normalizedRequests = requests.map(normalizeGrantRequest);
  if (normalizedRequests.some((request) => request === null
      || request.pluginId !== pluginId
      || request.pluginVersion !== pluginVersion)) return null;

  const currentVersionGrants = store.grants.filter((grant) => grant.pluginId === pluginId && grant.pluginVersion === pluginVersion);
  const currentById = new Map(currentVersionGrants.map((grant) => [grant.id, grant]));
  const replacement = new Map<string, PluginPermissionGrant>();
  for (const request of normalizedRequests) {
    if (!request) continue;
    const id = grantIdFor(request);
    if (replacement.has(id)) continue;
    replacement.set(id, currentById.get(id) ?? { ...request, id, approvedAt });
  }
  const grants = store.grants.filter((grant) => grant.pluginId !== pluginId);
  grants.push(...replacement.values());
  if (grants.length > MAX_AUTHORIZATION_GRANTS) return null;
  return { version: PLUGIN_AUTHORIZATION_STORE_VERSION, grants };
}

export function revokePluginPermissionGrant(store: PluginAuthorizationStore, grantId: string): PluginAuthorizationStore {
  return { version: PLUGIN_AUTHORIZATION_STORE_VERSION, grants: store.grants.filter((grant) => grant.id !== grantId) };
}

export function removePluginPermissionGrants(store: PluginAuthorizationStore, pluginId: string): PluginAuthorizationStore {
  return { version: PLUGIN_AUTHORIZATION_STORE_VERSION, grants: store.grants.filter((grant) => grant.pluginId !== pluginId) };
}

export class PluginAuthorizationManager {
  private store: PluginAuthorizationStore;
  private readonly listeners = new Set<(change: PluginAuthorizationChange) => void>();

  constructor(
    initialStore: PluginAuthorizationStore = emptyPluginAuthorizationStore(),
    private readonly persist?: (store: PluginAuthorizationStore) => boolean,
  ) {
    this.store = parsePluginAuthorizationStore(initialStore);
  }

  getSnapshot(): PluginAuthorizationStore {
    return parsePluginAuthorizationStore(this.store);
  }

  subscribe(listener: (change: PluginAuthorizationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasPermission(input: Omit<Parameters<typeof isPluginPermissionAuthorized>[0], "store">): boolean {
    return isPluginPermissionAuthorized({ ...input, store: this.store });
  }

  grant(requests: PluginPermissionGrantRequest[]): boolean {
    const normalizedRequests = requests.map(normalizeGrantRequest);
    if (normalizedRequests.some((request) => request === null)) return false;
    const validRequests = normalizedRequests.filter((request): request is PluginPermissionGrantRequest => Boolean(request));
    const existingIds = new Set(this.store.grants.map((grant) => grant.id));
    const newlyGranted = validRequests.filter((request) => !existingIds.has(grantIdFor(request)));
    if (this.store.grants.length + newlyGranted.length > MAX_AUTHORIZATION_GRANTS) return false;
    const next = addPluginPermissionGrants(this.store, validRequests);
    if (JSON.stringify(next.grants) === JSON.stringify(this.store.grants)) return true;
    if (this.persist && !this.persist(next)) return false;
    this.store = next;
    for (const request of newlyGranted) {
      this.emit({
        type: "grant",
        pluginId: request.pluginId,
        permission: request.permission,
        workspaceRoot: request.workspaceRoot,
      });
    }
    return true;
  }

  replacePluginGrants(pluginId: string, pluginVersion: string, requests: PluginPermissionGrantRequest[]): boolean {
    const next = replacePluginPermissionGrants(this.store, pluginId, pluginVersion, requests);
    if (!next) return false;
    if (JSON.stringify(next.grants) === JSON.stringify(this.store.grants)) return true;

    const retainedIds = new Set(next.grants.map((grant) => grant.id));
    const previousIds = new Set(this.store.grants.map((grant) => grant.id));
    const revoked = this.store.grants.filter((grant) => grant.pluginId === pluginId
      && !retainedIds.has(grant.id));
    const newlyGranted = next.grants.filter((grant) => grant.pluginId === pluginId
      && grant.pluginVersion === pluginVersion
      && !previousIds.has(grant.id));
    if (this.persist && !this.persist(next)) return false;
    this.store = next;
    for (const grant of revoked) this.emit({ type: "revoke", grant });
    for (const grant of newlyGranted) {
      this.emit({
        type: "grant",
        pluginId: grant.pluginId,
        permission: grant.permission,
        workspaceRoot: grant.workspaceRoot,
      });
    }
    return true;
  }

  revoke(grantId: string): boolean {
    const grant = this.store.grants.find((candidate) => candidate.id === grantId);
    if (!grant) return true;
    const next = revokePluginPermissionGrant(this.store, grantId);
    if (this.persist && !this.persist(next)) return false;
    this.store = next;
    this.emit({ type: "revoke", grant });
    return true;
  }

  revokePlugin(pluginId: string): boolean {
    const removed = this.store.grants.filter((grant) => grant.pluginId === pluginId);
    if (!removed.length) return true;
    const next = removePluginPermissionGrants(this.store, pluginId);
    if (this.persist && !this.persist(next)) return false;
    this.store = next;
    this.emit({ type: "plugin-revoke", pluginId, grants: removed });
    return true;
  }

  notifyWorkspaceChanged(previousWorkspaceRoot: string, workspaceRoot: string): void {
    if (previousWorkspaceRoot === workspaceRoot) return;
    this.emit({ type: "workspace-change", previousWorkspaceRoot, workspaceRoot });
  }

  private emit(change: PluginAuthorizationChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

export function pluginPermissionLabel(permission: PluginPermission): string {
  return permissionLabels[permission];
}
