/// <reference types="node" />
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { history, insertNewline } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hotPathDataset from "../../tests/fixtures/hot-path-v1.json";
import { computeDocumentDirty, createLineEndingMapExtension, lineEndingMapFromString, lineEndingMapLength, lineEndingMapOf, lineEndingMapStorageBytes, lineEndingMapToString, majorityLineEnding } from "./line-ending-state";
import { createSessionMetadata, recoveryBaselineKey, recoveryStorageKey } from "./session-storage-schema";
import { commitSessionCheckpoint, readLatestSessionCheckpoint, type RecoveryBaseline, type RecoverySnapshot } from "./session-storage";
import { flattenVisibleTree, treeKeyboardAction, virtualTreeWindow, VisibleTreeModel, type VirtualTreeEntry } from "./tree-virtualization";
import type { DirectoryEntry, EditorTab } from "../types";

type NodeBenchmarkRuntime = {
  env: Record<string, string | undefined>;
  version: string;
  platform: string;
  arch: string;
};

type BenchmarkWork = Record<string, number | string | boolean>;
type BenchmarkSample = { round: number; sample: number; elapsedMs: number; work: BenchmarkWork };
type BenchmarkRoundSummary = { round: number; sampleCount: number; medianMs: number; p95Ms: number };
type BenchmarkReport = {
  datasetVersion: string;
  name: string;
  profile: string;
  label: string;
  revision: string;
  node: string;
  platform: string;
  arch: string;
  declaredProfile: string;
  timingEnvelope: string;
  sourceSnapshotSha256: string;
  sourceFiles: string[];
  warmupSamples: number;
  rounds: number;
  samplesPerRound: number;
  medianMs: number;
  p95Ms: number;
  perRound: BenchmarkRoundSummary[];
  samples: BenchmarkSample[];
};

const nodeRuntime = (globalThis as unknown as { process?: NodeBenchmarkRuntime }).process;
const benchmarkEnabled = nodeRuntime?.env.PUDE_HOT_PATH_BENCHMARK === "1";
const benchmarkReports: BenchmarkReport[] = [];
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(String(key), String(value)); }
}

const browserLocalStorage = new MemoryStorage();

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: browserLocalStorage });
});

// Hash the harness and every direct or lazy-loaded production algorithm this dataset measures.
const benchmarkSourceFiles = [
  ["src/lib/hot-path-regression.test.ts", new URL("./hot-path-regression.test.ts", import.meta.url)],
  ["src/lib/line-ending-state.ts", new URL("./line-ending-state.ts", import.meta.url)],
  ["src/lib/editor-cache-budget.ts", new URL("./editor-cache-budget.ts", import.meta.url)],
  ["src/lib/tree-virtualization.ts", new URL("./tree-virtualization.ts", import.meta.url)],
  ["src/lib/session-storage.ts", new URL("./session-storage.ts", import.meta.url)],
  ["src/lib/session-storage-runtime.ts", new URL("./session-storage-runtime.ts", import.meta.url)],
  ["src/lib/session-storage-idb.ts", new URL("./session-storage-idb.ts", import.meta.url)],
  ["src/lib/session-storage-fallback.ts", new URL("./session-storage-fallback.ts", import.meta.url)],
  ["src/lib/session-storage-locks.ts", new URL("./session-storage-locks.ts", import.meta.url)],
  ["src/lib/session-storage-schema.ts", new URL("./session-storage-schema.ts", import.meta.url)],
  ["src/lib/session-storage-basic.ts", new URL("./session-storage-basic.ts", import.meta.url)],
  ["src/lib/recovery-database-status.ts", new URL("./recovery-database-status.ts", import.meta.url)],
  ["src-tauri/src/lsp_manager.rs", new URL("../../src-tauri/src/lsp_manager.rs", import.meta.url)],
  ["src-tauri/tests/fixtures/lsp_burst_fixture.rs", new URL("../../src-tauri/tests/fixtures/lsp_burst_fixture.rs", import.meta.url)],
  ["tests/fixtures/hot-path-v1.json", new URL("../../tests/fixtures/hot-path-v1.json", import.meta.url)],
] as const;
let sourceSnapshotSha256: Promise<string> | undefined;

function getSourceSnapshotSha256(): Promise<string> {
  sourceSnapshotSha256 ??= (async () => {
    const hash = createHash("sha256");
    for (const [name, url] of benchmarkSourceFiles) {
      hash.update(name);
      hash.update("\0");
      hash.update(await readFile(url));
      hash.update("\0");
    }
    return hash.digest("hex");
  })();
  return sourceSnapshotSha256;
}

function summarizeTimes(times: readonly number[]): Pick<BenchmarkRoundSummary, "medianMs" | "p95Ms"> {
  const ordered = [...times].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const medianMs = ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? 0;
  const p95Ms = ordered[Math.ceil(0.95 * ordered.length) - 1] ?? 0;
  return { medianMs, p95Ms };
}

function fixtureLineEnding(value: string): "lf" | "crlf" {
  if (value === "lf" || value === "crlf") return value;
  throw new Error(`Unexpected line ending in hot-path fixture: ${value}`);
}

async function sampleOperation<T>(
  name: string,
  operation: () => T | Promise<T>,
  validate: (value: T) => void,
  work: (value: T) => BenchmarkWork,
): Promise<T> {
  const runOne = async (round: number, sample: number): Promise<{ value: T; record?: BenchmarkSample }> => {
    const start = performance.now();
    const value = await operation();
    const elapsedMs = performance.now() - start;
    validate(value);
    return {
      value,
      ...(benchmarkEnabled ? { record: { round, sample, elapsedMs, work: work(value) } } : {}),
    };
  };

  if (!benchmarkEnabled) return (await runOne(0, 0)).value;

  for (let index = 0; index < hotPathDataset.benchmarkPlan.warmupSamples; index += 1) {
    await runOne(-1, index);
  }

  const samples: BenchmarkSample[] = [];
  let lastValue: T | undefined;
  for (let round = 0; round < hotPathDataset.benchmarkPlan.rounds; round += 1) {
    for (let sample = 0; sample < hotPathDataset.benchmarkPlan.samplesPerRound; sample += 1) {
      const result = await runOne(round, sample);
      lastValue = result.value;
      if (result.record) samples.push(result.record);
    }
  }
  const overall = summarizeTimes(samples.map((sample) => sample.elapsedMs));
  const perRound = Array.from({ length: hotPathDataset.benchmarkPlan.rounds }, (_, round) => {
    const roundSamples = samples.filter((sample) => sample.round === round);
    return {
      round,
      sampleCount: roundSamples.length,
      ...summarizeTimes(roundSamples.map((sample) => sample.elapsedMs)),
    };
  });
  if (perRound.some((round) => round.sampleCount !== hotPathDataset.benchmarkPlan.samplesPerRound)) {
    throw new Error("Hot-path benchmark did not collect the declared number of samples in every round.");
  }
  const runtime = nodeRuntime;
  const sourceSha256 = await getSourceSnapshotSha256();
  benchmarkReports.push({
    datasetVersion: hotPathDataset.datasetVersion,
    name,
    profile: runtime?.env.PUDE_HOT_PATH_PROFILE ?? hotPathDataset.benchmarkPlan.declaredProfile,
    label: runtime?.env.PUDE_HOT_PATH_LABEL ?? "unlabelled",
    revision: runtime?.env.PUDE_HOT_PATH_REVISION ?? "unknown",
    node: runtime?.version ?? "unknown",
    platform: runtime?.platform ?? "unknown",
    arch: runtime?.arch ?? "unknown",
    declaredProfile: hotPathDataset.benchmarkPlan.declaredProfile,
    timingEnvelope: hotPathDataset.benchmarkPlan.timingEnvelope,
    sourceSnapshotSha256: sourceSha256,
    sourceFiles: benchmarkSourceFiles.map(([name]) => name),
    warmupSamples: hotPathDataset.benchmarkPlan.warmupSamples,
    rounds: hotPathDataset.benchmarkPlan.rounds,
    samplesPerRound: hotPathDataset.benchmarkPlan.samplesPerRound,
    medianMs: overall.medianMs,
    p95Ms: overall.p95Ms,
    perRound,
    samples,
  });
  if (lastValue === undefined) throw new Error("Hot-path benchmark produced no samples.");
  return lastValue;
}

afterAll(async () => {
  if (benchmarkReports.length) console.info(`PUDE_HOT_PATH_BENCHMARK ${JSON.stringify(benchmarkReports)}`);
  await clearRecoveryDatabase();
  browserLocalStorage.clear();
  if (originalLocalStorageDescriptor) Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function dirtyDocumentState() {
  const dataset = hotPathDataset.dirtyEdit;
  const doc = dataset.line.repeat(dataset.lineRepeat);
  const state = EditorState.create({ doc });
  const needleAt = doc.lastIndexOf(dataset.editNeedle);
  if (needleAt < 0) throw new Error("Dirty edit marker is missing from the fixed dataset.");
  const separatorMap = lineEndingMapFromString("l".repeat(state.doc.lines - 1));
  const change = { from: needleAt, to: needleAt + 1, insert: dataset.replacement.slice(0, 1) };
  return { state, separatorMap, change };
}

describe("versioned hot-path regression dataset", () => {
  it("marks a 4.25M-character same-length edit dirty and preserves the edited output", async () => {
    expect(hotPathDataset.schemaVersion).toBe(1);
    const { state, separatorMap, change } = dirtyDocumentState();
    const result = await sampleOperation(
      "equal-length-dirty-edit",
      () => {
        const edited = state.update({ changes: change }).state;
        return {
          text: edited.doc,
          dirty: computeDocumentDirty({
            text: edited.doc,
            savedText: state.doc,
            lineEndings: separatorMap,
            savedLineEndings: separatorMap,
            bom: false,
            savedBom: false,
          }),
        };
      },
      ({ text, dirty }) => {
        expect(text.length).toBe(hotPathDataset.dirtyEdit.expectedDocumentLength);
        expect(text.lines).toBe(hotPathDataset.dirtyEdit.expectedLineCount);
        expect(text.sliceString(change.from, change.from + 1)).toBe("1");
        expect(dirty).toBe(true);
      },
      ({ text, dirty }) => ({ documentChars: text.length, lineCount: text.lines, dirty }),
    );
    expect(result.dirty).toBe(true);
  });

  it("handles Enter in a 250k-marker tie with path-copied output and bounded retained bytes", async () => {
    const dataset = hotPathDataset.enterLineEnding;
    const doc = dataset.line.repeat(dataset.lineRepeat) + dataset.finalLine;
    const created = createLineEndingMapExtension(
      dataset.markers.repeat(dataset.markerRepeat),
      fixtureLineEnding(dataset.preferred),
    );
    const initialState = EditorState.create({ doc, extensions: [created.extension, history()] });
    const line = initialState.doc.line(dataset.enterLineNumber);
    const state = initialState.update({ selection: EditorSelection.cursor(line.from) }).state;
    const before = lineEndingMapOf(state, created.field);
    expect(before.lf).toBe(before.crlf);
    expect(majorityLineEnding(before)).toBe("crlf");
    const startOfInsertedSeparator = line.from;
    const expectedInsertIndex = dataset.enterLineNumber - 1;
    const expectedMarkers = dataset.markers.repeat(dataset.markerRepeat);
    const expectedInsertedMarker = expectedMarkers[expectedInsertIndex - 1] ?? dataset.markers[0];
    const expectedAfterMarkers = expectedMarkers.slice(0, expectedInsertIndex)
      + expectedInsertedMarker
      + expectedMarkers.slice(expectedInsertIndex);
    const bytesBefore = lineEndingMapStorageBytes([before.map]);

    const result = await sampleOperation(
      "enter-line-ending-map-tie",
      () => {
        let next: EditorState | undefined;
        const handled = insertNewline({ state, dispatch: (transaction) => { next = transaction.state; } });
        if (!handled || !next) throw new Error("CodeMirror Enter command did not dispatch.");
        const after = lineEndingMapOf(next, created.field);
        return { state: next, map: after.map, lf: after.lf, crlf: after.crlf };
      },
      ({ state: afterState, map, lf, crlf }) => {
        expect(afterState.doc.lines).toBe(state.doc.lines + 1);
        expect(lineEndingMapLength(map)).toBe(afterState.doc.lines - 1);
        expect(lineEndingMapToString(map)).toBe(expectedAfterMarkers);
        expect(lf + crlf).toBe(expectedAfterMarkers.length);
        const retainedBytes = lineEndingMapStorageBytes([before.map, map]);
        expect(retainedBytes - bytesBefore).toBeLessThanOrEqual(dataset.maxRetainedBytesAdded);
      },
      ({ map, lf, crlf }) => ({
        markerCount: lineEndingMapLength(map),
        lf,
        crlf,
        retainedMapBytes: lineEndingMapStorageBytes([before.map, map]),
      }),
    );
    expect(result.state.doc.lines).toBe(state.doc.lines + 1);
    expect(result.state.doc.sliceString(startOfInsertedSeparator, startOfInsertedSeparator + 2)).toBe("\nx");
  });

  it("keeps indexed tree lookup and immutable metadata updates within fixed work counts", async () => {
    const dataset = hotPathDataset.treeIndex;
    type PathEntry = VirtualTreeEntry & { path: string; size?: number };
    const initial: PathEntry = {
      path: "/repo",
      name: "repo",
      kind: "directory",
      expanded: true,
      children: Array.from({ length: dataset.directChildCount }, (_, index) => ({
        path: `/repo/file-${index}.ts`,
        name: `file-${index}.ts`,
        kind: "file" as const,
      })),
    };
    const options = { platform: "posix" as const, casePolicy: "sensitive" as const };
    const model = new VisibleTreeModel<PathEntry>(options);
    model.update(initial, false);
    expect(model.rows).toHaveLength(dataset.directChildCount + 1);
    const fullFlat = flattenVisibleTree(initial, false);
    const expectedPaths = fullFlat.map((row) => row.entry.path);
    expect(model.rows.map((row) => row.entry.path)).toEqual(expectedPaths);

    const beforeUpdate = { ...model.stats };
    const changedChildren = [...initial.children!] as PathEntry[];
    changedChildren[dataset.changedChildIndex] = {
      ...(changedChildren[dataset.changedChildIndex] as PathEntry),
      size: 42,
    };
    const changedRoot: PathEntry = { ...initial, children: changedChildren };
    model.update(changedRoot, false);
    expect(model.rows.map((row) => row.entry.path)).toEqual(flattenVisibleTree(changedRoot, false).map((row) => row.entry.path));
    expect(model.rows[dataset.changedChildIndex + 1].entry.size).toBe(42);
    expect(model.stats.fullBuilds).toBe(dataset.expectedFullBuilds);
    expect(model.stats.rowsUpdated - beforeUpdate.rowsUpdated).toBe(dataset.expectedRowsUpdated);
    expect(model.stats.visibleEntriesFlattened - beforeUpdate.visibleEntriesFlattened).toBe(dataset.expectedRowsFlattenedOnMetadataUpdate);
    expect(model.stats.directChildEntriesVisited - beforeUpdate.directChildEntriesVisited)
      .toBe(dataset.expectedDirectChildEntriesVisitedOnMetadataUpdate);
    expect(model.stats.directChildEntriesCompared - beforeUpdate.directChildEntriesCompared)
      .toBe(dataset.expectedDirectChildEntriesComparedOnMetadataUpdate);
    expect(model.stats.pathKeysComputed - beforeUpdate.pathKeysComputed)
      .toBe(dataset.expectedPathKeysComputedOnMetadataUpdate);

    const alternateChildren = [...initial.children!] as PathEntry[];
    alternateChildren[dataset.changedChildIndex] = {
      ...(alternateChildren[dataset.changedChildIndex] as PathEntry),
      size: 43,
    };
    const alternateRoot: PathEntry = { ...initial, children: alternateChildren };
    const focusedKeys = Array.from({ length: dataset.lookupsPerSample }, (_, index) =>
      model.rows[1 + ((index * 7919) % dataset.directChildCount)].pathKey,
    );
    const beforeLookups = { ...model.stats };
    const treeSampleCount = benchmarkEnabled
      ? hotPathDataset.benchmarkPlan.warmupSamples + hotPathDataset.benchmarkPlan.rounds * hotPathDataset.benchmarkPlan.samplesPerRound
      : 1;
    let nextUpdateRoot = alternateRoot;
    let treeUpdateSample = 0;
    const treeSamples = await sampleOperation(
      "tree-metadata-update-and-indexed-navigation",
      () => {
        const updateRoot = nextUpdateRoot;
        nextUpdateRoot = updateRoot === changedRoot ? alternateRoot : changedRoot;
        const beforeSample = { ...model.stats };
        const changed = model.update(updateRoot, false);
        const lookups = focusedKeys.map((key) => {
          const index = model.indexOfKey(key);
          const action = treeKeyboardAction(model.rows, index, "ArrowDown");
          const window = virtualTreeWindow(model.rows.length, index * 27, 540, 27, 8);
          return { index, action, windowRows: model.rows.slice(window.start, window.end).map((row) => row.entry.path) };
        });
        if (nodeRuntime?.env.PUDE_HOT_PATH_INJECT_REGRESSION === "tree-full-rebuild") {
          const injectedFullRebuild = flattenVisibleTree(updateRoot, false);
          model.stats.visibleEntriesFlattened += injectedFullRebuild.length;
        }
        const sampleIndex = treeUpdateSample++;
        return {
          updateRoot,
          changed,
          lookups,
          work: {
            lookups: model.stats.indexLookups - beforeSample.indexLookups,
            fullBuilds: model.stats.fullBuilds - beforeSample.fullBuilds,
            flattenedRows: model.stats.visibleEntriesFlattened - beforeSample.visibleEntriesFlattened,
            directChildEntriesVisited: model.stats.directChildEntriesVisited - beforeSample.directChildEntriesVisited,
            directChildEntriesCompared: model.stats.directChildEntriesCompared - beforeSample.directChildEntriesCompared,
            pathKeysComputed: model.stats.pathKeysComputed - beforeSample.pathKeysComputed,
            rowsUpdated: model.stats.rowsUpdated - beforeSample.rowsUpdated,
            indexMapBuilds: model.stats.indexMapBuilds - beforeSample.indexMapBuilds,
            expectedNewPathKeys: sampleIndex === 0 ? dataset.expectedPathKeysComputedOnMetadataUpdate : 0,
          },
        };
      },
      ({ updateRoot, changed, lookups, work }) => {
        expect(changed).toBe(true);
        expect(model.rows).toHaveLength(dataset.directChildCount + 1);
        expect(model.rows.map((row) => row.entry.path)).toEqual(expectedPaths);
        const expectedSize = updateRoot === changedRoot ? 42 : 43;
        expect(model.rows[dataset.changedChildIndex + 1].entry.size).toBe(expectedSize);
        expect(lookups).toHaveLength(dataset.lookupsPerSample);
        for (let index = 0; index < lookups.length; index += 1) {
          const actualRow = model.rows[lookups[index].index];
          expect(actualRow.pathKey).toBe(focusedKeys[index]);
          expect(lookups[index].action).toEqual({ kind: "focus", index: Math.min(lookups[index].index + 1, model.rows.length - 1) });
          expect(lookups[index].windowRows).toContain(actualRow.entry.path);
        }
        expect(work.lookups).toBe(dataset.lookupsPerSample);
        expect(work.fullBuilds).toBe(0);
        expect(work.flattenedRows).toBe(0);
        expect(work.directChildEntriesVisited).toBe(dataset.expectedDirectChildEntriesVisitedOnMetadataUpdate);
        expect(work.directChildEntriesCompared).toBe(dataset.expectedDirectChildEntriesComparedOnMetadataUpdate);
        expect(work.pathKeysComputed).toBe(work.expectedNewPathKeys);
        expect(work.rowsUpdated).toBe(dataset.expectedRowsUpdated);
        expect(work.indexMapBuilds).toBe(0);
      },
      ({ work }) => work,
    );
    expect(treeSamples.lookups).toHaveLength(dataset.lookupsPerSample);
    expect(model.stats.indexLookups - beforeLookups.indexLookups).toBe(dataset.lookupsPerSample * treeSampleCount);
    expect(model.stats.fullBuilds).toBe(beforeLookups.fullBuilds);
    expect(model.stats.visibleEntriesFlattened - beforeLookups.visibleEntriesFlattened).toBe(0);
    expect(model.stats.indexMapBuilds).toBe(beforeLookups.indexMapBuilds);
    expect(model.stats.directChildEntriesCompared - beforeUpdate.directChildEntriesCompared)
      .toBe(dataset.expectedDirectChildEntriesComparedOnMetadataUpdate * (treeSampleCount + 1));
    expect(model.stats.directChildEntriesVisited - beforeUpdate.directChildEntriesVisited)
      .toBe(dataset.expectedDirectChildEntriesVisitedOnMetadataUpdate * (treeSampleCount + 1));
    expect(model.stats.rowsUpdated - beforeUpdate.rowsUpdated)
      .toBe(dataset.expectedRowsUpdated * (treeSampleCount + 1));
    expect(model.stats.pathKeysComputed - beforeUpdate.pathKeysComputed)
      .toBe(dataset.expectedPathKeysComputedOnMetadataUpdate * 2);
    expect(model.stats.indexMapWrites).toBe(beforeLookups.indexMapWrites);
  });

  it("writes only changed recovery bodies and restores the complete 12-document result", async () => {
    const dataset = hotPathDataset.recoveryCheckpoint;
    const scope = dataset.scope;
    const baselineText = (index: number) => `saved-${index}:`.padEnd(dataset.documentChars, "s");
    const contentText = (index: number) => `edited-${index}:`.padEnd(dataset.documentChars, "x");
    const tabs = Array.from({ length: dataset.documentCount }, (_, index): EditorTab => ({
      id: `hot-tab-${index}`,
      path: `/workspace/src/file-${index}.ts`,
      name: `file-${index}.ts`,
      content: contentText(index),
      savedContent: baselineText(index),
      dirty: true,
      lineEnding: "lf",
      lineEndings: "",
      savedLineEndings: "",
      bom: false,
      savedBom: false,
      encoding: "UTF-8",
      language: "TypeScript",
      cursorLine: 1,
      cursorColumn: 0,
      revision: 2,
      savedRevision: 1,
      contentVersion: 1,
    }));
    const root: DirectoryEntry = { name: "workspace", path: "/workspace", kind: "directory", expanded: true, children: [] };
    const session = createSessionMetadata("/workspace", tabs[0].id, tabs, root);
    const makeRecovery = (tab: EditorTab): RecoverySnapshot => ({
      version: 2,
      tabId: tab.id,
      path: tab.path,
      revision: tab.revision,
      savedRevision: tab.savedRevision,
      content: tab.content,
      savedContent: "",
      savedContentUnavailable: true,
      lineEnding: "lf",
      lineEndings: "",
      savedLineEndings: "",
      bom: false,
      savedBom: false,
      encoding: "UTF-8",
    });
    const makeBaseline = (tab: EditorTab): RecoveryBaseline => ({
      version: 1,
      tabId: tab.id,
      path: tab.path,
      savedRevision: tab.savedRevision,
      savedContent: tab.savedContent,
      savedLineEndings: "",
      savedBom: false,
      encoding: "UTF-8",
    });
    const recoveries = tabs.map(makeRecovery);
    const baselines = tabs.map(makeBaseline);
    await clearRecoveryDatabase();
    const first = await commitSessionCheckpoint({ scope, session, recoveries, baselines, now: 10_000 });
    expect(first).toMatchObject({ ok: true, complete: true, durability: "indexeddb" });
    expect(first.updatedRecoveryKeys).toHaveLength(dataset.documentCount);

    const metadataOnlySession = {
      ...session,
      tabs: session.tabs.map((tab, index) => index === 0 ? { ...tab, cursorLine: 2 } : tab),
    };
    const metadataTrace = await traceRecoveryBodyPuts(() => commitSessionCheckpoint({ scope, session: metadataOnlySession, now: 10_001 }));
    expect(metadataTrace.result).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [] });
    expect(metadataTrace.puts).toHaveLength(dataset.expectedUnchangedSnapshotPuts);
    expect(metadataTrace.bytes).toBe(0);

    const changedIndex = dataset.changedDocumentIndex;
    const changedTab: EditorTab = {
      ...tabs[changedIndex],
      revision: 3,
      content: `changed-${changedIndex}:`.padEnd(dataset.documentChars, "y"),
    };
    const changedTabs = tabs.map((tab, index) => index === changedIndex ? changedTab : tab);
    const changedSession = createSessionMetadata("/workspace", tabs[0].id, changedTabs, root);
    const changedSnapshot = makeRecovery(changedTab);
    const changedTrace = await traceRecoveryBodyPuts(() => commitSessionCheckpoint({
      scope,
      session: changedSession,
      recoveries: [changedSnapshot],
      now: 10_002,
    }));
    const changedKey = recoveryStorageKey(changedTab.id, scope);
    expect(changedTrace.result).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [changedKey] });
    expect(changedTrace.puts).toHaveLength(dataset.expectedChangedSnapshotPuts);
    expect(changedTrace.puts[0].key).toBe(changedKey);
    expect(changedTrace.bytes).toBeGreaterThan(0);
    expect(changedTrace.puts[0].store).toBe("snapshots");
    expect(changedTrace.bytes).toBeLessThanOrEqual(dataset.maxChangedSnapshotPutUtf8Bytes);
    expect(changedTrace.puts.filter((put) => put.store === "baselines")).toHaveLength(dataset.expectedChangedBaselinePuts);
    expect(dataset.expectedChangedBaselinePuts).toBe(0);

    const sampleCount = benchmarkEnabled
      ? hotPathDataset.benchmarkPlan.warmupSamples + hotPathDataset.benchmarkPlan.rounds * hotPathDataset.benchmarkPlan.samplesPerRound
      : 1;
    const checkpointUpdates = Array.from({ length: sampleCount }, (_, index) => {
      const nextTab: EditorTab = { ...changedTab, revision: changedTab.revision + index + 1 };
      const nextTabs = changedTabs.map((tab, tabIndex) => tabIndex === changedIndex ? nextTab : tab);
      return {
        session: createSessionMetadata("/workspace", tabs[0].id, nextTabs, root),
        recovery: makeRecovery(nextTab),
      };
    });
    let checkpointSample = 0;
    const sampledCheckpoint = await sampleOperation(
      "checkpoint-differential-one-of-twelve",
      async () => {
        const update = checkpointUpdates[checkpointSample++];
        const result = await commitSessionCheckpoint({
          scope,
          session: update.session,
          recoveries: [update.recovery],
          now: 10_003 + checkpointSample,
        });
        return { result, snapshotUtf8Bytes: changedTrace.bytes };
      },
      ({ result }) => {
        expect(result).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [changedKey] });
      },
      ({ result, snapshotUtf8Bytes }) => ({
        changedSnapshots: result.updatedRecoveryKeys.length,
        changedRecoveryKeys: result.updatedRecoveryKeys.join(","),
        snapshotUtf8Bytes,
        committedSequence: result.checkpoint?.sequence ?? 0,
      }),
    );
    expect(sampledCheckpoint.result.updatedRecoveryKeys).toEqual([changedKey]);

    const restored = await readLatestSessionCheckpoint(scope);
    expect(restored?.session.tabs).toHaveLength(dataset.documentCount);
    for (const tab of changedTabs) {
      const key = recoveryStorageKey(tab.id, scope);
      expect(restored?.recoveries[key].content).toBe(tab.content);
      expect(restored?.recoveries[key].savedContent).toBe(baselineText(Number(tab.id.slice("hot-tab-".length))));
      const expectedRevision = tab.id === changedTab.id
        ? checkpointUpdates[sampleCount - 1].recovery.revision
        : tab.revision;
      expect(restored?.recoveryRevisions[key]).toBe(expectedRevision);
    }
  });

  it("pins the real native LSP burst dataset and its output contract", () => {
    expect(hotPathDataset.lspBurst.requestCounts).toEqual([200, 1000]);
    expect(hotPathDataset.lspBurst.eventsPerRequest).toBe(2);
    expect(hotPathDataset.lspBurst.eventOrder).toEqual(["publishDiagnostics", "response"]);
    expect(hotPathDataset.benchmarkPlan).toMatchObject({ warmupSamples: 3, rounds: 3, samplesPerRound: 30 });
  });

  it("uses even-sample median averaging and nearest-rank P95", () => {
    expect(summarizeTimes([1, 2, 3, 4])).toEqual({ medianMs: 2.5, p95Ms: 4 });
    expect(summarizeTimes(Array.from({ length: 30 }, (_, index) => index + 1)))
      .toEqual({ medianMs: 15.5, p95Ms: 29 });
  });
});

type RecoveryBodyPut = { store: "snapshots" | "baselines"; key: string; value: unknown; bytes: number };

async function traceRecoveryBodyPuts<T>(operation: () => Promise<T>): Promise<{ result: T; puts: RecoveryBodyPut[]; bytes: number }> {
  const originalPut = IDBObjectStore.prototype.put;
  const puts: RecoveryBodyPut[] = [];
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    if ((this.name === "snapshots" || this.name === "baselines") && typeof key === "string") {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("Recovery body put value must serialize to JSON.");
      puts.push({ store: this.name, key, value, bytes: new TextEncoder().encode(serialized).byteLength });
    }
    return originalPut.call(this, value, key);
  };
  try {
    const result = await operation();
    return { result, puts, bytes: puts.reduce((total, put) => total + put.bytes, 0) };
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
}

async function clearRecoveryDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("pude-recovery-v1");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
