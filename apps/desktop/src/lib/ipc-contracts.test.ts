import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ipcFixtures from "../../src-tauri/tests/fixtures/ipc-contracts-v1.json";
import { contentFingerprint } from "./fingerprint";
import type {
  GitErrorInfo,
  GitStatusResult,
  LineEnding,
  PluginManifest,
  ReadFileResult,
  SaveFileResult,
} from "../types";
import type {
  LspEvent,
  PluginWorkspaceFileInfo,
  PluginWorkspaceFileRange,
  StatFileEntry,
} from "./bridge";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

const readFileConsumer: ReadFileResult = {
  path: "/fixture/notes/例文.rs",
  content: "café 🧪\nline\n",
  encoding: "utf-8-bom",
  lineEnding: "lf",
  lineEndings: "cl",
  bom: true,
  modifiedAt: 1_700_000_000_123,
  size: 20,
  fingerprint: contentFingerprint("\uFEFFcafé 🧪\r\nline\n"),
  identity: null,
};

const gitStatusConsumer: GitStatusResult = {
  repositoryRoot: "/workspace/例子",
  branch: null,
  repositoryState: "detached",
  headOid: null,
  files: [],
  commits: [],
  error: null,
};

const gitErrorConsumer: GitErrorInfo = {
  kind: "failed",
  message: "Open a folder before running Git operations.",
  exitCode: null,
  stream: null,
  limit: null,
};

const pluginManifestConsumer: PluginManifest = {
  id: "org.example.例",
  name: "測試外掛",
  version: "1.2.3",
  apiVersion: "2",
  entry: "dist/main.js",
  permissions: ["editor.read", "process.spawn:lsp"],
  activationEvents: ["onStartupFinished"],
  contributes: { commands: [{ command: "example.run", title: "Run 🧪" }] },
  lspServers: [{
    serverId: "rust-analyzer",
    language: "rust",
    executable: "/usr/bin/rust-analyzer",
    args: ["--stdio", "--label=🧪"],
  }],
  networkDomains: ["packages.example.test"],
};

const lspEventConsumer: LspEvent = {
  type: "state",
  pluginId: "org.example.例",
  pluginVersion: "1.2.3",
  workspaceRoot: "/workspace/例子",
  language: "rust",
  serverId: "rust-analyzer",
  state: "started",
  restartCount: 3,
  message: null,
};

const statMissingEntryConsumer: StatFileEntry = {
  path: "/fixture/notes/missing-測試.txt",
  exists: false,
  modifiedAt: null,
  size: null,
  identity: null,
};

const pluginFileRevision = "plugin-file-v1:fixture:device:inode:8:time";
const pluginFileInfoConsumer: PluginWorkspaceFileInfo = {
  ...ipcFixtures.pluginWorkspaceFileInfoResponse,
  revision: pluginFileRevision,
};
const pluginFileRangeConsumer: PluginWorkspaceFileRange = {
  ...ipcFixtures.pluginWorkspaceReadFileRangeResponse,
  revision: pluginFileRevision,
};

function jsonWireValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function fixtureLineEnding(value: string): LineEnding {
  if (value === "lf" || value === "crlf") return value;
  throw new Error(`Unexpected line ending in IPC fixture: ${value}`);
}

function fixtureFileEncoding(value: string): ReadFileResult["encoding"] {
  if (value === "utf-8" || value === "utf-8-bom") return value;
  throw new Error(`Unexpected file encoding in IPC fixture: ${value}`);
}

describe("Rust Serde and TypeScript IPC contracts", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Rust Serde response fixtures consumable by the TypeScript DTOs", () => {
    const readFileFixture: ReadFileResult = {
      ...ipcFixtures.readFileResponse,
      encoding: fixtureFileEncoding(ipcFixtures.readFileResponse.encoding),
      lineEnding: fixtureLineEnding(ipcFixtures.readFileResponse.lineEnding),
      fingerprint: readFileConsumer.fingerprint,
    };
    expect(readFileFixture).toEqual(readFileConsumer);
    expect(Object.keys(readFileFixture).sort()).toEqual(Object.keys(readFileConsumer).sort());
    expect(ipcFixtures.gitStatusResponse).toEqual(gitStatusConsumer);
    expect(ipcFixtures.gitOperationError).toEqual(gitErrorConsumer);
    expect(ipcFixtures.pluginManifest).toEqual(pluginManifestConsumer);
    expect(ipcFixtures.lspEvent).toEqual(lspEventConsumer);
    expect({ ...ipcFixtures.pluginWorkspaceFileInfoResponse, revision: pluginFileRevision }).toEqual(pluginFileInfoConsumer);
    expect({ ...ipcFixtures.pluginWorkspaceReadFileRangeResponse, revision: pluginFileRevision }).toEqual(pluginFileRangeConsumer);
    expect({
      ...ipcFixtures.statFilesMissingEntry,
      path: statMissingEntryConsumer.path,
    }).toEqual(statMissingEntryConsumer);

    const savedText = "\uFEFF改訂版 🧪\r\nsecond";
    const saveFileConsumer: SaveFileResult = {
      modifiedAt: 1_700_000_000_123,
      size: 25,
      fingerprint: contentFingerprint(savedText),
      identity: "$FILE_IDENTITY",
    };
    const saveFileFixture: SaveFileResult = {
      ...ipcFixtures.saveFileResponse,
      fingerprint: saveFileConsumer.fingerprint,
    };
    expect(saveFileFixture).toEqual(saveFileConsumer);
    expect(Object.keys(saveFileFixture).sort()).toEqual(Object.keys(saveFileConsumer).sort());
  });

  it("emits save, stat, and Git request bodies accepted by the production Rust command wrappers", async () => {
    invokeMock.mockResolvedValueOnce(readFileConsumer);
    const bridge = await import("./bridge");
    const readPath = "/fixture/read-測試.txt";
    await bridge.readFile(readPath);
    expect(invokeMock.mock.calls[0]).toEqual(["read_file", { ...ipcFixtures.readFileArgs, path: readPath }]);

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({});
    const sourceText = ipcFixtures.readFileSourceText;
    const sourceFingerprint = contentFingerprint(sourceText);
    const savePath = "/fixture/save-測試.txt";

    await bridge.saveFile(
      savePath,
      ipcFixtures.saveFileArgs.content,
      fixtureLineEnding(ipcFixtures.saveFileArgs.lineEnding),
      ipcFixtures.saveFileArgs.lineEndings,
      ipcFixtures.saveFileArgs.bom,
      undefined,
      undefined,
      sourceFingerprint,
    );

    const [saveCommand, saveBody] = invokeMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(saveCommand).toBe("save_file");
    expect(jsonWireValue(saveBody)).toEqual({
      ...ipcFixtures.saveFileArgs,
      path: savePath,
      expectedFingerprint: sourceFingerprint,
    });

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({ entries: [] });
    await bridge.statFiles([statMissingEntryConsumer.path]);
    const [statCommand, statBody] = invokeMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(statCommand).toBe("stat_files");
    expect(jsonWireValue(statBody)).toEqual({ request: { paths: [statMissingEntryConsumer.path] } });

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({ output: "" });
    await bridge.performGitAction("", { action: "add" });
    const [gitCommand, gitBody] = invokeMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(gitCommand).toBe("git_operation");
    expect(jsonWireValue(gitBody)).toEqual(ipcFixtures.gitOperationArgs);
  });

  it("emits plugin metadata, UTF-8 range, and release requests accepted by the Rust commands", async () => {
    invokeMock.mockResolvedValueOnce(pluginFileInfoConsumer);
    const bridge = await import("./bridge");
    const workspace = "/fixture/workspace-例";
    const path = "range-測試.txt";
    const info = await bridge.pluginWorkspaceFileInfo(workspace, path);
    expect(info).toEqual(pluginFileInfoConsumer);
    expect(invokeMock.mock.calls[0]).toEqual(["plugin_workspace_file_info", { workspace, path }]);

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(pluginFileRangeConsumer);
    const range = await bridge.pluginWorkspaceReadFileRange(
      workspace,
      path,
      pluginFileRevision,
      ipcFixtures.pluginWorkspaceReadFileRangeArgs.offsetBytes,
      ipcFixtures.pluginWorkspaceReadFileRangeArgs.maxBytes,
      ipcFixtures.pluginWorkspaceReadFileRangeArgs.requestId,
      new AbortController().signal,
    );
    expect(range).toEqual(pluginFileRangeConsumer);
    expect(jsonWireValue(invokeMock.mock.calls[0])).toEqual([
      "plugin_workspace_read_file_range",
      {
        workspace,
        path,
        revision: pluginFileRevision,
        offsetBytes: 0,
        maxBytes: 5,
        requestId: "ipc-contract-range-1",
      },
    ]);

    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(undefined);
    await bridge.pluginWorkspaceReleaseFileRead(workspace, path, pluginFileRevision);
    expect(invokeMock.mock.calls[0]).toEqual([
      "plugin_workspace_release_file_read",
      { workspace, path, revision: pluginFileRevision },
    ]);

    invokeMock.mockReset();
    let resolveRange!: (value: PluginWorkspaceFileRange) => void;
    invokeMock.mockImplementation((command: string) => command === "plugin_workspace_read_file_range"
      ? new Promise<PluginWorkspaceFileRange>((resolve) => { resolveRange = resolve; })
      : Promise.resolve(undefined));
    const controller = new AbortController();
    const pendingRange = bridge.pluginWorkspaceReadFileRange(
      workspace,
      path,
      pluginFileRevision,
      0,
      5,
      ipcFixtures.pluginWorkspaceCancelFileReadArgs.requestId,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("plugin_workspace_read_file_range", {
        workspace,
        path,
        revision: pluginFileRevision,
        offsetBytes: 0,
        maxBytes: 5,
        requestId: ipcFixtures.pluginWorkspaceCancelFileReadArgs.requestId,
      });
    });
    controller.abort();
    resolveRange(pluginFileRangeConsumer);
    await expect(pendingRange).rejects.toThrow("workspace.read_cancelled");
    expect(invokeMock.mock.calls).toContainEqual([
      "cancel_plugin_workspace_file_read",
      ipcFixtures.pluginWorkspaceCancelFileReadArgs,
    ]);
    expect(invokeMock.mock.calls).toContainEqual([
      "plugin_workspace_release_file_read",
      { workspace, path, revision: pluginFileRevision },
    ]);
  });

  it("rejects a one-sided Rust wire-field rename", () => {
    const drifted: Record<string, unknown> = {
      ...ipcFixtures.readFileResponse,
      line_ending: ipcFixtures.readFileResponse.lineEnding,
    };
    delete drifted.lineEnding;
    expect(drifted).not.toEqual(ipcFixtures.readFileResponse);
    expect(Object.keys(drifted).sort()).not.toEqual(Object.keys(readFileConsumer).sort());
  });
});
