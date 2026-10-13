import { describe, expect, it, vi } from "vitest";
import {
  createPluginApiV2Host,
  PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS,
  type PluginApiV2Context,
  type PluginApiV2Dependencies,
  type PluginApiV2ExecutionContext,
  type PluginApiV2InstalledPlugin,
} from "./plugin-api-v2";

const frame = {};
const token = "run-token";

function createContext(overrides: Partial<PluginApiV2Context> = {}): PluginApiV2Context {
  const plugin: PluginApiV2InstalledPlugin = {
    id: "pude.example",
    name: "Example",
    version: "1.0.0",
    apiVersion: "2",
    entry: "dist/extension.js",
    permissions: ["editor.read", "commands.register", "ui.notification", "network"],
    activationEvents: ["onCommand:pude.example.run"],
    contributes: { commands: [{ command: "pude.example.run", title: "Run example" }] },
    networkDomains: ["api.example.com"],
    enabled: true,
    rootPath: "/plugins/pude.example",
  };
  return {
    source: undefined,
    expectedSource: frame,
    token: undefined,
    expectedToken: token,
    installedPlugin: plugin,
    expectedPlugin: plugin,
    workspaceGeneration: 7,
    expectedWorkspaceGeneration: 7,
    workspaceRoot: "/work/project",
    expectedWorkspaceRoot: "/work/project",
    ...overrides,
  };
}

function request(requestId: unknown = "pude_1", method = "editor.getText", params: unknown = {}) {
  return { type: "api-request", protocolVersion: 2, requestId, method, params };
}

function createHost(overrides: {
  context?: Partial<PluginApiV2Context>;
  resolvePermission?: (permission: string) => boolean | Promise<boolean>;
  execute?: PluginApiV2Dependencies["execute"];
  now?: () => number;
} = {}) {
  const context = createContext(overrides.context);
  const execute = vi.fn(overrides.execute ?? (() => "hello"));
  const host = createPluginApiV2Host({
    getContext: () => context,
    resolvePermission: (_plugin, permission) => overrides.resolvePermission?.(permission) ?? true,
    execute: (method, params, operationContext) => execute(method, params, operationContext),
    now: overrides.now,
  });
  return { host, context, execute };
}

describe("plugin API v2 host protocol", () => {
  it("validates a request and returns a versioned response", async () => {
    const { host, execute } = createHost();
    const result = await host.handle(request(), frame, token);

    expect(result).toEqual({
      accepted: true,
      response: {
        type: "api-response",
        protocolVersion: 2,
        requestId: "pude_1",
        ok: true,
        result: "hello",
      },
    });
    expect(execute).toHaveBeenCalledWith("editor.getText", {}, expect.objectContaining({ workspaceRoot: "/work/project" }));
  });

  it("keeps the initial read, command registration, and notification operations testable", async () => {
    const execute = vi.fn((method: string, params: Record<string, unknown>) => ({ method, ...params }));
    const networkPlugin = { ...createContext().installedPlugin!, permissions: ["editor.read", "commands.register", "ui.notification", "network"] as PluginApiV2InstalledPlugin["permissions"] };
    const context = createContext({ expectedPlugin: networkPlugin, installedPlugin: networkPlugin });
    const host = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: () => true,
      execute,
    });
    const read = await host.handle(request("read_1"), frame, token);
    const command = await host.handle(request("command_1", "commands.register", { id: "pude.example.run" }), frame, token);
    const notification = await host.handle(request("notify_1", "ui.notify", { message: "Saved" }), frame, token);

    expect(read).toMatchObject({ response: { ok: true, result: { method: "editor.getText" } } });
    expect(command).toMatchObject({ response: { ok: true, result: { method: "commands.register", id: "pude.example.run" } } });
    expect(notification).toMatchObject({ response: { ok: true, result: { method: "ui.notify", message: "Saved" } } });
  });

  it("rejects malformed parameters and invalid request IDs while allowing completed IDs to be reused", async () => {
    const { host } = createHost();
    const invalidParams = await host.handle(request("pude_1", "commands.register", { id: "valid", extra: true }), frame, token);
    const invalidId = await host.handle(request("has spaces"), frame, token);
    const invalidVersion = await host.handle({ ...request("pude_version"), protocolVersion: 1 }, frame, token);
    const first = await host.handle(request("pude_2"), frame, token);
    const repeated = await host.handle(request("pude_2"), frame, token);

    expect(invalidParams).toMatchObject({ accepted: true, response: { ok: false, error: { code: "protocol.invalid_params" } } });
    expect(invalidId).toMatchObject({ accepted: true, response: { requestId: null, error: { code: "protocol.invalid_request_id" } } });
    expect(invalidVersion).toMatchObject({ accepted: true, response: { error: { code: "protocol.unsupported_version" } } });
    expect(first).toMatchObject({ accepted: true, response: { ok: true } });
    expect(repeated).toMatchObject({ accepted: true, response: { requestId: "pude_2", ok: true } });
  });

  it("requires both a declared permission and a positive grant decision", async () => {
    const noEditorRead = { ...createContext().installedPlugin!, permissions: ["commands.register"] as PluginApiV2InstalledPlugin["permissions"] };
    const undeclared = createHost({ context: { expectedPlugin: noEditorRead, installedPlugin: noEditorRead } });
    const undeclaredResult = await undeclared.host.handle(request(), frame, token);
    expect(undeclaredResult).toMatchObject({ accepted: true, response: { error: { code: "permission.not_declared" } } });
    expect(undeclared.execute).not.toHaveBeenCalled();

    const denied = createHost({ resolvePermission: () => false });
    const deniedResult = await denied.host.handle(request(), frame, token);
    expect(deniedResult).toMatchObject({ accepted: true, response: { error: { code: "permission.denied" } } });
    expect(denied.execute).not.toHaveBeenCalled();
  });

  it("maps every API method to its single declared permission", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["editor.getText", {}, "editor.read"],
      ["editor.getTextRange", { revision: 1, from: 0, to: 4 }, "editor.read"],
      ["editor.getSelection", {}, "editor.read"],
      ["editor.getCursor", {}, "editor.read"],
      ["editor.getFileInfo", {}, "editor.read"],
      ["editor.applyEdits", { revision: 0, edits: [{ from: 0, to: 0, insert: "x" }] }, "editor.write"],
      ["workspace.list", {}, "workspace.read"],
      ["workspace.readFile", { path: "src/main.ts" }, "workspace.read"],
      ["workspace.getFileInfo", { path: "src/main.ts" }, "workspace.read"],
      ["workspace.readFileRange", { path: "src/main.ts", revision: "revision-1", offsetBytes: 0, maxBytes: 128 * 1024 }, "workspace.read"],
      ["workspace.releaseFileRead", { path: "src/main.ts", revision: "revision-1" }, "workspace.read"],
      ["workspace.writeFile", { path: "src/new.ts", content: "new" }, "workspace.write"],
      ["commands.register", { id: "pude.example.run" }, "commands.register"],
      ["ui.notify", { message: "Done" }, "ui.notification"],
      ["ui.statusBar.set", { id: "state", text: "Ready" }, "ui.statusBar"],
      ["ui.statusBar.remove", { id: "state" }, "ui.statusBar"],
      ["ui.quickPick", { items: [{ id: "one", label: "One" }] }, "ui.quickPick"],
      ["git.getStatus", {}, "git.read"],
      ["git.getDiff", { path: "src/main.ts" }, "git.read"],
      ["terminal.write", { data: "ls\n" }, "terminal.write"],
      ["network.fetch", { url: "https://api.example.com/v1" }, "network"],
    ];
    const permissions = cases.map(([, , permission]) => permission);
    const plugin = { ...createContext().installedPlugin!, permissions: [...new Set(permissions)] as PluginApiV2InstalledPlugin["permissions"] };
    const context = createContext({ expectedPlugin: plugin, installedPlugin: plugin });
    const resolved: Array<[string, string | undefined]> = [];
    let now = 0;
    const host = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: (_plugin, permission, scope) => {
        resolved.push([permission, scope.resourceScope?.kind === "domain" ? scope.resourceScope.value : undefined]);
        return true;
      },
      execute: (method) => method,
      now: () => now,
    });

    for (const [index, [method, params]] of cases.entries()) {
      if (index > 0 && index % 20 === 0) now += 1_000;
      const result = await host.handle(request(`case_${index}`, method, params), frame, token);
      expect(result).toMatchObject({ accepted: true, response: { ok: true, result: method } });
    }
    expect(resolved).toContainEqual(["network", "api.example.com"]);
    expect(resolved.map(([permission]) => permission)).toEqual(permissions);
  });

  it("rejects undeclared commands and invalid network targets before dispatch", async () => {
    const execute = vi.fn(() => "must not run");
    const { host } = createHost({ execute });
    const undeclaredCommand = await host.handle(request("command_1", "commands.register", { id: "pude.example.missing" }), frame, token);
    const nonHttps = await host.handle(request("network_1", "network.fetch", { url: "http://api.example.com/data" }), frame, token);
    const undeclaredDomain = await host.handle(request("network_2", "network.fetch", { url: "https://other.example.com/data" }), frame, token);

    expect(undeclaredCommand).toMatchObject({ response: { error: { code: "manifest.command_not_declared" } } });
    expect(nonHttps).toMatchObject({ response: { error: { code: "network.invalid_url" } } });
    expect(undeclaredDomain).toMatchObject({ response: { error: { code: "permission.domain_not_declared" } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds LSP operations to the exact declared server, executable, arguments, and workspace", async () => {
    const lspServer = {
      serverId: "rust-analyzer",
      language: "rust",
      executable: "/usr/local/bin/rust-analyzer",
      args: ["--stdio", "--log-file=/tmp/rust-analyzer.log"],
    };
    const plugin: PluginApiV2InstalledPlugin = {
      ...createContext().installedPlugin!,
      permissions: ["process.spawn:lsp"],
      lspServers: [lspServer],
    };
    const context = createContext({ expectedPlugin: plugin, installedPlugin: plugin });
    const resolvedScopes: Array<{ method: string; permission: string; scope: unknown }> = [];
    const execute = vi.fn((method: string, _params: Record<string, unknown>, _context: PluginApiV2ExecutionContext) => method);
    const host = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: (_plugin, permission, scope) => {
        resolvedScopes.push({ method: "", permission, scope });
        return true;
      },
      execute: (method, params, operationContext) => {
        const latest = resolvedScopes[resolvedScopes.length - 1];
        if (latest) latest.method = method;
        return execute(method, params, operationContext);
      },
    });
    const cases = [
      ["lsp.start", { serverId: "rust-analyzer" }],
      ["lsp.send", { serverId: "rust-analyzer", message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } }],
      ["lsp.cancel", { serverId: "rust-analyzer", requestId: 1 }],
      ["lsp.stop", { serverId: "rust-analyzer" }],
    ] as const;

    for (const [method, params] of cases) {
      const response = await host.handle(request(`lsp_${method.slice(4)}`, method, params), frame, token);
      expect(response).toMatchObject({ accepted: true, response: { ok: true, result: method } });
    }

    expect(execute).toHaveBeenCalledTimes(cases.length);
    expect(resolvedScopes).toEqual(cases.map(([method]) => ({
      method,
      permission: "process.spawn:lsp",
      scope: {
        workspaceRoot: "/work/project",
        resourceScope: {
          kind: "executable",
          serverId: "rust-analyzer",
          language: "rust",
          executablePath: "/usr/local/bin/rust-analyzer",
          args: ["--stdio", "--log-file=/tmp/rust-analyzer.log"],
        },
      },
    })));
  });

  it("rejects undeclared or malformed LSP servers and denied process grants before dispatch", async () => {
    const lspServer = {
      serverId: "rust-analyzer",
      language: "rust",
      executable: "/usr/local/bin/rust-analyzer",
      args: ["--stdio"],
    };
    const plugin: PluginApiV2InstalledPlugin = {
      ...createContext().installedPlugin!,
      permissions: ["process.spawn:lsp"],
      lspServers: [lspServer],
    };
    const context = createContext({ expectedPlugin: plugin, installedPlugin: plugin });
    const execute = vi.fn(() => "must not run");
    const denied = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: () => false,
      execute,
    });
    const undeclared = await denied.handle(request("lsp_missing", "lsp.start", { serverId: "typescript" }), frame, token);
    const malformed = await denied.handle(request("lsp_bad", "lsp.send", { serverId: "rust-analyzer", message: { jsonrpc: "1.0", method: "initialize" } }), frame, token);
    const deniedStart = await denied.handle(request("lsp_denied", "lsp.start", { serverId: "rust-analyzer" }), frame, token);
    const duplicatePlugin: PluginApiV2InstalledPlugin = { ...plugin, lspServers: [lspServer, lspServer] };
    const duplicate = createPluginApiV2Host({
      getContext: () => createContext({ expectedPlugin: duplicatePlugin, installedPlugin: duplicatePlugin }),
      resolvePermission: () => true,
      execute,
    });
    const duplicateServer = await duplicate.handle(request("lsp_duplicate", "lsp.start", { serverId: "rust-analyzer" }), frame, token);

    expect(undeclared).toMatchObject({ response: { error: { code: "manifest.lsp_not_declared" } } });
    expect(malformed).toMatchObject({ response: { error: { code: "protocol.invalid_params" } } });
    expect(deniedStart).toMatchObject({ response: { error: { code: "permission.denied" } } });
    expect(duplicateServer).toMatchObject({ response: { error: { code: "manifest.lsp_not_declared" } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths, stale edits, oversized UI content, and privileged network headers", async () => {
    const { host, execute } = createHost();
    const invalidRequests: Array<[string, string, Record<string, unknown>]> = [
      ["bad_path_1", "workspace.readFile", { path: "../secret.txt" }],
      ["bad_path_2", "workspace.writeFile", { path: "src\\secret.txt", content: "x" }],
      ["bad_editor_range", "editor.getTextRange", { revision: 1, from: 0, to: 128 * 1024 + 1 }],
      ["bad_workspace_range", "workspace.readFileRange", { path: "src/main.ts", revision: "r1", offsetBytes: 0, maxBytes: 128 * 1024 + 1 }],
      ["bad_workspace_release", "workspace.releaseFileRead", { path: "src/main.ts", revision: "" }],
      ["bad_edit", "editor.applyEdits", { revision: -1, edits: [] }],
      ["bad_edit_overlap", "editor.applyEdits", { revision: 0, edits: [{ from: 0, to: 3, insert: "a" }, { from: 2, to: 4, insert: "b" }] }],
      ["bad_edit_order", "editor.applyEdits", { revision: 0, edits: [{ from: 3, to: 4, insert: "b" }, { from: 0, to: 1, insert: "a" }] }],
      ["bad_status", "ui.statusBar.set", { id: "state", text: "x".repeat(121) }],
      ["bad_header", "network.fetch", { url: "https://api.example.com", headers: { Cookie: "session=secret" } }],
    ];
    for (const [id, method, params] of invalidRequests) {
      expect(await host.handle(request(id, method, params), frame, token)).toMatchObject({
        accepted: true,
        response: { error: { code: "protocol.invalid_params" } },
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("limits request rate and structured message sizes before host operations", async () => {
    const { host, execute } = createHost();
    const oversized = await host.handle(request("large_1", "ui.notify", { message: "x".repeat(70_000) }), frame, token);
    expect(oversized).toMatchObject({ response: { error: { code: "protocol.message_too_large" } } });
    expect(execute).not.toHaveBeenCalled();

    const results = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      host.handle(request(`rate_${index}`, "editor.getText"), frame, token)));
    expect(results.slice(0, 20).every((result) => result.accepted && result.response.ok)).toBe(true);
    expect(results[20]).toMatchObject({ response: { error: { code: "protocol.rate_limit" } } });
    expect(execute).toHaveBeenCalledTimes(20);

    const largeResponseHost = createPluginApiV2Host({
      getContext: () => createContext(),
      resolvePermission: () => true,
      execute: () => "x".repeat(1024 * 1024),
    });
    expect(await largeResponseHost.handle(request("large_response", "commands.register", { id: "pude.example.run" }), frame, token)).toMatchObject({
      response: { error: { code: "protocol.response_too_large" } },
    });
  });

  it("returns range-specific errors for oversized one-shot editor and workspace reads", async () => {
    const plugin: PluginApiV2InstalledPlugin = {
      ...createContext().installedPlugin!,
      permissions: ["editor.read", "workspace.read"],
    };
    const oversizedText = "x".repeat(128 * 1024 + 1);
    const host = createPluginApiV2Host({
      getContext: () => createContext({ expectedPlugin: plugin, installedPlugin: plugin }),
      resolvePermission: () => true,
      execute: (method) => method === "editor.getText" ? oversizedText : { path: "src/main.ts", content: oversizedText },
    });

    await expect(host.handle(request("large_editor", "editor.getText"), frame, token)).resolves.toMatchObject({
      response: { error: { code: "editor.range_required" } },
    });
    await expect(host.handle(request("large_workspace", "workspace.readFile", { path: "src/main.ts" }), frame, token)).resolves.toMatchObject({
      response: { error: { code: "workspace.file_requires_ranges" } },
    });
  });

  it("handles 10,000 requests in one retained host run without retaining completed IDs", async () => {
    let now = 0;
    const { host, execute } = createHost({ now: () => now });
    for (let index = 0; index < 10_000; index += 1) {
      if (index > 0 && index % 20 === 0) now += 1_000;
      const result = await host.handle(request(`long_run_${index + 1}`), frame, token);
      expect(result).toMatchObject({ accepted: true, response: { ok: true } });
    }

    expect(execute).toHaveBeenCalledTimes(10_000);
    expect(host.pendingCount).toBe(0);
    expect(PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS).toBe(512);
  });

  it("assigns native cancellation keys independently of caller-controlled request IDs", async () => {
    const nativeRequestIds: string[] = [];
    const { host } = createHost({
      execute: (_method, _params, context) => {
        nativeRequestIds.push(context.nativeRequestId);
        return "done";
      },
    });
    await host.handle(request("caller-chosen"), frame, token);
    await host.handle(request("caller-chosen"), frame, token);

    expect(nativeRequestIds).toHaveLength(2);
    expect(new Set(nativeRequestIds).size).toBe(2);
    expect(nativeRequestIds.every((requestId) => requestId.startsWith("pude_native_") && requestId !== "caller-chosen")).toBe(true);
  });

  it("ignores duplicate in-flight IDs without resolving the earlier request, then allows reuse after completion", async () => {
    let markStarted!: () => void;
    let markSecondStarted!: () => void;
    const finishers: Array<(value: string) => void> = [];
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const execute = vi.fn(() => new Promise<string>((resolve) => {
      finishers.push(resolve);
      if (finishers.length === 1) markStarted();
      if (finishers.length === 2) markSecondStarted();
    }));
    const { host } = createHost({ execute });
    const first = host.handle(request("reused_id"), frame, token);
    await started;

    expect(await host.handle(request("reused_id"), frame, token)).toEqual({ accepted: false });
    expect(execute).toHaveBeenCalledOnce();
    finishers[0]("first result");
    await expect(first).resolves.toMatchObject({ response: { requestId: "reused_id", ok: true, result: "first result" } });

    const second = host.handle(request("reused_id"), frame, token);
    await secondStarted;
    expect(execute).toHaveBeenCalledTimes(2);
    finishers[1]("second result");
    await expect(second).resolves.toMatchObject({ response: { requestId: "reused_id", ok: true, result: "second result" } });
  });

  it("bounds simultaneous API requests and clears their tracking on stop", async () => {
    let now = 0;
    const requests: Array<Promise<unknown>> = [];
    const { host } = createHost({
      now: () => now,
      execute: () => new Promise(() => undefined),
    });
    for (let index = 0; index < PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS; index += 1) {
      if (index > 0 && index % 20 === 0) now += 1_000;
      requests.push(host.handle(request(`pending_${index + 1}`), frame, token));
    }
    expect(host.pendingCount).toBe(PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS);
    now += 1_000;
    expect(await host.handle(request("over_capacity"), frame, token)).toMatchObject({
      response: { error: { code: "protocol.in_flight_limit", retryable: true } },
    });

    host.stop();
    await expect(Promise.all(requests)).resolves.toHaveLength(PLUGIN_API_V2_MAX_IN_FLIGHT_REQUESTS);
    expect(host.pendingCount).toBe(0);
  });

  it("rechecks authorization immediately before a host operation and aborts it when stopped", async () => {
    let granted = true;
    let executionContext: Parameters<NonNullable<Parameters<typeof createPluginApiV2Host>[0]["execute"]>>[2] | undefined;
    const context = createContext();
    const host = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: () => granted,
      execute: async (_method, _params, operationContext) => {
        executionContext = operationContext;
        granted = false;
        await operationContext.authorize();
        return "should not be reached";
      },
    });
    const revoked = await host.handle(request(), frame, token);
    expect(revoked).toMatchObject({ response: { error: { code: "permission.denied" } } });
    expect(executionContext?.signal.aborted).toBe(false);

    let resume!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const waitingHost = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: () => true,
      execute: (_method, _params, operationContext) => new Promise((resolve) => {
        executionContext = operationContext;
        markStarted();
        resume = () => resolve("late result");
      }),
    });
    const waiting = waitingHost.handle(request("wait_1"), frame, token);
    await started;
    waitingHost.stop();
    expect(executionContext?.signal.aborted).toBe(true);
    resume();
    expect(await waiting).toEqual({ accepted: false });
  });

  it("aborts a host operation at its deadline and returns a structured timeout", async () => {
    vi.useFakeTimers();
    try {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let signal: AbortSignal | undefined;
      const { host } = createHost({
        execute: (_method, _params, context) => {
          signal = context.signal;
          markStarted();
          return new Promise(() => undefined);
        },
      });
      const requestPromise = host.handle(request("timeout_1"), frame, token);
      await started;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(signal?.aborted).toBe(true);
      expect(await requestPromise).toMatchObject({ response: { error: { code: "host.operation_timeout", retryable: true } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects changed workspace and disabled or changed installation context", async () => {
    const changedWorkspace = createHost({ context: { workspaceRoot: "/work/other" } });
    const workspaceResult = await changedWorkspace.host.handle(request(), frame, token);
    const changedGeneration = createHost({ context: { workspaceGeneration: 8 } });
    const generationResult = await changedGeneration.host.handle(request(), frame, token);
    const disabled = createHost({ context: { installedPlugin: { ...createContext().installedPlugin!, enabled: false } } });
    const disabledResult = await disabled.host.handle(request(), frame, token);
    const changedManifest = createHost({ context: { installedPlugin: { ...createContext().installedPlugin!, version: "2.0.0" } } });
    const manifestResult = await changedManifest.host.handle(request(), frame, token);

    expect(workspaceResult).toMatchObject({ accepted: true, response: { error: { code: "workspace.context_changed" } } });
    expect(generationResult).toMatchObject({ accepted: true, response: { error: { code: "workspace.context_changed" } } });
    expect(disabledResult).toMatchObject({ accepted: true, response: { error: { code: "plugin.disabled" } } });
    expect(manifestResult).toMatchObject({ accepted: true, response: { error: { code: "plugin.not_installed" } } });
  });

  it("ignores invalid sources and returns structured operation errors", async () => {
    const hostWithFailure = createHost({ execute: () => { throw new Error("private implementation detail"); } });
    const invalidSource = await hostWithFailure.host.handle(request(), {}, token);
    const invalidToken = await hostWithFailure.host.handle(request(), frame, "wrong-token");
    const operationFailure = await hostWithFailure.host.handle(request(), frame, token);

    expect(invalidSource).toEqual({ accepted: false });
    expect(invalidToken).toEqual({ accepted: false });
    expect(operationFailure).toMatchObject({ accepted: true, response: { ok: false, error: { code: "host.operation_failed", message: "Plugin API operation failed.", retryable: true } } });
    expect(JSON.stringify(operationFailure)).not.toContain("private implementation detail");
  });

  it("clears in-flight requests when stopped", async () => {
    let resolvePermission!: (granted: boolean) => void;
    const { host } = createHost({
      resolvePermission: () => new Promise<boolean>((resolve) => { resolvePermission = resolve; }),
    });
    const requestPromise = host.handle(request(), frame, token);
    await Promise.resolve();
    expect(host.pendingCount).toBe(1);

    host.stop();
    resolvePermission(true);
    expect(await requestPromise).toEqual({ accepted: false });
    expect(host.pendingCount).toBe(0);
    expect(await host.handle(request("pude_2"), frame, token)).toEqual({ accepted: false });
  });

  it("rechecks workspace and manifest context after asynchronous grant resolution", async () => {
    const context = createContext();
    const execute = vi.fn(() => "should not execute");
    const host = createPluginApiV2Host({
      getContext: () => context,
      resolvePermission: () => {
        context.workspaceGeneration += 1;
        return true;
      },
      execute,
    });
    const result = await host.handle(request(), frame, token);

    expect(result).toMatchObject({ accepted: true, response: { error: { code: "workspace.context_changed" } } });
    expect(execute).not.toHaveBeenCalled();
  });
});
