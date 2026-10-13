import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../types";
import {
  PluginAuthorizationManager,
  addPluginPermissionGrants,
  buildPluginPermissionReview,
  emptyPluginAuthorizationStore,
  isPluginPermissionAuthorized,
  loadPluginAuthorizationStore,
  matchesResolvedPluginLspGrant,
  normalizePluginNetworkDomain,
  parsePluginAuthorizationStore,
  pluginAuthorizationActionLabels,
  serializePluginAuthorizationStore,
  type PluginPermissionGrantRequest,
  type PluginPermissionResourceScope,
} from "./plugin-authorization";

const baseManifest: PluginManifest = {
  id: "example.secure-plugin",
  name: "Secure Plugin",
  version: "1.0.0",
  apiVersion: "2",
  entry: "index.js",
  permissions: ["editor.read", "network", "process.spawn:lsp"],
  activationEvents: ["onCommand:example.run"],
  networkDomains: ["api.example.com"],
  lspServers: [{
    serverId: "rust",
    language: "rust",
    executable: "/opt/lsp/rust-analyzer",
    args: ["--stdio"],
  }],
};

function request(overrides: Partial<PluginPermissionGrantRequest> = {}): PluginPermissionGrantRequest {
  return {
    pluginId: baseManifest.id,
    pluginVersion: baseManifest.version,
    permission: "network",
    workspaceRoot: "/work/project",
    resourceScope: { kind: "domain", value: "api.example.com" },
    ...overrides,
  };
}

describe("plugin authorization persistence", () => {
  it("round trips valid grants and drops malformed or unsupported records", () => {
    const store = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [
      request(),
      request({ permission: "editor.read", resourceScope: undefined }),
      request({ permission: "process.spawn:lsp", resourceScope: {
        kind: "executable",
        serverId: "rust",
        language: "rust",
        executablePath: "/opt/lsp/rust-analyzer",
        args: ["--stdio"],
      } }),
    ], "2026-09-23T00:00:00.000Z");
    const decoded = loadPluginAuthorizationStore(serializePluginAuthorizationStore(store));

    expect(decoded.grants).toHaveLength(3);
    expect(decoded.grants.map((grant) => grant.permission)).toEqual(["network", "editor.read", "process.spawn:lsp"]);
    expect(parsePluginAuthorizationStore({ version: 99, grants: store.grants }).grants).toEqual([]);
    expect(parsePluginAuthorizationStore({
      version: 1,
      grants: [
        { ...store.grants[0], workspaceRoot: null },
        { ...store.grants[0], id: "forged", permission: "process.spawn" },
        { ...store.grants[0], id: "forged-network", resourceScope: { kind: "domain", value: "*.example.com" } },
      ],
    }).grants).toEqual([]);
  });

  it("requires matching plugin version, workspace, permission, and exact domain", () => {
    const store = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [request()]);
    const input = {
      store,
      plugin: { id: baseManifest.id, version: baseManifest.version },
      permission: "network" as const,
      workspaceRoot: "/work/project",
      resourceScope: { kind: "domain" as const, value: "HTTPS://API.EXAMPLE.COM" },
    };

    expect(isPluginPermissionAuthorized(input)).toBe(true);
    expect(isPluginPermissionAuthorized({ ...input, workspaceRoot: "/work/other" })).toBe(false);
    expect(isPluginPermissionAuthorized({ ...input, plugin: { ...input.plugin, version: "2.0.0" } })).toBe(false);
    expect(isPluginPermissionAuthorized({ ...input, resourceScope: { kind: "domain", value: "cdn.example.com" } })).toBe(false);
    expect(isPluginPermissionAuthorized({ ...input, resourceScope: undefined })).toBe(false);
  });

  it("matches an LSP approval against the exact executable and argument list", () => {
    const executableScope: PluginPermissionResourceScope = {
      kind: "executable",
      serverId: "rust",
      language: "rust",
      executablePath: "/opt/lsp/rust-analyzer",
      args: ["--stdio"],
    };
    const lspRequest = request({
      permission: "process.spawn:lsp",
      resourceScope: executableScope,
    });
    const store = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [lspRequest]);
    const input = {
      store,
      plugin: { id: baseManifest.id, version: baseManifest.version },
      permission: "process.spawn:lsp" as const,
      workspaceRoot: "/work/project",
      resourceScope: executableScope,
    };

    expect(isPluginPermissionAuthorized(input)).toBe(true);
    expect(isPluginPermissionAuthorized({ ...input, resourceScope: { ...input.resourceScope, args: ["--stdio", "--unsafe"] } })).toBe(false);
    expect(isPluginPermissionAuthorized({ ...input, resourceScope: { ...input.resourceScope, executablePath: "/tmp/rust-analyzer" } })).toBe(false);
    expect(isPluginPermissionAuthorized({ ...input, resourceScope: { ...input.resourceScope, serverId: "other" } })).toBe(false);
  });

  it("normalizes only exact HTTPS hostnames and rejects ports, wildcards, and HTTP", () => {
    expect(normalizePluginNetworkDomain("HTTPS://API.EXAMPLE.COM")).toBe("api.example.com");
    expect(normalizePluginNetworkDomain("api.example.com:8443")).toBeNull();
    expect(normalizePluginNetworkDomain("*.example.com")).toBeNull();
    expect(normalizePluginNetworkDomain("http://api.example.com")).toBeNull();
    expect(normalizePluginNetworkDomain("api.example.com/path")).toBeNull();
  });
});

describe("plugin permission review", () => {
  it("distinguishes a zero-permission install or update from cancel", () => {
    expect(pluginAuthorizationActionLabels(false, 0)).toEqual({
      cancel: "Cancel install",
      approve: "Install without permissions",
    });
    expect(pluginAuthorizationActionLabels(true, 0)).toEqual({
      cancel: "Keep current version",
      approve: "Update without permissions",
    });
    expect(pluginAuthorizationActionLabels(true, 2).approve).toBe("Update with 2 permissions");
  });

  it("marks newly requested permissions and domains and requires version-bound high-risk approval", () => {
    const current: PluginManifest = { ...baseManifest, version: "1.0.0", permissions: ["network"], networkDomains: ["api.example.com"] };
    const proposed: PluginManifest = {
      ...baseManifest,
      version: "2.0.0",
      permissions: ["network", "workspace.write"],
      networkDomains: ["api.example.com", "cdn.example.com"],
      lspServers: [],
    };
    const oldGrantStore = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [request()]);
    const items = buildPluginPermissionReview({
      current,
      proposed,
      existingGrants: oldGrantStore.grants,
      workspaceRoot: "/work/project",
    });

    const existingDomain = items.find((item) => item.key === "network:api.example.com");
    const addedDomain = items.find((item) => item.key === "network:cdn.example.com");
    const addedWrite = items.find((item) => item.permission === "workspace.write");
    expect(existingDomain).toMatchObject({ added: false, previouslyGranted: true, requiresFreshApproval: true, available: true });
    expect(addedDomain).toMatchObject({ added: true, previouslyGranted: false, requiresFreshApproval: true });
    expect(addedWrite).toMatchObject({ added: true, available: true, grantRequest: { workspaceRoot: "/work/project" } });
  });

  it("disables workspace and network grants when no workspace is open", () => {
    const manifest: PluginManifest = { ...baseManifest, permissions: ["editor.read", "network"] };
    const items = buildPluginPermissionReview({ proposed: manifest, existingGrants: [], workspaceRoot: "" });
    expect(items.every((item) => !item.available)).toBe(true);
    expect(items.some((item) => item.unavailableReason?.includes("workspace"))).toBe(true);
  });

  it("requires the native canonical LSP resolution before offering executable consent", () => {
    const unresolved: PluginManifest = { ...baseManifest, permissions: ["process.spawn:lsp"] };
    const unresolvedItems = buildPluginPermissionReview({ proposed: unresolved, existingGrants: [], workspaceRoot: "/work/project" });
    expect(unresolvedItems[0]).toMatchObject({ available: false, unavailableReason: expect.stringContaining("canonical executable path") });

    const resolved = {
      ...unresolved,
      resolvedLspServers: [{
        workspaceRoot: "/work/project",
        serverId: "rust",
        language: "rust",
        executablePath: "/real/toolchain/rust-analyzer",
        args: ["--stdio"],
      }],
    };
    const resolvedItems = buildPluginPermissionReview({ proposed: resolved, existingGrants: [], workspaceRoot: "/work/project" });
    expect(resolvedItems[0]).toMatchObject({
      available: true,
      details: expect.arrayContaining(["/real/toolchain/rust-analyzer"]),
      grantRequest: { resourceScope: { executablePath: "/real/toolchain/rust-analyzer" } },
    });
  });

  it("matches the reviewed Windows executable without changing its native wire path or widening consent", () => {
    const server = {
      workspaceRoot: "C:\\work",
      serverId: "rust",
      language: "rust",
      executablePath: "\\\\?\\C:\\tools\\rust-analyzer.exe",
      args: ["--stdio"],
    };
    const proposed = { ...baseManifest, permissions: ["process.spawn:lsp"] as PluginManifest["permissions"], resolvedLspServers: [server] };
    const reviewed = buildPluginPermissionReview({ proposed, existingGrants: [], workspaceRoot: server.workspaceRoot })[0].grantRequest;
    expect(matchesResolvedPluginLspGrant(server, reviewed)).toBe(true);
    expect(server.executablePath).toBe("\\\\?\\C:\\tools\\rust-analyzer.exe");
    for (const changed of [
      { ...server, workspaceRoot: "C:\\other" },
      { ...server, serverId: "other" },
      { ...server, language: "other" },
      { ...server, executablePath: "\\\\?\\C:\\other\\rust-analyzer.exe" },
      { ...server, args: ["--other"] },
    ]) expect(matchesResolvedPluginLspGrant(changed, reviewed)).toBe(false);
  });
});

describe("plugin authorization manager", () => {
  it("persists before making grants effective and emits revocation and workspace changes", () => {
    const persist = vi.fn(() => true);
    const manager = new PluginAuthorizationManager(emptyPluginAuthorizationStore(), persist);
    const events: string[] = [];
    manager.subscribe((event) => events.push(event.type));

    expect(manager.grant([request()])).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(manager.hasPermission({
      plugin: { id: baseManifest.id, version: baseManifest.version },
      permission: "network",
      workspaceRoot: "/work/project",
      resourceScope: request().resourceScope,
    })).toBe(true);

    const grant = manager.getSnapshot().grants[0];
    expect(manager.revoke(grant.id)).toBe(true);
    manager.notifyWorkspaceChanged("/work/project", "/work/other");
    expect(events).toEqual(["grant", "revoke", "workspace-change"]);
  });

  it("leaves authorization denied when persistence fails", () => {
    const manager = new PluginAuthorizationManager(emptyPluginAuthorizationStore(), () => false);
    expect(manager.grant([request()])).toBe(false);
    expect(manager.getSnapshot().grants).toEqual([]);
    expect(manager.hasPermission({
      plugin: { id: baseManifest.id, version: baseManifest.version },
      permission: "network",
      workspaceRoot: "/work/project",
      resourceScope: request().resourceScope,
    })).toBe(false);
  });

  it("replaces the reviewed plugin grants and revokes unchecked and older-version grants", () => {
    const kept = request();
    const revoked = request({ resourceScope: { kind: "domain", value: "cdn.example.com" } });
    const olderVersion = request({ pluginVersion: "0.9.0" });
    const otherPlugin = request({ pluginId: "example.other-plugin" });
    const initial = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [kept, revoked, olderVersion, otherPlugin]);
    const manager = new PluginAuthorizationManager(initial, () => true);
    const changes: string[] = [];
    manager.subscribe((change) => {
      if (change.type === "revoke") changes.push(`revoke:${change.grant.resourceScope?.kind === "domain" ? change.grant.resourceScope.value : "unknown"}`);
      if (change.type === "grant") changes.push(`grant:${change.pluginId}`);
    });

    expect(manager.replacePluginGrants(baseManifest.id, baseManifest.version, [kept])).toBe(true);
    expect(manager.getSnapshot().grants).toEqual([initial.grants[3], initial.grants[0]]);
    expect(changes).toEqual(["revoke:cdn.example.com", "revoke:api.example.com"]);
    expect(manager.hasPermission({
      plugin: { id: baseManifest.id, version: baseManifest.version },
      permission: "network",
      workspaceRoot: "/work/project",
      resourceScope: revoked.resourceScope,
    })).toBe(false);
  });

  it("removes prior-version grants when an update is approved without permissions", () => {
    const initial = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [
      request(),
      request({ pluginVersion: "0.9.0" }),
      request({ pluginId: "example.other-plugin" }),
    ]);
    const persist = vi.fn(() => true);
    const manager = new PluginAuthorizationManager(initial, persist);
    const revoked: string[] = [];
    manager.subscribe((change) => {
      if (change.type === "revoke") revoked.push(change.grant.id);
    });

    expect(manager.replacePluginGrants(baseManifest.id, "2.0.0", [])).toBe(true);
    expect(manager.getSnapshot().grants).toEqual([initial.grants[2]]);
    expect(persist).toHaveBeenCalledOnce();
    expect(revoked).toEqual(initial.grants.slice(0, 2).map((grant) => grant.id));
  });

  it("keeps existing grants and emits no revocation when replacement persistence fails", () => {
    const initial = addPluginPermissionGrants(emptyPluginAuthorizationStore(), [
      request(),
      request({ resourceScope: { kind: "domain", value: "cdn.example.com" } }),
      request({ pluginVersion: "0.9.0" }),
    ]);
    const manager = new PluginAuthorizationManager(initial, () => false);
    const changes: string[] = [];
    manager.subscribe((change) => changes.push(change.type));

    expect(manager.replacePluginGrants(baseManifest.id, "2.0.0", [])).toBe(false);
    expect(manager.getSnapshot()).toEqual(initial);
    expect(changes).toEqual([]);
  });
});
