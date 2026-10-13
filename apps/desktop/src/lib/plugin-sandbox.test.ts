import tauriConfig from "../../src-tauri/tauri.conf.json";
import { describe, expect, it } from "vitest";
import {
  createPluginSandboxBootstrap,
  createPluginSandboxDocument,
  createPluginWorkerSource,
  createPluginWorkerV2Source,
  PLUGIN_SANDBOX_CSP,
  PLUGIN_SANDBOX_BOOTSTRAP_HASH,
  PLUGIN_SANDBOX_FLAGS,
} from "./plugin-sandbox";

function createSandboxHarness() {
  const parentMessages: any[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const workerMessages: unknown[] = [];
  const parent = { postMessage: (message: unknown) => parentMessages.push(message) };
  const window = { addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener) };
  let worker: {
    onmessage?: (event: { data: unknown }) => void;
    postMessage: (message: unknown) => void;
    terminate: () => void;
    terminated: boolean;
  } | undefined;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    terminated = false;

    constructor() {
      worker = this;
    }

    postMessage(message: unknown) {
      workerMessages.push(message);
    }

    terminate() {
      this.terminated = true;
    }
  }
  class FakeBlob {
    constructor(readonly parts: unknown[], readonly options: unknown) {}
  }
  const fakeUrl = {
    createObjectURL: () => "blob:worker-test",
    revokeObjectURL: () => undefined,
  };
  const run = new Function(
    "window",
    "document",
    "parent",
    "URL",
    "Blob",
    "Worker",
    "setTimeout",
    "clearTimeout",
    "location",
    "performance",
    createPluginSandboxBootstrap(),
  );
  run(window, { currentScript: { dataset: { token: "test-token" } } }, parent, fakeUrl, FakeBlob, FakeWorker, () => 1, () => undefined, { origin: "null" }, { now: () => 0 });
  const dispatch = listeners.get("message")!;
  dispatch({ source: parent, data: { type: "start", token: "test-token", source: "", apiVersion: 2 } });
  return {
    parentMessages,
    workerMessages,
    get worker() { return worker!; },
    sendWorkerMessage(data: unknown) { worker!.onmessage!({ data }); },
  };
}

describe("plugin sandbox boundary", () => {
  it("uses scripts without restoring the host origin", () => {
    expect(PLUGIN_SANDBOX_FLAGS).toBe("allow-scripts");
    expect(PLUGIN_SANDBOX_FLAGS).not.toContain("allow-same-origin");
    const bootstrap = createPluginSandboxBootstrap();
    const document = createPluginSandboxDocument("test-token");
    expect(PLUGIN_SANDBOX_CSP).toContain("connect-src 'none'");
    expect(PLUGIN_SANDBOX_CSP).toContain("script-src blob:");
    expect(PLUGIN_SANDBOX_CSP).toContain("worker-src blob:");
    expect(PLUGIN_SANDBOX_CSP).not.toContain("ipc:");
    expect(document).toContain(`content="${PLUGIN_SANDBOX_CSP}"`);
    expect(document).toContain(`<script data-token="test-token">${bootstrap}</script>`);
    expect(document).not.toContain("<script src=");
    expect(bootstrap).toContain("const token = document.currentScript.dataset.token;");
    expect(bootstrap).toContain("new Worker");
    expect(bootstrap).toContain("URL.revokeObjectURL(workerUrl)");
    expect(bootstrap).toContain('location.origin === "null"');
    expect(bootstrap).toContain("parent.postMessage");
    expect(bootstrap).toContain('message.type === "api-response"');
    expect(bootstrap).toContain("worker?.postMessage(message.response)");
    expect(bootstrap).toContain('worker.postMessage({ type: "api-stop", protocolVersion: 2 })');

  });

  it("authorizes only the exact inline bootstrap in production and development CSP", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(createPluginSandboxBootstrap()));
    const hash = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
    expect(PLUGIN_SANDBOX_BOOTSTRAP_HASH).toBe(hash);
    for (const csp of [PLUGIN_SANDBOX_CSP, tauriConfig.app.security.csp, tauriConfig.app.security.devCsp]) {
      const scriptPolicy = csp.split(";").find((directive) => directive.trim().startsWith("script-src "))!;
      expect(scriptPolicy).toContain(`'${hash}'`);
      expect(scriptPolicy).not.toContain("'unsafe-inline'");
    }
    const token = '\"><script>parent.pwned=true</script>';
    const sandbox = createPluginSandboxDocument(token);
    expect(sandbox).toContain('data-token="&quot;&gt;&lt;script&gt;parent.pwned=true&lt;/script&gt;"');
    expect(sandbox.match(/<script/g)).toHaveLength(1);
  });

  it("omits editor capabilities when the host does not grant editor.read", () => {
    const source = createPluginWorkerSource({ pluginSource: "self.postMessage({ type: 'ready' });", editorText: "", facadeSource: "", activationCommand: "activate" });
    expect(source).toContain("const pude = {");
    expect(source).not.toContain("editor:");
    expect(source).toContain("const editorText = \"\";");
  });

  it("preserves API 1 synchronous facade and status-message behavior", () => {
    const source = createPluginWorkerSource({
      pluginSource: "pude.commands.register('example.run', () => pude.ui.notify(editorText));",
      editorText: "legacy text",
      facadeSource: "editor: { getText: () => editorText }, commands: { register: (id, handler) => commandHandlers.set(id, handler) }, ui: { notify: sendStatus },",
      activationCommand: "example.run",
    });
    expect(source).toContain('const editorText = "legacy text";');
    expect(source).toContain("commands: { register: (id, handler) => commandHandlers.set(id, handler) }");
    expect(source).toContain("ui: { notify: sendStatus }");
    expect(source).not.toContain("protocolVersion: 2");
  });

  it("registers host events and dispatches only the matching event payload", async () => {
    const messages: any[] = [];
    const worker = {
      postMessage: (message: unknown) => messages.push(message),
      received: [] as unknown[],
    } as { postMessage: (message: unknown) => void; received: unknown[]; onmessage?: (event: { data: unknown }) => void; unsubscribe?: () => void };
    const source = createPluginWorkerSource({
      pluginSource: "self.unsubscribe = pude.events.on('onFileOpen', (payload) => self.received.push(payload.file.path));",
      editorText: "",
      facadeSource: "",
      activationCommand: "example.run",
    });
    new Function("self", source)(worker);
    expect(messages).toContainEqual({ type: "subscriptions", events: ["onFileOpen"] });
    worker.onmessage!({ data: { type: "host-event", event: "onFileSave", payload: { file: { path: "ignored.ts" } } } });
    worker.onmessage!({ data: { type: "host-event", event: "onFileOpen", payload: { file: { path: "opened.ts" } } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.received).toEqual(["opened.ts"]);
    expect(messages).toContainEqual({ type: "event-done", event: "onFileOpen" });
    worker.unsubscribe!();
    expect(messages.at(-1)).toEqual({ type: "subscriptions", events: [] });
  });

  it("runs a registered command on first use and every later invocation, then releases its one-shot Worker", async () => {
    const messages: any[] = [];
    const worker = {
      calls: [] as string[],
      postMessage: (message: unknown) => messages.push(message),
    } as { calls: string[]; postMessage: (message: unknown) => void; onmessage?: (event: { data: unknown }) => void };
    const source = createPluginWorkerSource({
      pluginSource: "pude.commands.register('pude.example.run', () => self.calls.push('run'));",
      editorText: "",
      facadeSource: "commands: { register: (id, handler) => { commandHandlers.set(id, handler); self.postMessage({ type: 'commands', commands: [...commandHandlers.keys()] }); } },",
      activationCommand: "pude.example.run",
    });

    new Function("self", source)(worker);
    expect(messages).toContainEqual({ type: "commands", commands: ["pude.example.run"] });
    expect(messages).toContainEqual({ type: "ready" });
    worker.onmessage!({ data: { type: "command", command: "pude.example.run" } });
    await Promise.resolve();
    worker.onmessage!({ data: { type: "command", command: "pude.example.run" } });
    await Promise.resolve();

    expect(worker.calls).toEqual(["run", "run"]);
    expect(messages.filter((message) => message.type === "command-done")).toHaveLength(2);
    expect(messages.filter((message) => message.type === "done")).toHaveLength(2);
  });

  it("keeps an event Worker alive across deliveries until its last subscription is removed", async () => {
    const messages: any[] = [];
    const worker = {
      paths: [] as string[],
      postMessage: (message: unknown) => messages.push(message),
    } as { paths: string[]; postMessage: (message: unknown) => void; onmessage?: (event: { data: unknown }) => void; stopListening?: () => void };
    const source = createPluginWorkerSource({
      pluginSource: "self.stopListening = pude.events.on('onFileOpen', (payload) => self.paths.push(payload.file.path));",
      editorText: "",
      facadeSource: "",
      activationCommand: "activate",
    });

    new Function("self", source)(worker);
    worker.onmessage!({ data: { type: "host-event", event: "onFileOpen", payload: { file: { path: "first.ts" } } } });
    await Promise.resolve();
    worker.onmessage!({ data: { type: "host-event", event: "onFileOpen", payload: { file: { path: "second.ts" } } } });
    await Promise.resolve();
    expect(worker.paths).toEqual(["first.ts", "second.ts"]);
    expect(messages.some((message) => message.type === "done")).toBe(false);

    worker.stopListening!();
    expect(messages.at(-1)).toEqual({ type: "subscriptions", events: [] });
  });

  it("gives API 2 a postMessage-only facade and rejects pending requests on stop", async () => {
    const messages: unknown[] = [];
    const worker = {
      close: () => messages.push({ closed: true }),
      postMessage: (message: unknown) => messages.push(message),
    } as { close: () => void; postMessage: (message: unknown) => void; pude?: any; onmessage?: (event: { data: unknown }) => void };
    const workerSource = createPluginWorkerV2Source({ pluginSource: "" });
    new Function("self", workerSource)(worker);
    expect(workerSource).not.toMatch(/__TAURI_INTERNALS__|invoke\s*\(/);
    await Promise.resolve();

    const editorRequest = worker.pude!.editor.getText() as Promise<string>;
    expect(messages[0]).toEqual({ type: "ready" });
    expect(messages[1]).toMatchObject({ type: "api-request", protocolVersion: 2, requestId: "pude_1", method: "editor.getText", params: {} });
    expect(workerSource).not.toMatch(/\b(?:tauri|document|CodeMirror)\b/i);
    worker.onmessage!({ data: { type: "api-response", protocolVersion: 2, requestId: "pude_1", ok: true, result: "workspace text" } });
    await expect(editorRequest).resolves.toBe("workspace text");
    const registration = worker.pude!.commands.register("example.run", () => {}) as Promise<unknown>;
    expect(messages[2]).toMatchObject({ type: "api-request", protocolVersion: 2, requestId: "pude_2", method: "commands.register", params: { id: "example.run" } });
    expect(JSON.stringify(messages[2])).not.toContain("handler");
    worker.onmessage!({ data: { type: "api-response", protocolVersion: 2, requestId: "pude_2", ok: true, result: { registered: true } } });
    await expect(registration).resolves.toEqual({ registered: true });
    const pending = worker.pude!.ui.notify("pending") as Promise<unknown>;
    worker.onmessage!({ data: { type: "api-stop", protocolVersion: 2 } });
    await expect(pending).rejects.toThrow("Plugin stopped.");
    expect(messages.at(-2)).toEqual({ type: "api-stopped", protocolVersion: 2 });
    expect(messages.at(-1)).toEqual({ closed: true });
  });

  it("preserves retryable API errors and handles failed command registration", async () => {
    const messages: any[] = [];
    const worker = {
      postMessage: (message: unknown) => messages.push(message),
    } as { postMessage: (message: unknown) => void; pude?: any; onmessage?: (event: { data: unknown }) => void; registrationError?: { code: string; retryable: boolean } };
    const source = createPluginWorkerV2Source({
      pluginSource: "pude.commands.register('example.run', () => {}).catch((error) => { self.registrationError = { code: error.code, retryable: error.retryable }; });",
    });
    new Function("self", source)(worker);
    await Promise.resolve();
    const request = messages.find((message) => message.type === "api-request");
    expect(request).toMatchObject({ method: "commands.register" });

    worker.onmessage!({ data: {
      type: "api-response",
      protocolVersion: 2,
      requestId: request.requestId,
      ok: false,
      error: { code: "permission.denied", message: "Permission required.", retryable: true },
    } });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.registrationError).toEqual({ code: "permission.denied", retryable: true });
    expect(messages.find((message) => message.type === "error")).toMatchObject({ type: "error", text: "Permission required." });
    expect(messages.some((message) => message.type === "ready")).toBe(false);
  });

  it("exposes each API 2 capability through a protocol request", async () => {
    const messages: any[] = [];
    const worker = {
      close: () => undefined,
      postMessage: (message: unknown) => messages.push(message),
    } as { close: () => void; postMessage: (message: unknown) => void; pude?: any; onmessage?: (event: { data: unknown }) => void };
    new Function("self", createPluginWorkerV2Source({ pluginSource: "" }))(worker);
    await Promise.resolve();

    const api = worker.pude!;
    const pending = [
      api.editor.getText(),
      api.editor.getTextRange(7, 0, 5),
      api.editor.getSelection(),
      api.editor.getCursor(),
      api.editor.getFileInfo(),
      api.editor.applyEdits(7, [{ from: 0, to: 0, insert: "hello" }]),
      api.workspace.list({ path: "src" }),
      api.workspace.readFile({ path: "src/main.rs" }),
      api.workspace.getFileInfo({ path: "src/main.rs" }),
      api.workspace.readFileRange({ path: "src/main.rs", revision: "revision-1", offsetBytes: 0, maxBytes: 128 * 1024 }),
      api.workspace.releaseFileRead({ path: "src/main.rs", revision: "revision-1" }),
      api.workspace.writeFile({ path: "src/main.rs", content: "safe", expectedFingerprint: "0123456789abcdef" }),
      api.commands.register("example.run", () => undefined),
      api.ui.notify("hello"),
      api.ui.statusBar.set("status", "Ready", "Plugin is ready"),
      api.ui.statusBar.remove("status"),
      api.ui.quickPick({ items: [{ id: "one", label: "One" }] }),
      api.git.getStatus(),
      api.git.getDiff({ path: "src/main.rs", staged: false }),
      api.terminal.write({ data: "\n" }),
      api.network.fetch({ url: "https://api.example.com/data", method: "GET" }),
      api.lsp.start("rust-analyzer"),
      api.lsp.send("rust-analyzer", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      api.lsp.cancel("rust-analyzer", 1),
      api.lsp.stop("rust-analyzer"),
    ];
    const requests = messages.filter((message) => message.type === "api-request");
    expect(requests.map((message) => message.method)).toEqual([
      "editor.getText",
      "editor.getTextRange",
      "editor.getSelection",
      "editor.getCursor",
      "editor.getFileInfo",
      "editor.applyEdits",
      "workspace.list",
      "workspace.readFile",
      "workspace.getFileInfo",
      "workspace.readFileRange",
      "workspace.releaseFileRead",
      "workspace.writeFile",
      "commands.register",
      "ui.notify",
      "ui.statusBar.set",
      "ui.statusBar.remove",
      "ui.quickPick",
      "git.getStatus",
      "git.getDiff",
      "terminal.write",
      "network.fetch",
      "lsp.start",
      "lsp.send",
      "lsp.cancel",
      "lsp.stop",
    ]);
    expect(requests[1].params).toEqual({ revision: 7, from: 0, to: 5 });
    expect(requests[9].params).toEqual({ path: "src/main.rs", revision: "revision-1", offsetBytes: 0, maxBytes: 128 * 1024 });
    expect(requests[10].params).toEqual({ path: "src/main.rs", revision: "revision-1" });
    expect(requests[11].params.expectedFingerprint).toBe("0123456789abcdef");
    for (const request of requests) {
      worker.onmessage!({ data: { type: "api-response", protocolVersion: 2, requestId: request.requestId, ok: true, result: null } });
    }
    expect(requests[21].params).toEqual({ serverId: "rust-analyzer" });
    expect(requests[22].params).toEqual({ serverId: "rust-analyzer", message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(requests[23].params).toEqual({ serverId: "rust-analyzer", requestId: 1 });
    await expect(Promise.all(pending)).resolves.toHaveLength(25);
  });

  it("delivers declared LSP host events through the Worker event facade", async () => {
    const messages: any[] = [];
    const worker = {
      postMessage: (message: unknown) => messages.push(message),
      received: [] as unknown[],
    } as { postMessage: (message: unknown) => void; received: unknown[]; onmessage?: (event: { data: unknown }) => void };
    const source = createPluginWorkerV2Source({
      pluginSource: "pude.events.on('lsp.message', (event) => self.received.push(event.message.id));",
    });
    new Function("self", source)(worker);
    await Promise.resolve();

    expect(messages).toContainEqual({ type: "subscriptions", events: ["lsp.message"] });
    worker.onmessage!({ data: {
      type: "host-event",
      event: "lsp.message",
      payload: { serverId: "rust-analyzer", message: { jsonrpc: "2.0", id: 7, result: null } },
    } });
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.received).toEqual([7]);
    expect(messages).toContainEqual({ type: "event-done", event: "lsp.message" });
  });

  it("rejects oversized or cyclic Worker messages before forwarding them to the host", () => {
    const sandbox = createSandboxHarness();
    const oversized = { type: "status", text: "x".repeat(64 * 1024) };
    sandbox.sendWorkerMessage(oversized);
    const workerMessages = sandbox.parentMessages.filter((message) => message.type === "worker-message");
    expect(workerMessages).toHaveLength(0);
    expect(sandbox.parentMessages.at(-1)).toMatchObject({ type: "worker-error" });
    expect(sandbox.worker.terminated).toBe(true);

    const cyclicSandbox = createSandboxHarness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclicSandbox.sendWorkerMessage(cyclic);
    expect(cyclicSandbox.parentMessages.filter((message) => message.type === "worker-message")).toHaveLength(0);
    expect(cyclicSandbox.parentMessages.at(-1)).toMatchObject({ type: "worker-error" });
  });

  it("stops a Worker that exceeds the host-forwarding rate budget", () => {
    const sandbox = createSandboxHarness();
    for (let index = 0; index < 21; index += 1) {
      sandbox.sendWorkerMessage({ type: "status", text: `message-${index}` });
    }
    expect(sandbox.parentMessages.filter((message) => message.type === "worker-message")).toHaveLength(20);
    expect(sandbox.parentMessages.at(-1)).toMatchObject({ type: "worker-error" });
    expect(sandbox.worker.terminated).toBe(true);
  });
});
