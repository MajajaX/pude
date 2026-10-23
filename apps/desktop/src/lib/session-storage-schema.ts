import type { DirectoryEntry, EditorTab, LineEnding, EditorEncoding } from "../types";
import { normalizeLineEndingMap } from "./file-metadata";

export const SESSION_STORAGE_KEY = "pude-session-v2";
export const CURSOR_STORAGE_KEY = "pude-cursors-v2";
export const RECOVERY_STORAGE_PREFIX = "pude-recovery-v2:";
export const RECOVERY_BASELINE_STORAGE_PREFIX = "pude-recovery-baseline-v1:";
export const SESSION_SCHEMA_VERSION = 3;
export const SESSION_CHECKPOINT_SCHEMA_VERSION = 2;
/** Markers written before the baseline-reference format. Still read. */
export const LEGACY_SESSION_CHECKPOINT_SCHEMA_VERSION = 1;
export const SESSION_REGISTRY_SCHEMA_VERSION = 1;
export const SESSION_CHECKPOINT_STORAGE_PREFIX = "pude-session-checkpoint-v1:";
export const SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX = "pude-session-checkpoint-meta-v1:";
export const SESSION_REGISTRY_STORAGE_KEY = "pude-session-registry-v1";
export const SESSION_WINDOW_LEASE_MS = 5 * 60 * 1000;

const MAX_CLEAN_TABS = 100;
const MAX_WORKSPACE_FOLDERS = 64;
export const MAX_PATH_LENGTH = 4096;
export const MAX_RECOVERY_BYTES = 48 * 1024 * 1024;
export const MAX_RECOVERY_TOTAL_BYTES = 48 * 1024 * 1024;
export const MAX_SESSION_WINDOWS = 256;

export type PersistedTab = {
  id: string;
  path: string;
  name: string;
  pinned?: boolean;
  dirty: boolean;
  lineEnding: LineEnding;
  lineEndings?: string;
  savedLineEndings?: string;
  bom?: boolean;
  savedBom?: boolean;
  encoding: EditorEncoding;
  language: string;
  cursorLine: number;
  cursorColumn: number;
  revision: number;
  savedRevision: number;
  contentVersion: number;
  diskModifiedAt?: number;
  diskSize?: number;
  diskFingerprint?: string;
  diskIdentity?: string;
};

export type ProjectSessionMetadata = {
  id: string;
  workspace: string;
  /** Further folders of a multi-folder workspace. */
  folders?: string[];
  /** The `.pdw` file of a saved workspace. */
  workspaceFile?: string;
  activeTabId?: string;
  tabs: PersistedTab[];
  expandedPaths: string[];
};

export type SessionMetadata = {
  version: 2 | typeof SESSION_SCHEMA_VERSION;
  activeProjectId?: string;
  projects?: ProjectSessionMetadata[];
  /** Window-wide projection used by checkpoint/recovery bookkeeping. */
  workspace: string;
  activeTabId?: string;
  tabs: PersistedTab[];
  expandedPaths: string[];
};

export type CursorPosition = { cursorLine: number; cursorColumn: number };

export type RecoverySnapshot = {
  /** v1 embeds the saved baseline text; v2 references a separately stored baseline. */
  version: 1 | 2;
  tabId: string;
  path: string;
  revision: number;
  content: string;
  savedContent: string;
  /** v2: revision of the saved baseline this snapshot was taken against. */
  savedRevision?: number;
  /** Large-document checkpoints may recover the edit and re-read the saved baseline from disk. */
  savedContentUnavailable?: true;
  lineEnding: LineEnding;
  lineEndings?: string;
  savedLineEndings?: string;
  bom?: boolean;
  savedBom?: boolean;
  encoding?: EditorEncoding;
};

/**
 * The durable saved baseline for a dirty tab. Written once per saved
 * baseline (savedRevision) instead of being duplicated into every snapshot.
 */
export type RecoveryBaseline = {
  version: 1;
  tabId: string;
  path: string;
  savedRevision: number;
  savedContent: string;
  savedLineEndings?: string;
  savedBom?: boolean;
  encoding?: EditorEncoding;
};

export type RecoveryStorageValue = RecoverySnapshot | string;

/** Distinguishes a confirmed empty read from storage that could not be checked. */
export type StorageReadResult<T> =
  | { status: "available"; value: T }
  | { status: "missing" }
  | { status: "unavailable"; error?: unknown; observedValue?: T };

export type SessionCheckpoint = {
  version: typeof SESSION_CHECKPOINT_SCHEMA_VERSION;
  scope: string;
  checkpointId: string;
  sequence: number;
  committedAt: number;
  session: SessionMetadata;
  /** A null revision means the tab was dirty but no usable text was stored. */
  recoveryRevisions: Record<string, number | null>;
  recoveries: Record<string, RecoverySnapshot>;
};

/** Checkpoint data suitable for candidate lists and commit acknowledgements. */
export type SessionCheckpointMetadata = Omit<SessionCheckpoint, "recoveries"> & {
  /** Keys expected to have snapshot records. This does not assert body integrity. */
  recoveryKeys: string[];
};

export type SessionCheckpointMetadataReadResult = {
  checkpoint: SessionCheckpointMetadata;
  /** Only marker/reference metadata was checked; bodies remain unverified. */
  completeMetadata: boolean;
  missingRecoveryKeys: string[];
  source: "indexeddb" | "fallback";
};

export type SessionCheckpointInput = {
  scope: string;
  session: SessionMetadata;
  /** Snapshots changed since the previous checkpoint. Existing entries are retained. */
  recoveries?: readonly RecoverySnapshot[];
  /** Baselines changed since the previous checkpoint. Existing entries are retained. */
  baselines?: readonly RecoveryBaseline[];
  /** Recovery keys that became clean or were explicitly discarded. */
  recoveryKeysToRemove?: readonly string[];
  /** Recovery keys that are currently dirty in a live window. They are never evicted. */
  protectedRecoveryKeys?: readonly string[];
  /** Dirty keys whose text is intentionally unavailable (for example, an over-limit document). */
  unavailableRecoveryKeys?: readonly string[];
  lease?: SessionWindowLease;
  now?: number;
};

export type SessionCheckpointDurability = "indexeddb" | "fallback" | "both" | "none";

export type SessionCheckpointResult = {
  ok: boolean;
  /** True only when every dirty tab has a matching committed recovery snapshot. */
  complete: boolean;
  checkpoint: SessionCheckpointMetadata | null;
  /** Snapshot keys written by this commit. */
  updatedRecoveryKeys: string[];
  /** Snapshot keys removed by this commit. */
  removedRecoveryKeys: string[];
  durability: SessionCheckpointDurability;
  fallback: "committed" | "skipped" | "failed";
  evictedKeys: string[];
  missingRecoveryKeys: string[];
  reason?: "invalid" | "conflict" | "quota" | "unavailable" | "aborted" | "missing-recovery";
};

export type SessionWindowLease = {
  windowId: string;
  scope: string;
  leaseId: string;
};

export type SessionWindowRecord = SessionWindowLease & {
  workspace: string;
  attachedAt: number;
  heartbeatAt: number;
  dirtyRecoveryKeys: string[];
  status: "open" | "closed";
  closedAt?: number;
};

export type SessionRegistry = {
  version: typeof SESSION_REGISTRY_SCHEMA_VERSION;
  revision: number;
  updatedAt: number;
  windows: SessionWindowRecord[];
};

export type AttachSessionWindowInput = {
  windowId: string;
  scope: string;
  workspace: string;
  dirtyRecoveryKeys?: readonly string[];
  now?: number;
};

export type SessionRegistryResult = {
  ok: boolean;
  lease: SessionWindowLease | null;
  registry: SessionRegistry;
  staleWindowIds: string[];
  reason?: "invalid" | "conflict" | "capacity" | "unavailable";
};

export type SessionRegistryUpdateResult = {
  ok: boolean;
  registry: SessionRegistry;
  reason?: "stale-lease" | "unavailable";
};

export type RecoverableSession = SessionCheckpointReadResult & {
  workspace: string;
  activeWindowIds: string[];
  staleWindowIds: string[];
  closedWindowIds: string[];
};

export type RecoverableSessionCandidate = SessionCheckpointMetadataReadResult & {
  workspace: string;
  activeWindowIds: string[];
  staleWindowIds: string[];
  closedWindowIds: string[];
};

export type ClaimSessionWindowInput = Omit<AttachSessionWindowInput, "scope"> & {
  preferredScope?: string;
  /** Explicitly allow taking over a scope whose previous window stopped heartbeating. */
  allowStale?: boolean;
};

export type ClaimRecoverableSessionCandidateInput = Omit<ClaimSessionWindowInput, "preferredScope"> & {
  candidate: Pick<SessionCheckpointMetadata, "scope" | "checkpointId" | "sequence">;
};

export type ClaimSessionWindowResult = SessionRegistryResult & {
  reusedScope: boolean;
};

export type ClaimRecoverableSessionCandidateResult = ClaimSessionWindowResult & {
  checkpoint: SessionCheckpointMetadata | null;
};

export type DiscardSessionCheckpointResult = {
  ok: boolean;
  removedKeys: string[];
  reason?: "invalid" | "protected" | "unavailable";
};

export type RecoveryWriteOptions = {
  protectedRecoveryKeys?: readonly string[];
};

export type RecoveryStorageUsage = {
  indexedDbBytes: number;
  fallbackBytes: number;
  totalBytes: number;
  limitBytes: number;
};

export type SessionCheckpointReadResult = {
  checkpoint: SessionCheckpoint;
  complete: boolean;
  missingRecoveryKeys: string[];
  source: "indexeddb" | "fallback";
};

export function createSessionMetadata(workspace: string, activeTabId: string | undefined, tabs: readonly EditorTab[], root: DirectoryEntry, expandedPaths?: string[]): SessionMetadata {
  const persistedTabs = retainSessionTabs(tabs.map(({ id, path, name, pinned, dirty, lineEnding, lineEndings, savedLineEndings, bom, savedBom, encoding, language, cursorLine, cursorColumn, revision, savedRevision, contentVersion, diskModifiedAt, diskSize, diskFingerprint, diskIdentity }) => ({
    id,
    path,
    name,
    pinned: pinned === true,
    dirty,
    lineEnding,
    lineEndings,
    savedLineEndings,
    bom,
    savedBom,
    encoding,
    language,
    cursorLine,
    cursorColumn,
    revision,
    savedRevision,
    contentVersion,
    diskModifiedAt,
    diskSize,
    diskFingerprint,
    diskIdentity,
  })));
  const ids = new Set(persistedTabs.map((tab) => tab.id));
  return {
    version: SESSION_SCHEMA_VERSION,
    workspace,
    activeTabId: activeTabId && ids.has(activeTabId) ? activeTabId : undefined,
    tabs: persistedTabs,
    expandedPaths: expandedPaths ?? collectExpandedPaths(root),
  };
}

export function parseSession(raw: string | null): SessionMetadata | null {
  const value = parseJson(raw);
  if (!isRecord(value) || (value.version !== 2 && value.version !== SESSION_SCHEMA_VERSION)) return null;
  if (value.version === SESSION_SCHEMA_VERSION && Array.isArray(value.projects)) {
    const projects: ProjectSessionMetadata[] = [];
    const ids = new Set<string>();
    const tabIds = new Set<string>();
    for (const candidate of value.projects) {
      if (!isRecord(candidate) || !boundedString(candidate.id, 256) || ids.has(candidate.id)) return null;
      const session = parseSession(JSON.stringify({ ...candidate, version: 2 }));
      if (!session) return null;
      for (const tab of session.tabs) {
        if (tabIds.has(tab.id)) return null;
        tabIds.add(tab.id);
      }
      ids.add(candidate.id);
      const folders = Array.isArray(candidate.folders) ? uniqueStrings(candidate.folders, MAX_WORKSPACE_FOLDERS) : [];
      const workspaceFile = boundedString(candidate.workspaceFile, MAX_PATH_LENGTH) ? candidate.workspaceFile : undefined;
      projects.push({ id: candidate.id, workspace: session.workspace,
        ...(folders.length ? { folders } : {}), ...(workspaceFile ? { workspaceFile } : {}),
        activeTabId: session.activeTabId, tabs: session.tabs, expandedPaths: session.expandedPaths });
    }
    return createWindowSessionMetadata(projects, typeof value.activeProjectId === "string" ? value.activeProjectId : undefined);
  }
  if (typeof value.workspace !== "string" || value.workspace.length > MAX_PATH_LENGTH || !Array.isArray(value.tabs)) return null;
  const tabs: PersistedTab[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  let cleanTabCount = 0;
  for (const candidate of value.tabs) {
    const tab = parsePersistedTab(candidate);
    if (!tab || ids.has(tab.id) || paths.has(tab.path)) continue;
    if (!tab.dirty && cleanTabCount >= MAX_CLEAN_TABS) continue;
    ids.add(tab.id);
    paths.add(tab.path);
    if (!tab.dirty) cleanTabCount += 1;
    tabs.push(tab);
  }
  const expandedPaths = Array.isArray(value.expandedPaths)
    ? uniqueStrings(value.expandedPaths, MAX_CLEAN_TABS * 20)
    : [];
  const activeTabId = typeof value.activeTabId === "string" && ids.has(value.activeTabId) ? value.activeTabId : undefined;
  return { version: SESSION_SCHEMA_VERSION, workspace: value.workspace, activeTabId, tabs, expandedPaths };
}

export function createWindowSessionMetadata(projects: readonly ProjectSessionMetadata[], activeProjectId?: string): SessionMetadata {
  const retained = retainSessionTabs(projects.flatMap((project) => project.tabs));
  const retainedIds = new Set(retained.map((tab) => tab.id));
  const normalized = projects.map((project) => {
    const tabs = project.tabs.filter((tab) => retainedIds.has(tab.id));
    return { ...project, tabs, activeTabId: tabs.some((tab) => tab.id === project.activeTabId) ? project.activeTabId : undefined };
  });
  const active = normalized.find((project) => project.id === activeProjectId) ?? normalized[0];
  return {
    version: SESSION_SCHEMA_VERSION, projects: normalized, activeProjectId: active?.id,
    workspace: active?.workspace ?? "", activeTabId: active?.activeTabId,
    tabs: normalized.flatMap((project) => project.tabs), expandedPaths: active?.expandedPaths ?? [],
  };
}

export function parseCursorPositions(raw: string | null): Record<string, CursorPosition> {
  const value = parseJson(raw);
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.positions)) return {};
  const positions: Record<string, CursorPosition> = {};
  for (const [id, candidate] of Object.entries(value.positions)) {
    if (!isRecord(candidate)) continue;
    const cursorLine = positiveInteger(candidate.cursorLine);
    const cursorColumn = positiveInteger(candidate.cursorColumn);
    if (cursorLine && cursorColumn) positions[id] = { cursorLine, cursorColumn };
  }
  return positions;
}

export function serializeCursorPositions(positions: Record<string, CursorPosition>): string {
  return JSON.stringify({ version: 2, positions });
}

export function parseRecovery(raw: unknown): RecoverySnapshot | null {
  if (typeof raw === "string" && raw.length > MAX_RECOVERY_BYTES * 2 + 8192) return null;
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || !boundedString(value.tabId, 256)
    || !boundedString(value.path, MAX_PATH_LENGTH)
    || typeof value.content !== "string"
    || (value.version === 1 && typeof value.savedContent !== "string" && value.savedContentUnavailable !== true)) return null;
  const revision = nonNegativeInteger(value.revision);
  if (revision === undefined) return null;
  let savedRevision: number | undefined;
  if (value.version === 2) {
    savedRevision = nonNegativeInteger(value.savedRevision);
    if (savedRevision === undefined) return null;
  }
  const lineEnding = value.lineEnding === "crlf" ? "crlf" : "lf";
  // v1: savedContent is either inline or explicitly unavailable. v2 without an
  // inline savedContent references a separately stored baseline; until it is
  // resolved the snapshot behaves like the large-document unavailable form.
  const inlineSavedContent = typeof value.savedContent === "string";
  const savedContentUnavailable = value.savedContentUnavailable === true || (value.version === 2 && !inlineSavedContent);
  const hasTextMetadata = typeof value.lineEndings === "string"
    || typeof value.savedLineEndings === "string"
    || typeof value.bom === "boolean"
    || typeof value.savedBom === "boolean"
    || savedContentUnavailable
    || typeof value.encoding === "string";
  const snapshot: RecoverySnapshot = {
    version: value.version,
    tabId: value.tabId,
    path: value.path,
    revision,
    content: value.content,
    savedContent: inlineSavedContent ? value.savedContent : "",
    ...(savedRevision === undefined ? {} : { savedRevision }),
    ...(savedContentUnavailable ? { savedContentUnavailable: true as const } : {}),
    lineEnding,
    ...(hasTextMetadata ? {
      lineEndings: normalizeLineEndingMap(value.content, typeof value.lineEndings === "string" ? value.lineEndings : undefined, lineEnding),
      savedLineEndings: normalizeLineEndingMap(inlineSavedContent ? value.savedContent : "", typeof value.savedLineEndings === "string" ? value.savedLineEndings : undefined, lineEnding),
      bom: value.bom === true,
      savedBom: value.savedBom === true || (value.savedBom === undefined && value.bom === true),
      encoding: value.encoding === "UTF-8 BOM" ? "UTF-8 BOM" : "UTF-8",
    } : {}),
  };
  return recoverySnapshotSizeBytes(snapshot) <= MAX_RECOVERY_BYTES ? snapshot : null;
}

export function recoverySnapshotSizeBytes(snapshot: RecoverySnapshot): number {
  // IndexedDB stores strings through structured clone. Use the UTF-16 size
  // upper bound so checking the limit does not scan or copy the document.
  return (
    snapshot.tabId.length
    + snapshot.path.length
    + snapshot.content.length
    + (snapshot.savedContentUnavailable ? 0 : snapshot.savedContent.length)
    + (snapshot.lineEndings?.length ?? 0)
    + (snapshot.savedLineEndings?.length ?? 0)
  ) * 2 + 256;
}

/** Retain the edited text when a full baseline would exceed the per-document budget. */
export function compactRecoverySnapshot(snapshot: RecoverySnapshot): RecoverySnapshot | null {
  if ((snapshot.version !== 1 && snapshot.version !== 2) || !boundedString(snapshot.tabId, 256) || !boundedString(snapshot.path, MAX_PATH_LENGTH) || typeof snapshot.content !== "string" || typeof snapshot.savedContent !== "string") return null;
  if (recoverySnapshotSizeBytes(snapshot) <= MAX_RECOVERY_BYTES) return parseRecovery(snapshot);
  // v2 already stores the baseline by reference; without the inline baseline
  // there is nothing left to compact.
  if (snapshot.version === 2) return null;
  const compacted: RecoverySnapshot = {
    ...snapshot,
    savedContent: "",
    savedContentUnavailable: true,
    savedLineEndings: undefined,
  };
  return parseRecovery(compacted);
}

export function scopedStorageKey(baseKey: string, scope: string): string {
  return `${baseKey}:${encodeURIComponent(scope)}`;
}

export function recoveryStorageKey(tabId: string, scope = "default"): string {
  return `${RECOVERY_STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(tabId)}`;
}

export function recoveryBaselineKey(tabId: string, scope = "default"): string {
  return `${RECOVERY_BASELINE_STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(tabId)}`;
}

export function isRecoveryBaselineKey(key: string): boolean {
  return key.startsWith(RECOVERY_BASELINE_STORAGE_PREFIX);
}

/** Maps a per-tab recovery key to its baseline companion key (and back). */
export function baselineKeyForRecoveryKey(key: string): string | null {
  if (!isRecoveryStorageKey(key)) return null;
  return RECOVERY_BASELINE_STORAGE_PREFIX + key.slice(RECOVERY_STORAGE_PREFIX.length);
}

export function recoveryKeyForBaselineKey(key: string): string | null {
  if (!isRecoveryBaselineKey(key)) return null;
  return RECOVERY_STORAGE_PREFIX + key.slice(RECOVERY_BASELINE_STORAGE_PREFIX.length);
}

/** True when a recovery or baseline key belongs to the given scope. */
export function sameRecoveryStorageScope(key: string, scope: string): boolean {
  if (isRecoveryBaselineKey(key)) {
    const encoded = key.slice(RECOVERY_BASELINE_STORAGE_PREFIX.length);
    const separator = encoded.indexOf(":");
    if (separator < 0) return false;
    try {
      return decodeURIComponent(encoded.slice(0, separator)) === scope;
    } catch {
      return false;
    }
  }
  return sameRecoveryScope(key, scope);
}

export function parseRecoveryBaseline(raw: unknown): RecoveryBaseline | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)
    || value.version !== 1
    || !boundedString(value.tabId, 256)
    || !boundedString(value.path, MAX_PATH_LENGTH)
    || typeof value.savedContent !== "string") return null;
  const savedRevision = nonNegativeInteger(value.savedRevision);
  if (savedRevision === undefined) return null;
  const baseline: RecoveryBaseline = {
    version: 1,
    tabId: value.tabId,
    path: value.path,
    savedRevision,
    savedContent: value.savedContent,
    ...(typeof value.savedLineEndings === "string" ? { savedLineEndings: value.savedLineEndings } : {}),
    ...(typeof value.savedBom === "boolean" ? { savedBom: value.savedBom } : {}),
    ...(value.encoding === "UTF-8 BOM" ? { encoding: "UTF-8 BOM" as const } : {}),
  };
  return recoveryBaselineSizeBytes(baseline) <= MAX_RECOVERY_BYTES ? baseline : null;
}

export function recoveryBaselineSizeBytes(baseline: RecoveryBaseline): number {
  // Same UTF-16 structured-clone upper bound as recoverySnapshotSizeBytes.
  return (
    baseline.tabId.length
    + baseline.path.length
    + baseline.savedContent.length
    + (baseline.savedLineEndings?.length ?? 0)
  ) * 2 + 256;
}

/**
 * Fills a v2 snapshot's referenced baseline in memory. Snapshots whose
 * baseline record is missing or stale keep the savedContentUnavailable form,
 * which restore already handles by re-reading the baseline from disk.
 */
export function resolveRecoveryBaseline(snapshot: RecoverySnapshot | null, baseline: RecoveryBaseline | null | undefined): RecoverySnapshot | null {
  if (!snapshot || snapshot.version !== 2 || !snapshot.savedContentUnavailable || !baseline) return snapshot;
  if (baseline.tabId !== snapshot.tabId || baseline.path !== snapshot.path || baseline.savedRevision !== snapshot.savedRevision) return snapshot;
  const { savedContentUnavailable: _unavailable, ...rest } = snapshot;
  return {
    ...rest,
    savedContent: baseline.savedContent,
    savedLineEndings: baseline.savedLineEndings ?? snapshot.savedLineEndings,
    savedBom: baseline.savedBom ?? snapshot.savedBom,
    encoding: baseline.encoding ?? snapshot.encoding,
  };
}

/**
 * The form stored in the snapshots store. v2 snapshots never persist the
 * inline baseline (it lives in the baseline record); the in-memory resolved
 * form is only used for the self-contained fallback checkpoint JSON.
 */
export function recoverySnapshotStorageValue(snapshot: RecoverySnapshot): RecoverySnapshot {
  if (snapshot.version !== 2) return snapshot;
  const { savedContent: _savedContent, ...rest } = snapshot;
  return rest as RecoverySnapshot;
}

export function sessionCheckpointStorageKey(scope: string): string {
  return `${SESSION_CHECKPOINT_STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

export function sessionCheckpointMetadataStorageKey(scope: string): string {
  return `${SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

export function parseSessionCheckpoint(raw: unknown, baselines?: Record<string, RecoveryBaseline>): SessionCheckpoint | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)
    || (value.version !== SESSION_CHECKPOINT_SCHEMA_VERSION && value.version !== LEGACY_SESSION_CHECKPOINT_SCHEMA_VERSION)
    || !boundedString(value.scope, 256)
    || !boundedString(value.checkpointId, 512)) return null;
  const sequence = nonNegativeInteger(value.sequence);
  const committedAt = nonNegativeTimestamp(value.committedAt);
  if (sequence === undefined || committedAt === undefined || !isRecord(value.session) || !isRecord(value.recoveryRevisions) || !isRecord(value.recoveries)) return null;
  // Fallback checkpoints embed their baselines next to the recoveries so the
  // JSON stays self-contained; database checkpoints pass them separately.
  const resolvedBaselines = baselines ?? parseInlineBaselines(value.baselines);
  let session: SessionMetadata | null = null;
  try {
    session = parseSession(JSON.stringify(value.session));
  } catch {
    session = null;
  }
  if (!session || session.workspace.length > MAX_PATH_LENGTH) return null;
  const tabsByRecoveryKey = new Map(session.tabs.map((tab) => [recoveryStorageKey(tab.id, value.scope), tab]));
  const recoveryRevisions: Record<string, number | null> = {};
  for (const [key, revision] of Object.entries(value.recoveryRevisions)) {
    if (!isRecoveryStorageKey(key) || !key.includes(":")) continue;
    const tab = tabsByRecoveryKey.get(key);
    if (!tab || !tab.dirty) return null;
    if (revision === null) {
      recoveryRevisions[key] = null;
      continue;
    }
    const parsedRevision = nonNegativeInteger(revision);
    if (parsedRevision === undefined) return null;
    recoveryRevisions[key] = parsedRevision;
  }
  const recoveries: Record<string, RecoverySnapshot> = {};
  for (const [key, candidate] of Object.entries(value.recoveries)) {
    if (!isRecoveryStorageKey(key) || !key.includes(":")) continue;
    const snapshot = resolveRecoveryBaseline(parseRecovery(candidate), resolvedBaselines?.[key]);
    const tab = tabsByRecoveryKey.get(key);
    if (!snapshot || !tab || !tab.dirty || recoveryRevisions[key] !== snapshot.revision || recoveryStorageKey(snapshot.tabId, value.scope) !== key || snapshot.path !== tab.path || snapshot.revision !== tab.revision) return null;
    recoveries[key] = snapshot;
  }
  for (const [key, revision] of Object.entries(recoveryRevisions)) {
    if (revision !== null && !recoveries[key]) return null;
  }
  return {
    version: SESSION_CHECKPOINT_SCHEMA_VERSION,
    scope: value.scope,
    checkpointId: value.checkpointId,
    sequence,
    committedAt,
    session,
    recoveryRevisions,
    recoveries,
  };
}

/** Parses only session/checkpoint metadata. Recovery bodies are never touched. */
export function parseSessionCheckpointMetadata(
  raw: unknown,
  recoveryKeys?: readonly string[],
  source: "indexeddb" | "fallback" = "indexeddb",
): SessionCheckpointMetadataReadResult | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)
    || (value.version !== SESSION_CHECKPOINT_SCHEMA_VERSION && value.version !== LEGACY_SESSION_CHECKPOINT_SCHEMA_VERSION)
    || !boundedString(value.scope, 256)
    || !boundedString(value.checkpointId, 512)) return null;
  const sequence = nonNegativeInteger(value.sequence);
  const committedAt = nonNegativeTimestamp(value.committedAt);
  if (sequence === undefined || committedAt === undefined || !isRecord(value.session) || !isRecord(value.recoveryRevisions)) return null;

  let session: SessionMetadata | null = null;
  try {
    session = parseSession(JSON.stringify(value.session));
  } catch {
    session = null;
  }
  if (!session || session.workspace.length > MAX_PATH_LENGTH) return null;

  const tabsByRecoveryKey = new Map(session.tabs.map((tab) => [recoveryStorageKey(tab.id, value.scope as string), tab]));
  const recoveryRevisions: Record<string, number | null> = {};
  for (const [key, revision] of Object.entries(value.recoveryRevisions)) {
    const tab = tabsByRecoveryKey.get(key);
    if (!isRecoveryStorageKey(key) || !sameRecoveryScope(key, value.scope as string) || !tab || !tab.dirty) return null;
    if (revision === null) {
      recoveryRevisions[key] = null;
      continue;
    }
    const parsedRevision = nonNegativeInteger(revision);
    if (parsedRevision === undefined) return null;
    recoveryRevisions[key] = parsedRevision;
  }

  const expectedKeys = session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, value.scope as string));
  const suppliedKeys = recoveryKeys ?? Object.keys(recoveryRevisions);
  const keys = [...new Set(suppliedKeys.filter((key) => isRecoveryStorageKey(key) && sameRecoveryScope(key, value.scope as string)))].sort();
  const missingRecoveryKeys = expectedKeys.filter((key) => {
    const tab = tabsByRecoveryKey.get(key);
    const revision = recoveryRevisions[key];
    return !keys.includes(key) || revision === undefined || revision === null || revision !== tab?.revision;
  });
  const checkpoint: SessionCheckpointMetadata = {
    version: SESSION_CHECKPOINT_SCHEMA_VERSION,
    scope: value.scope,
    checkpointId: value.checkpointId,
    sequence,
    committedAt,
    session,
    recoveryRevisions,
    recoveryKeys: keys,
  };
  return { checkpoint, completeMetadata: missingRecoveryKeys.length === 0, missingRecoveryKeys, source };
}

function parseInlineBaselines(raw: unknown): Record<string, RecoveryBaseline> | undefined {
  if (!isRecord(raw)) return undefined;
  const baselines: Record<string, RecoveryBaseline> = {};
  for (const [key, candidate] of Object.entries(raw)) {
    const recoveryKey = isRecoveryBaselineKey(key) ? recoveryKeyForBaselineKey(key) : key;
    const baseline = parseRecoveryBaseline(candidate);
    if (!recoveryKey || !isRecoveryStorageKey(recoveryKey) || !baseline) return undefined;
    baselines[recoveryKey] = baseline;
  }
  return baselines;
}

export function parseSessionRegistry(raw: unknown): SessionRegistry | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value) || value.version !== SESSION_REGISTRY_SCHEMA_VERSION || !Array.isArray(value.windows)) return null;
  const revision = nonNegativeInteger(value.revision);
  const updatedAt = nonNegativeTimestamp(value.updatedAt);
  if (revision === undefined || updatedAt === undefined) return null;
  const windows: SessionWindowRecord[] = [];
  const seenLeases = new Set<string>();
  for (const candidate of value.windows) {
    if (!isRecord(candidate) || !boundedString(candidate.windowId, 256) || !boundedString(candidate.scope, 256) || typeof candidate.workspace !== "string" || candidate.workspace.length > MAX_PATH_LENGTH || !boundedString(candidate.leaseId, 512)) continue;
    const attachedAt = nonNegativeTimestamp(candidate.attachedAt);
    const heartbeatAt = nonNegativeTimestamp(candidate.heartbeatAt);
    const status = candidate.status === "closed" ? "closed" : candidate.status === "open" ? "open" : undefined;
    if (attachedAt === undefined || heartbeatAt === undefined || !status || seenLeases.has(candidate.leaseId)) continue;
    const dirtyRecoveryKeys = Array.isArray(candidate.dirtyRecoveryKeys)
      ? candidate.dirtyRecoveryKeys.filter((key): key is string => isRecoveryStorageKey(key))
      : [];
    const closedAt = nonNegativeTimestamp(candidate.closedAt);
    seenLeases.add(candidate.leaseId);
    windows.push({ windowId: candidate.windowId, scope: candidate.scope, leaseId: candidate.leaseId, workspace: candidate.workspace, attachedAt, heartbeatAt, dirtyRecoveryKeys: [...new Set(dirtyRecoveryKeys)], status, ...(closedAt === undefined ? {} : { closedAt }) });
  }
  return { version: SESSION_REGISTRY_SCHEMA_VERSION, revision, updatedAt, windows };
}

export function collectExpandedPaths(root: DirectoryEntry): string[] {
  const paths: string[] = [];
  const visit = (entry: DirectoryEntry) => {
    if (entry.kind === "directory" && entry.expanded) paths.push(entry.path);
    for (const child of entry.children ?? []) visit(child);
  };
  visit(root);
  return uniqueStrings(paths, MAX_CLEAN_TABS * 20);
}

/**
 * Keep the session metadata bounded for clean tabs while retaining every dirty
 * tab. Recovery cannot be complete if a dirty tab is dropped before the
 * checkpoint is built.
 */
export function retainSessionTabs<T extends { dirty: boolean }>(tabs: readonly T[]): T[] {
  const cleanLimit = MAX_CLEAN_TABS;
  let cleanTabCount = 0;
  return tabs.filter((tab) => {
    if (tab.dirty) return true;
    if (cleanTabCount >= cleanLimit) return false;
    cleanTabCount += 1;
    return true;
  });
}

export function sessionCheckpointStatus(checkpoint: SessionCheckpoint, source: "indexeddb" | "fallback"): SessionCheckpointReadResult {
  const missingRecoveryKeys = sessionDirtyRecoveryKeys(checkpoint).filter((key) => {
    const revision = checkpoint.recoveryRevisions[key];
    const snapshot = checkpoint.recoveries[key];
    const tab = checkpoint.session.tabs.find((candidate) => recoveryStorageKey(candidate.id, checkpoint.scope) === key);
    return revision === undefined
      || revision === null
      || !snapshot
      || snapshot.revision !== revision
      || !tab
      || snapshot.tabId !== tab.id
      || snapshot.path !== tab.path
      || snapshot.revision !== tab.revision;
  });
  return { checkpoint, complete: missingRecoveryKeys.length === 0, missingRecoveryKeys, source };
}

export function sessionDirtyRecoveryKeys(checkpoint: SessionCheckpoint): string[] {
  return checkpoint.session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, checkpoint.scope));
}

export function emptySessionRegistry(): SessionRegistry {
  return { version: SESSION_REGISTRY_SCHEMA_VERSION, revision: 0, updatedAt: 0, windows: [] };
}

export function mergeSessionRegistries(left: SessionRegistry, right: SessionRegistry): SessionRegistry {
  if (left.revision > right.revision) return left;
  if (right.revision > left.revision) return right;
  const byLease = new Map<string, SessionWindowRecord>();
  for (const record of [...left.windows, ...right.windows]) {
    const existing = byLease.get(record.leaseId);
    if (!existing) {
      byLease.set(record.leaseId, { ...record, dirtyRecoveryKeys: [...record.dirtyRecoveryKeys] });
      continue;
    }
    byLease.set(record.leaseId, {
      ...existing,
      status: existing.status === "open" || record.status === "open" ? "open" : "closed",
      heartbeatAt: Math.max(existing.heartbeatAt, record.heartbeatAt),
      attachedAt: Math.min(existing.attachedAt, record.attachedAt),
      closedAt: existing.closedAt === undefined || record.closedAt === undefined ? existing.closedAt ?? record.closedAt : Math.max(existing.closedAt, record.closedAt),
      dirtyRecoveryKeys: [...new Set([...existing.dirtyRecoveryKeys, ...record.dirtyRecoveryKeys])],
    });
  }
  return {
    version: SESSION_REGISTRY_SCHEMA_VERSION,
    revision: left.revision,
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
    windows: [...byLease.values()],
  };
}

/** Keep every open or dirty closed lease when the registry reaches its bound. */
export function compactSessionWindows(windows: SessionWindowRecord[]): SessionWindowRecord[] | null {
  if (windows.length <= MAX_SESSION_WINDOWS) return windows;
  const removable = windows
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === "closed" && entry.dirtyRecoveryKeys.length === 0)
    .sort((left, right) => {
      const leftAt = left.entry.closedAt ?? left.entry.heartbeatAt;
      const rightAt = right.entry.closedAt ?? right.entry.heartbeatAt;
      return leftAt - rightAt || left.entry.attachedAt - right.entry.attachedAt;
    });
  const removeCount = windows.length - MAX_SESSION_WINDOWS;
  if (removable.length < removeCount) return null;
  const removeIndexes = new Set(removable.slice(0, removeCount).map(({ index }) => index));
  return windows.filter((_entry, index) => !removeIndexes.has(index));
}

export function sameSessionLease(left: SessionWindowLease, right: SessionWindowLease): boolean {
  return left.windowId === right.windowId && left.scope === right.scope && left.leaseId === right.leaseId;
}

export function compareSessionCheckpoints(left: Pick<SessionCheckpoint, "sequence" | "committedAt" | "checkpointId">, right: Pick<SessionCheckpoint, "sequence" | "committedAt" | "checkpointId">): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  if (left.committedAt !== right.committedAt) return left.committedAt - right.committedAt;
  return left.checkpointId.localeCompare(right.checkpointId);
}

export function updateRegistryForLease(registry: SessionRegistry, lease: SessionWindowLease, dirtyRecoveryKeys: string[], now: number): SessionRegistry | null {
  if (!registry.windows.some((entry) => sameSessionLease(entry, lease) && entry.status === "open")) return null;
  return {
    version: SESSION_REGISTRY_SCHEMA_VERSION,
    revision: registry.revision + 1,
    updatedAt: now,
    windows: registry.windows.map((entry) => sameSessionLease(entry, lease) ? { ...entry, workspace: entry.workspace, heartbeatAt: now, dirtyRecoveryKeys: [...new Set(dirtyRecoveryKeys.filter(isRecoveryStorageKey))] } : entry),
  };
}

export function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function isRecoveryStorageKey(key: string): boolean {
  return key.startsWith(RECOVERY_STORAGE_PREFIX);
}

export function isSessionCheckpointStorageKey(key: string): boolean {
  return key.startsWith(SESSION_CHECKPOINT_STORAGE_PREFIX);
}

export function isPersistedRecoveryKey(key: string): boolean {
  return isRecoveryStorageKey(key) || isSessionCheckpointStorageKey(key) || key.startsWith(SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX) || isRecoveryBaselineKey(key);
}

export function sameRecoveryScope(key: string, scope: string): boolean {
  if (!isRecoveryStorageKey(key)) return false;
  const encoded = key.slice(RECOVERY_STORAGE_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator < 0) return false;
  try {
    return decodeURIComponent(encoded.slice(0, separator)) === scope;
  } catch {
    return false;
  }
}

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return value.length;
}

export function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 1_000_000_000 ? number : undefined;
}

export function nonNegativeTimestamp(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 9_000_000_000_000_000 ? number : undefined;
}

function parsePersistedTab(value: unknown): PersistedTab | null {
  if (!isRecord(value) || !boundedString(value.id, 256) || !boundedString(value.path, MAX_PATH_LENGTH)) return null;
  const cursorLine = positiveInteger(value.cursorLine) ?? 1;
  const cursorColumn = positiveInteger(value.cursorColumn) ?? 1;
  return {
    id: value.id,
    path: value.path,
    name: boundedString(value.name, 512) ?? baseName(value.path),
    pinned: value.pinned === true,
    dirty: value.dirty === true,
    lineEnding: value.lineEnding === "crlf" ? "crlf" : "lf",
    lineEndings: typeof value.lineEndings === "string" ? value.lineEndings : undefined,
    savedLineEndings: typeof value.savedLineEndings === "string" ? value.savedLineEndings : undefined,
    bom: value.bom === true,
    savedBom: value.savedBom === true,
    encoding: value.encoding === "UTF-8 BOM" ? "UTF-8 BOM" : "UTF-8",
    language: boundedString(value.language, 64) ?? "Plain Text",
    cursorLine,
    cursorColumn,
    revision: nonNegativeInteger(value.revision) ?? 0,
    savedRevision: nonNegativeInteger(value.savedRevision) ?? 0,
    contentVersion: nonNegativeInteger(value.contentVersion) ?? 0,
    diskModifiedAt: nonNegativeInteger(value.diskModifiedAt),
    diskSize: nonNegativeInteger(value.diskSize),
    diskFingerprint: boundedString(value.diskFingerprint, 128),
    diskIdentity: boundedString(value.diskIdentity, 128),
  };
}

function uniqueStrings(values: unknown[], limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1_000_000 ? number : undefined;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
