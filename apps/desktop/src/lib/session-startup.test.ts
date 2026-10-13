import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoverableSessionCandidate, SessionCheckpoint, SessionCheckpointMetadata, SessionMetadata, SessionWindowLease } from "./session-storage";

const storage = vi.hoisted(() => ({
  metadata: vi.fn(), status: vi.fn(), candidates: vi.fn(), claim: vi.fn(), load: vi.fn(), close: vi.fn(),
  metadataResult: vi.fn(), loadResult: vi.fn(),
  registry: vi.fn(), readStorage: vi.fn(),
}));
vi.mock("./session-storage", async (original) => ({
  ...await original<typeof import("./session-storage")>(),
  readLatestSessionCheckpointMetadata: storage.metadata,
  readLatestSessionCheckpointStatus: storage.status,
  listRecoverableSessionCheckpointCandidates: storage.candidates,
  claimRecoverableSessionCandidate: storage.claim,
  loadSessionCheckpoint: storage.load,
  readLatestSessionCheckpointMetadataResult: storage.metadataResult,
  loadSessionCheckpointResult: storage.loadResult,
  readSessionRegistry: storage.registry,
  readStorage: storage.readStorage,
  closeSessionWindow: storage.close,
}));
import { resolveStartupSession, validateStartupCheckpoint } from "./session-startup";

function candidate(scope: string, state: "closed" | "stale" = "closed"): RecoverableSessionCandidate {
  const session: SessionMetadata = { version: 2, workspace: "/workspace", tabs: [], expandedPaths: [], activeTabId: undefined };
  const checkpoint: SessionCheckpointMetadata = { version: 2, scope, checkpointId: `${scope}-checkpoint`, sequence: 7, committedAt: 100, session, recoveryKeys: [], recoveryRevisions: {} };
  return { checkpoint, completeMetadata: true, missingRecoveryKeys: [], source: "indexeddb", workspace: session.workspace,
    activeWindowIds: [], staleWindowIds: state === "stale" ? ["previous"] : [], closedWindowIds: state === "closed" ? ["previous"] : [] };
}
const full = (item: RecoverableSessionCandidate): SessionCheckpoint => ({ ...item.checkpoint, recoveries: {} });
const lease = (scope: string): SessionWindowLease => ({ scope, windowId: "secondary", leaseId: "test-owner" });

describe("startup recovery selects metadata before loading bodies", () => {
  beforeEach(() => {
    for (const mock of Object.values(storage)) mock.mockReset();
    storage.metadata.mockResolvedValue(null);
    storage.status.mockResolvedValue(null);
    storage.candidates.mockResolvedValue([]);
    storage.close.mockResolvedValue({ ok: true });
    storage.readStorage.mockReturnValue(null);
    storage.metadataResult.mockImplementation(async (scope) => {
      const value = await storage.metadata(scope);
      return value ? { status: "available", value } : { status: "missing" };
    });
    storage.loadResult.mockImplementation(async (scope, options) => {
      const value = await storage.load(scope, {
        expectedCheckpointId: options?.expected?.checkpointId,
        ...(options?.lease ? { lease: options.lease } : {}),
      });
      return value ? { status: "available", value } : { status: "missing" };
    });
  });
  const hooks = () => ({ readLegacy: vi.fn((): SessionMetadata | null => null), confirmStaleRecovery: vi.fn(async () => true), notify: vi.fn(), isCurrent: () => true });

  it("loads only the fenced chosen candidate, without loading another workspace body", async () => {
    const selected = candidate("selected");
    const other = candidate("other");
    storage.candidates.mockResolvedValue([selected, other]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockResolvedValue(full(selected));
    const result = await resolveStartupSession("secondary", hooks());
    expect(result.scope).toBe("selected");
    expect(storage.load).toHaveBeenCalledTimes(1);
    expect(storage.load).toHaveBeenCalledWith("selected", { expectedCheckpointId: "selected-checkpoint", lease: lease("selected") });
    expect(storage.claim.mock.calls[0][0].candidate).toEqual({ scope: "selected", checkpointId: "selected-checkpoint", sequence: 7 });
    expect(storage.close).not.toHaveBeenCalled();
  });

  it("releases ownership if selected body validation fails", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockResolvedValue(null);
    expect((await resolveStartupSession("secondary", hooks())).checkpoint).toBeNull();
    expect(storage.close).toHaveBeenCalledWith(lease("selected"), { discardRecovery: false });
  });

  it("returns only a pending lease when cleanup throws after an invalid body", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected, candidate("next", "stale")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockResolvedValue(null);
    storage.close.mockRejectedValue(new Error("cleanup storage failure"));
    const options = hooks();

    const result = await resolveStartupSession("secondary", options);

    expect(result).toMatchObject({
      scope: "secondary", checkpoint: null, legacy: null, lease: null,
      pendingReleaseLease: lease("selected"), recoveredSecondary: false,
    });
    expect(result.startupError).toBeUndefined();
    expect(storage.claim).toHaveBeenCalledOnce();
    expect(storage.load).toHaveBeenCalledOnce();
    expect(options.notify).toHaveBeenCalledWith(expect.stringContaining("recovery is paused"));
  });

  it("retains the pending lease when cleanup rejects with undefined", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockResolvedValue(null);
    storage.close.mockRejectedValue(undefined);

    const result = await resolveStartupSession("secondary", hooks());

    expect(result.pendingReleaseLease).toEqual(lease("selected"));
    expect(result.lease).toBeNull();
    expect(result.checkpoint).toBeNull();
    expect(result.recoveryUnavailable).toBe(true);
  });

  it("never loads a body after the exact candidate claim conflicts", async () => {
    storage.candidates.mockResolvedValue([candidate("selected", "stale")]);
    storage.claim.mockResolvedValue({ ok: false, reason: "conflict" });
    const options = hooks();
    await resolveStartupSession("secondary", options);
    expect(options.confirmStaleRecovery).toHaveBeenCalledOnce();
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.claim.mock.calls[0][0].allowStale).toBe(true);
  });

  it("does not claim a declined stale candidate", async () => {
    storage.candidates.mockResolvedValue([candidate("selected", "stale")]);
    const options = hooks();
    options.confirmStaleRecovery.mockResolvedValue(false);
    await resolveStartupSession("secondary", options);
    expect(storage.claim).not.toHaveBeenCalled();
    expect(storage.load).not.toHaveBeenCalled();
  });

  it("returns a pending lease if cleanup throws after generation changes", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected, candidate("next", "stale")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    let current = true;
    storage.load.mockImplementation(async () => { current = false; return full(selected); });
    storage.close.mockRejectedValue(new Error("cleanup storage failure"));

    const result = await resolveStartupSession("secondary", { ...hooks(), isCurrent: () => current });

    expect(result).toMatchObject({
      scope: "secondary", checkpoint: null, legacy: null, lease: null,
      pendingReleaseLease: lease("selected"), recoveredSecondary: false,
    });
    expect(storage.claim).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("returns a pending lease instead of exposing a late checkpoint when release is unavailable", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected, candidate("next", "stale")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    let current = true;
    storage.load.mockImplementation(async () => { current = false; return full(selected); });
    storage.close.mockResolvedValue({ ok: false, reason: "unavailable" });
    const options = { ...hooks(), isCurrent: () => current };

    const result = await resolveStartupSession("secondary", options);

    expect(result).toMatchObject({
      scope: "secondary", checkpoint: null, legacy: null, lease: null,
      pendingReleaseLease: lease("selected"), recoveredSecondary: false,
    });
    expect(storage.claim).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("keeps the original load failure and pending lease when cleanup also throws", async () => {
    storage.candidates.mockResolvedValue([candidate("selected"), candidate("next", "stale")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    const loadError = new Error("storage failure");
    storage.load.mockRejectedValue(loadError);
    storage.close.mockRejectedValue(new Error("cleanup storage failure"));
    const options = hooks();

    const result = await resolveStartupSession("secondary", options);

    expect(result).toMatchObject({
      scope: "secondary", checkpoint: null, legacy: null, lease: null,
      pendingReleaseLease: lease("selected"), recoveredSecondary: false,
    });
    expect(result.startupError).toBe(loadError);
    expect(storage.claim).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(options.notify).toHaveBeenCalledWith(expect.stringContaining("recovery is paused"));
  });

  it("preserves an undefined load rejection when cleanup also rejects with undefined", async () => {
    storage.candidates.mockResolvedValue([candidate("selected")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockRejectedValue(undefined);
    storage.close.mockRejectedValue(undefined);

    const result = await resolveStartupSession("secondary", hooks());

    expect(result.pendingReleaseLease).toEqual(lease("selected"));
    expect(result.lease).toBeNull();
    expect(result.checkpoint).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "startupError")).toBe(true);
    expect(result.startupError).toBeUndefined();
  });

  it("preserves the load rejection after cleanup succeeds", async () => {
    storage.candidates.mockResolvedValue([candidate("selected")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    const loadError = new Error("storage failure");
    storage.load.mockRejectedValue(loadError);
    await expect(resolveStartupSession("secondary", hooks())).rejects.toBe(loadError);
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("preserves an undefined load rejection after cleanup succeeds", async () => {
    storage.candidates.mockResolvedValue([candidate("selected")]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockRejectedValue(undefined);

    await expect(resolveStartupSession("secondary", hooks())).rejects.toBeUndefined();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("does not adopt a body whose checkpoint scope differs from the claimed candidate", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("selected") });
    storage.load.mockResolvedValue({ ...full(selected), scope: "other" });

    const result = await resolveStartupSession("secondary", hooks());

    expect(result.checkpoint).toBeNull();
    expect(result.lease).toBeNull();
    expect(storage.close).toHaveBeenCalledWith(lease("selected"), { discardRecovery: false });
  });

  it("releases a claimed lease whose scope differs from the candidate before reading its body", async () => {
    const selected = candidate("selected");
    storage.candidates.mockResolvedValue([selected]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("other") });

    const result = await resolveStartupSession("secondary", hooks());

    expect(result.checkpoint).toBeNull();
    expect(result.lease).toBeNull();
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.close).toHaveBeenCalledWith(lease("other"), { discardRecovery: false });
  });

  it("loads a preferred scope once and skips unrelated candidate enumeration", async () => {
    const selected = candidate("secondary");
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    storage.load.mockResolvedValue(full(selected));
    expect((await resolveStartupSession("secondary", hooks())).scope).toBe("secondary");
    expect(storage.load).toHaveBeenCalledOnce();
    expect(storage.candidates).not.toHaveBeenCalled();
  });

  it("captures cursor positions from the selected preferred scope", async () => {
    const selected = candidate("secondary");
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    storage.load.mockResolvedValue(full(selected));
    storage.readStorage.mockReturnValue(JSON.stringify({ version: 2, positions: { tab: { cursorLine: 12, cursorColumn: 4 } } }));

    const result = await resolveStartupSession("secondary", hooks());

    expect(result.cursorPositions).toEqual({ tab: { cursorLine: 12, cursorColumn: 4 } });
    expect(storage.readStorage).toHaveBeenCalledWith("pude-cursors-v2:secondary");
  });

  it("captures legacy cursor positions from its scope", async () => {
    const options = hooks();
    options.readLegacy.mockReturnValue(candidate("legacy-scope").checkpoint.session);
    storage.readStorage.mockReturnValue(JSON.stringify({ version: 2, positions: { legacyTab: { cursorLine: 3, cursorColumn: 8 } } }));

    const result = await resolveStartupSession("legacy-scope", options);

    expect(result.cursorPositions).toEqual({ legacyTab: { cursorLine: 3, cursorColumn: 8 } });
    expect(storage.readStorage).toHaveBeenCalledWith("pude-cursors-v2:legacy-scope");
  });

  it("captures cursor positions only after adopting the secondary checkpoint scope", async () => {
    const selected = candidate("recovered-scope");
    storage.candidates.mockResolvedValue([selected]);
    storage.claim.mockResolvedValue({ ok: true, reusedScope: true, lease: lease("recovered-scope") });
    storage.load.mockResolvedValue(full(selected));
    storage.readStorage.mockReturnValue(JSON.stringify({ version: 2, positions: { recoveredTab: { cursorLine: 6, cursorColumn: 2 } } }));

    const result = await resolveStartupSession("new-window", hooks());

    expect(result.cursorPositions).toEqual({ recoveredTab: { cursorLine: 6, cursorColumn: 2 } });
    expect(storage.readStorage).toHaveBeenCalledWith("pude-cursors-v2:recovered-scope");
  });

  it("pauses instead of falling back to legacy when a preferred body is unreadable", async () => {
    const selected = candidate("secondary");
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    storage.load.mockResolvedValue(null);
    const options = hooks();
    options.readLegacy.mockReturnValue(selected.checkpoint.session);

    expect(await resolveStartupSession("secondary", options)).toMatchObject({
      checkpoint: null, legacy: null, recoveryUnavailable: true, lease: null,
    });
    expect(options.readLegacy).not.toHaveBeenCalled();
    expect(storage.candidates).not.toHaveBeenCalled();
  });

  it("never reads legacy or candidates when checkpoint metadata is unavailable", async () => {
    storage.metadataResult.mockResolvedValue({ status: "unavailable", error: undefined });
    const options = hooks();
    const result = await resolveStartupSession("secondary", options);
    expect(result).toMatchObject({ checkpoint: null, legacy: null, recoveryUnavailable: true });
    expect(Object.prototype.hasOwnProperty.call(result, "startupError")).toBe(true);
    expect(options.readLegacy).not.toHaveBeenCalled();
    expect(storage.loadResult).not.toHaveBeenCalled();
    expect(storage.candidates).not.toHaveBeenCalled();
  });

  it("retains the unavailable barrier when the workspace changed during metadata IO", async () => {
    storage.metadataResult.mockResolvedValue({ status: "unavailable" });
    expect((await resolveStartupSession("secondary", { ...hooks(), isCurrent: () => false })).recoveryUnavailable).toBe(true);
  });

  it("does not discard unread dirty recovery when metadata IO is superseded", async () => {
    const selected = candidate("secondary");
    selected.checkpoint.session.tabs = [{
      id: "dirty", path: "/workspace/file.txt", name: "file.txt", encoding: "UTF-8", language: "Text",
      dirty: true, revision: 2, savedRevision: 1,
      contentVersion: 2, lineEnding: "lf", cursorLine: 1, cursorColumn: 1,
    }];
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    expect((await resolveStartupSession("secondary", { ...hooks(), isCurrent: () => false })).recoveryUnavailable).toBe(true);
    expect(storage.loadResult).not.toHaveBeenCalled();
  });

  it("preserves a superseded legacy text session even when its metadata says clean", async () => {
    const options = hooks();
    options.readLegacy.mockReturnValue({ version: 2, workspace: "/workspace", expandedPaths: [], tabs: [{
      id: "legacy", path: "/workspace/file.txt", name: "file.txt", encoding: "UTF-8", language: "Text",
      dirty: false, revision: 1, savedRevision: 1, contentVersion: 1, lineEnding: "lf", cursorLine: 1, cursorColumn: 1,
    }] });
    expect((await resolveStartupSession("secondary", { ...options, isCurrent: () => false })).recoveryUnavailable).toBe(true);
    expect(storage.loadResult).not.toHaveBeenCalled();
  });

  it("preserves a preferred body rejection without exposing legacy", async () => {
    const selected = candidate("secondary");
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    storage.load.mockRejectedValue(undefined);
    const result = await resolveStartupSession("secondary", hooks());

    expect(result.recoveryUnavailable).toBe(true);
    expect(result.legacy).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "startupError")).toBe(true);
  });

  it.each(["scope", "checkpointId", "sequence", "workspace"])("rejects a preferred body with mismatched %s", async (field) => {
    const selected = candidate("secondary");
    const checkpoint = full(selected);
    if (field === "scope") checkpoint.scope = "other";
    if (field === "checkpointId") checkpoint.checkpointId = "older";
    if (field === "sequence") checkpoint.sequence -= 1;
    if (field === "workspace") checkpoint.session = { ...checkpoint.session, workspace: "/other" };
    storage.metadata.mockResolvedValue({ checkpoint: selected.checkpoint });
    storage.load.mockResolvedValue(checkpoint);

    expect(await resolveStartupSession("secondary", hooks())).toMatchObject({
      checkpoint: null, legacy: null, recoveryUnavailable: true,
    });
  });

  it("revalidates a previously loaded body after ownership is acquired", async () => {
    const selected = candidate("secondary");
    const owner = lease("secondary");
    storage.metadataResult.mockResolvedValue({ status: "available", value: selected });
    storage.registry.mockResolvedValue({ windows: [{ ...owner, status: "open" }] });
    expect(await validateStartupCheckpoint(full(selected), owner)).toBe(true);
    const newer = candidate("secondary");
    newer.checkpoint.sequence += 1;
    storage.metadataResult.mockResolvedValue({ status: "available", value: newer });
    expect(await validateStartupCheckpoint(full(selected), owner)).toBe(false);
  });

  it.each(["closed", "replaced", "unavailable", "throw"])("rejects post-attach validation when ownership is %s", async (state) => {
    const selected = candidate("secondary");
    const owner = lease("secondary");
    storage.metadataResult.mockResolvedValue({ status: "available", value: selected });
    storage.registry.mockResolvedValue({ windows: [{ ...owner, status: state === "closed" ? "closed" : "open", leaseId: state === "replaced" ? "new-owner" : owner.leaseId }] });
    if (state === "unavailable") storage.metadataResult.mockResolvedValue({ status: "unavailable" });
    if (state === "throw") storage.registry.mockRejectedValue(undefined);
    expect(await validateStartupCheckpoint(full(selected), owner)).toBe(false);
  });
});
