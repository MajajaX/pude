import { createEffect, onCleanup, onMount } from "solid-js";
import { minimalSetup } from "codemirror";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { Compartment, EditorState, Text, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, scrollPastEnd } from "@codemirror/view";
import { search, setSearchQuery, SearchQuery, findNext, replaceNext, replaceAll } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { fileLanguageForPath, normalizeDocumentContent, normalizeEditorDocumentSource, normalizeLineEndingMap, normalizeLineEndingMapForLineBreakCount } from "../lib/file-metadata";
import {
  createLineEndingMapExtension,
  computeDocumentDirty,
  lineEndingMapFromString,
  lineEndingMapOf,
  lineEndingMapToString,
  majorityLineEnding,
  type LineEndingHistory,
  type LineEndingMap,
  type LineEndingMapState,
} from "../lib/line-ending-state";
import { createPluginEditorEditTransaction, type PluginEditorEdit } from "../lib/plugin-editor-edits";
import { loadEditorLanguageSupport, shouldLoadEditorLanguage } from "../lib/editor-languages";
import { markStartupEvent } from "../lib/startup-timeline";
import { changedEditorSettings, EDITOR_CACHE_MAX_BYTES, EDITOR_CACHE_MAX_STATES, estimateEditorDocumentCacheBytes, exceedsEditorStateBudget, hasEditorUndoHistory, leastRecentlyUsedEditor, serializeEditorHistory, type EditorDocumentEvictionState, type EditorDocumentFootprint } from "../lib/editor-cache";
import { editorContentName } from "../lib/editor-accessibility";
import { createSearchActionGate } from "../lib/search-action-gate";
import { largeFileModeForSize, serializedDocumentByteLength, updateUtf8ByteLength, utf8ByteLength } from "../lib/document-size";
import { currentEditorSelectionFallback } from "../lib/editor-selection-fallback";
import type { StateField } from "@codemirror/state";
import type { AppSettings, EditorEncoding, EditorTab, LineEnding } from "../types";

export type SearchRequest = {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  action: "find" | "replace" | "replaceAll" | null;
  actionId: number;
};

export type GoToLineRequest = { line: number; actionId: number; tabId?: string; query?: string; caseSensitive?: boolean };

export type EditorSettings = Pick<AppSettings, "theme" | "fontSize" | "tabSize" | "insertSpaces" | "wordWrap">;

export type EditorDocumentChange = {
  tabId: string;
  revision: number;
  dirty: boolean;
  lineEnding: LineEnding;
  estimatedBytes: number;
  largeFile: boolean;
};

export type EditorDocumentMetadata = {
  revision: number;
  estimatedBytes: number;
  largeFile: boolean;
};

export type EditorDocumentSeed = {
  content: string;
  lineEndings: string;
  savedContent: string;
  savedLineEndings: string;
  lineEnding: LineEnding;
  bom: boolean;
  savedBom: boolean;
  encoding: EditorEncoding;
  revision: number;
  savedRevision: number;
  sourceVersion: number;
  estimatedBytes: number;
  largeFile: boolean;
  cursor?: { line: number; column: number };
  selectionJSON?: unknown;
  historyJSON?: unknown;
  lineEndingHistory?: LineEndingHistory;
};

/** A consistent view of one document: text plus the metadata needed to save it. */
export type EditorDocumentSnapshot = {
  content: string;
  revision: number;
  lineEndings: string;
  lineEnding: LineEnding;
  bom: boolean;
  encoding: EditorEncoding;
  savedRevision: number;
  savedLineEndings: string;
  savedBom: boolean;
  estimatedBytes: number;
};

export type EditorDocumentHandle = {
  getText: () => string;
  getRange: (from: number, to: number) => string;
  getTextLength: () => number;
  getMetadata: () => EditorDocumentMetadata | undefined;
  getCacheFootprint: () => EditorDocumentFootprint;
  getCacheEvictionState: () => EditorDocumentEvictionState;
  getSnapshot: () => EditorDocumentSnapshot | undefined;
  getDetachedDocument: () => EditorDocumentSeed | undefined;
  getSelection: () => { anchor: number; head: number; from: number; to: number; text: string } | undefined;
  getCursor: () => { line: number; column: number; offset: number } | undefined;
  applyEdits: (expectedRevision: number, edits: readonly PluginEditorEdit[]) => boolean;
};

type EditorPaneProps = {
  tab?: EditorTab;
  openTabIds: readonly string[];
  settings: EditorSettings;
  searchQuery: string;
  searchReplace: string;
  searchCaseSensitive: boolean;
  searchRegexp: boolean;
  searchWholeWord: boolean;
  searchAction: SearchRequest["action"];
  searchActionId: number;
  searchActionTargetTabId: string | undefined;
  onSearchActionConsumed: (tabId: string, actionId: number) => void;
  getCachedDocument: (tabId: string) => EditorDocumentSeed | undefined;
  goToLine?: GoToLineRequest;
  onFontSizeChange: (fontSize: number) => void;
  onDocumentChange: (change: EditorDocumentChange) => void;
  onCursorChange: (tabId: string, line: number, column: number) => void;
  onRegisterDocument: (tabId: string, handle: EditorDocumentHandle) => void;
  onUnregisterDocument: (tabId: string, retainedHandle?: EditorDocumentHandle) => void;
};

const lightEditorTheme = EditorView.theme({
  "&": { backgroundColor: "#f8f9fa", color: "#273039" },
  ".cm-content": { caretColor: "#3964b8" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3964b8" },
  ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#cddafa" },
  ".cm-gutters": { backgroundColor: "#f8f9fa", color: "#98a0a7", borderRight: "1px solid #d4d9de" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#edf1f9" },
});

const editorFontSizeTheme = (fontSize: number) => EditorView.theme({
  ".cm-content, .cm-gutters, .cm-line, .cm-gutterElement": {
    fontSize: `${fontSize}px !important`,
    lineHeight: "1.65 !important",
  },
});

type CachedDocument = {
  state?: EditorState;
  text: Text;
  lineEndingField?: StateField<LineEndingMapState>;
  lineEndingMap: LineEndingMap;
  lineEnding: LineEnding;
  savedLineEndingMap: LineEndingMap;
  bom: boolean;
  savedBom: boolean;
  encoding: EditorEncoding;
  selectionJSON?: unknown;
  historyJSON?: unknown;
  path: string;
  sourceVersion: number;
  revision: number;
  savedRevision: number;
  savedText: Text;
  savedCandidates: Map<number, { text: Text; lineEndingMap: LineEndingMap; bom: boolean }>;
  lineEndingHistory: LineEndingHistory;
  estimatedUtf8Bytes: number;
  lastEstimatedUtf8Bytes: number;
  estimatedBytes: number;
  largeFile: boolean;
  settings: EditorSettings;
  lastUsed: number;
  historyBytesEstimate: number;
  selectionBytesEstimate: number;
};

// MS-01: mark the first CodeMirror view creation once per window.
let firstEditorViewMarked = false;
let firstEditableDocumentMarked = false;

export function EditorPane(props: EditorPaneProps) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let activeDocumentId = "";
  let syncing = false;
  const themeCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const indentCompartment = new Compartment();
  const tabSizeCompartment = new Compartment();
  const languageCompartment = new Compartment();
  const documents = new Map<string, CachedDocument>();
  let searchRevision = 0;
  let languageRevision = 0;
  let usageClock = 0;
  const searchActionGate = createSearchActionGate();

  const updateContentAccessibleName = (name = props.tab?.name) => {
    const content = host.querySelector<HTMLElement>(".cm-content");
    if (content) content.setAttribute("aria-label", name ? `Editing ${name}` : "Editor");
  };

  const serializedBytes = (value: unknown): number => {
    if (value === undefined) return 0;
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 0;
    }
  };

  const touchDocument = (document: CachedDocument) => {
    document.lastUsed = ++usageClock;
  };

  const documentFootprint = (document: CachedDocument): EditorDocumentFootprint => {
    const currentText = document.state?.doc ?? document.text;
    const lineState = document.state && document.lineEndingField
      ? lineEndingMapOf(document.state, document.lineEndingField)
      : undefined;
    const lineEndingHistory = lineState?.history ?? document.lineEndingHistory;
    const lineEndingMaps = [
      lineState?.map ?? document.lineEndingMap,
      document.savedLineEndingMap,
    ];
    const texts = [currentText, document.savedText];
    for (const candidate of document.savedCandidates.values()) {
      texts.push(candidate.text);
      lineEndingMaps.push(candidate.lineEndingMap);
    }
    for (const history of [lineEndingHistory.done, lineEndingHistory.undone]) {
      for (const event of history) lineEndingMaps.push(event.before, event.after);
    }
    return {
      texts: texts.map((text) => ({ identity: text, codeUnits: text.length })),
      lineEndingMaps,
      serializedHistoryBytes: document.historyBytesEstimate,
      lineEndingHistoryEntries: lineEndingHistory.done.length + lineEndingHistory.undone.length,
      selectionBytes: document.selectionBytesEstimate,
      hasState: Boolean(document.state),
    };
  };

  const documentCacheBytes = (): number =>
    estimateEditorDocumentCacheBytes([...documents.values()].map(documentFootprint));

  const captureDocumentState = (document: CachedDocument): boolean => {
    const state = document.state;
    if (!state) return false;
    const historyJSON = serializeEditorHistory(state);
    if (historyJSON === undefined) return false;
    document.text = state.doc;
    document.selectionJSON = state.selection.toJSON();
    document.selectionBytesEstimate = serializedBytes(document.selectionJSON);
    document.historyJSON = historyJSON;
    document.historyBytesEstimate = serializedBytes(historyJSON);
    document.lineEndingMap = document.lineEndingField ? lineEndingMapOf(state, document.lineEndingField).map : document.lineEndingMap;
    document.state = undefined;
    document.lineEndingField = undefined;
    return true;
  };

  const pruneEditorStates = () => {
    let stateCount = [...documents.values()].filter((document) => document.state).length;
    let totalBytes = documentCacheBytes();

    while (exceedsEditorStateBudget(stateCount, totalBytes, EDITOR_CACHE_MAX_STATES, EDITOR_CACHE_MAX_BYTES)) {
      const candidate = leastRecentlyUsedEditor(
        [...documents.entries()].map(([id, document]) => ({
          id,
          lastUsed: document.lastUsed,
          stateBytes: document.text.length * 2 + document.historyBytesEstimate + 2048,
          hasState: Boolean(document.state),
        })),
        activeDocumentId,
      );
      if (!candidate) break;
      const document = documents.get(candidate.id);
      if (!document?.state) break;
      if (!captureDocumentState(document)) break;
      stateCount -= 1;
      totalBytes = documentCacheBytes();
    }
  };

  const updateListener = EditorView.updateListener.of((update) => {
    const document = documents.get(activeDocumentId);
    if (document) {
      document.state = update.state;
      document.text = update.state.doc;
      document.selectionJSON = update.state.selection.toJSON();
      document.selectionBytesEstimate = serializedBytes(document.selectionJSON);
      const lineState = document.lineEndingField ? lineEndingMapOf(update.state, document.lineEndingField) : undefined;
      if (lineState) {
        document.lineEndingHistory = lineState.history;
        document.lineEnding = majorityLineEnding(lineState);
      }
      if (update.docChanged) {
        let changedCodeUnits = 0;
        update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          changedCodeUnits += to - from + inserted.length;
        });
        const isHistoryReplay = update.transactions.some((transaction) => {
          const userEvent = transaction.annotation(Transaction.userEvent);
          return userEvent === "undo" || userEvent === "redo" || userEvent === "select.undo" || userEvent === "select.redo";
        });
        if (!isHistoryReplay) document.historyBytesEstimate += Math.max(128, changedCodeUnits * 4 + 128);
        document.estimatedUtf8Bytes += updateUtf8ByteLength(update.startState.doc, update.state.doc, update.changes);
      } else if (update.selectionSet && update.transactions.some((transaction) =>
        transaction.annotation(Transaction.userEvent)?.startsWith("select") === true,
      )) {
        document.historyBytesEstimate += 96;
      }
      touchDocument(document);
    }
    if (!document) return;

    if (update.docChanged && !syncing) {
      document.revision += 1;
      const mapState = document.lineEndingField ? lineEndingMapOf(update.state, document.lineEndingField) : undefined;
      const lineEndingMap = mapState?.map ?? document.lineEndingMap;
      const previousCrLf = document.lineEndingMap.crlf;
      document.estimatedBytes += document.estimatedUtf8Bytes - document.lastEstimatedUtf8Bytes + lineEndingMap.crlf - previousCrLf;
      document.lastEstimatedUtf8Bytes = document.estimatedUtf8Bytes;
      document.lineEndingMap = lineEndingMap;
      if (mapState) document.lineEnding = majorityLineEnding(mapState);
      const largeFile = largeFileModeForSize(document.largeFile, document.estimatedBytes);
      const dirty = computeDocumentDirty({
        text: update.state.doc,
        savedText: document.savedText,
        lineEndings: lineEndingMap,
        savedLineEndings: document.savedLineEndingMap,
        bom: document.bom,
        savedBom: document.savedBom,
      });
      props.onDocumentChange({
        tabId: activeDocumentId,
        revision: document.revision,
        dirty,
        lineEnding: document.lineEnding,
        estimatedBytes: document.estimatedBytes,
        largeFile,
      });
    }
    if (update.selectionSet) {
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head);
      props.onCursorChange(activeDocumentId, line.number, head - line.from + 1);
    }
  });

  const handleWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const nextSize = props.settings.fontSize + (event.deltaY < 0 ? 1 : -1);
    props.onFontSizeChange(Math.max(11, Math.min(24, nextSize)));
  };

  const textFromNormalizedString = (content: string) => Text.of(content.split("\n"));

  const currentTextOf = (document: CachedDocument): Text => document.state?.doc ?? document.text;

  const currentLineEndingMapOf = (document: CachedDocument): LineEndingMap =>
    document.state && document.lineEndingField
      ? lineEndingMapOf(document.state, document.lineEndingField).map
      : document.lineEndingMap;

  const currentLargeFileModeOf = (document: CachedDocument): boolean =>
    largeFileModeForSize(document.largeFile, document.estimatedBytes);

  const cacheEvictionStateOf = (document: CachedDocument): EditorDocumentEvictionState => {
    const lineEndingHistory = document.state && document.lineEndingField
      ? lineEndingMapOf(document.state, document.lineEndingField).history
      : document.lineEndingHistory;
    const dirty = computeDocumentDirty({
      text: currentTextOf(document),
      savedText: document.savedText,
      lineEndings: currentLineEndingMapOf(document),
      savedLineEndings: document.savedLineEndingMap,
      bom: document.bom,
      savedBom: document.savedBom,
    });
    const hasUndoHistory = hasEditorUndoHistory(
      document.state,
      document.historyJSON,
      lineEndingHistory.done.length + lineEndingHistory.undone.length,
    );
    return {
      lastUsed: document.lastUsed,
      dirty,
      hasUndoHistory,
      // Release is safe only for an already-detached record. The owner must
      // also synchronously reconcile the exact seed into its fallback state.
      canRelease: !document.state && !dirty && !hasUndoHistory,
    };
  };

  const createDocumentHandle = (tabId: string, document: CachedDocument): EditorDocumentHandle => ({
      getText: () => {
        return currentTextOf(document).toString();
      },
      getRange: (from, to) => {
        const text = currentTextOf(document);
        const start = Math.max(0, Math.min(text.length, from));
        const end = Math.max(start, Math.max(0, Math.min(text.length, to)));
        return text.sliceString(start, end);
      },
      getTextLength: () => {
        return currentTextOf(document).length;
      },
      getMetadata: () => {
        return {
          revision: document.revision,
          estimatedBytes: document.estimatedBytes,
          largeFile: currentLargeFileModeOf(document),
        };
      },
      getCacheFootprint: () => documentFootprint(document),
      getCacheEvictionState: () => cacheEvictionStateOf(document),
      getSnapshot: () => {
        const text = currentTextOf(document);
        const lineState = document.state && document.lineEndingField ? lineEndingMapOf(document.state, document.lineEndingField) : undefined;
        const lineEndingMap = lineState?.map ?? document.lineEndingMap;
        const lineEndings = lineEndingMapToString(lineEndingMap);
        document.savedCandidates.set(document.revision, { text, lineEndingMap, bom: document.bom });
        while (document.savedCandidates.size > 64) document.savedCandidates.delete(document.savedCandidates.keys().next().value!);
        return {
          content: text.toString(),
          revision: document.revision,
          lineEndings,
          lineEnding: lineState ? majorityLineEnding(lineState) : document.lineEnding,
          bom: document.bom,
          encoding: document.encoding,
          savedRevision: document.savedRevision,
          savedLineEndings: lineEndingMapToString(document.savedLineEndingMap),
          savedBom: document.savedBom,
          estimatedBytes: document.estimatedBytes,
        };
      },
      getDetachedDocument: () => {
        const text = currentTextOf(document);
        const lineState = document.state && document.lineEndingField ? lineEndingMapOf(document.state, document.lineEndingField) : undefined;
        const lineEndingMap = lineState?.map ?? document.lineEndingMap;
        const historyJSON = document.state ? serializeEditorHistory(document.state) : document.historyJSON;
        const history = lineState?.history ?? document.lineEndingHistory;
        const selection = document.state?.selection.main;
        const storedSelection = document.selectionJSON as { main?: number; mainIndex?: number; ranges?: Array<{ head?: number }> } | undefined;
        const storedHead = storedSelection?.ranges?.[storedSelection.main ?? storedSelection.mainIndex ?? 0]?.head;
        const cursorOffset = Math.max(0, Math.min(text.length, selection?.head ?? storedHead ?? 0));
        const cursorLine = text.lineAt(cursorOffset);
        return {
          content: text.toString(),
          lineEndings: lineEndingMapToString(lineEndingMap),
          savedContent: document.savedText.toString(),
          savedLineEndings: lineEndingMapToString(document.savedLineEndingMap),
          lineEnding: lineState ? majorityLineEnding(lineState) : document.lineEnding,
          bom: document.bom,
          savedBom: document.savedBom,
          encoding: document.encoding,
          revision: document.revision,
          savedRevision: document.savedRevision,
          sourceVersion: document.sourceVersion,
          estimatedBytes: document.estimatedBytes,
          largeFile: document.largeFile,
          cursor: { line: cursorLine.number, column: cursorOffset - cursorLine.from + 1 },
          selectionJSON: document.state?.selection.toJSON() ?? document.selectionJSON,
          historyJSON,
          lineEndingHistory: history,
        };
      },
      getSelection: () => {
        const state = document.state;
        if (!state) return undefined;
        const selection = state.selection.main;
        return {
          anchor: selection.anchor,
          head: selection.head,
          from: selection.from,
          to: selection.to,
          text: state.sliceDoc(selection.from, selection.to),
        };
      },
      getCursor: () => {
        const state = document.state;
        if (!state) return undefined;
        const offset = state.selection.main.head;
        const line = state.doc.lineAt(offset);
        return { line: line.number, column: offset - line.from + 1, offset };
      },
      applyEdits: (expectedRevision, edits) => {
        const currentView = view;
        if (documents.get(tabId) !== document || tabId !== activeDocumentId || !document.state || !currentView || currentView.state !== document.state) return false;
        const transaction = createPluginEditorEditTransaction(
          document.state,
          expectedRevision,
          document.revision,
          edits,
        );
        if (!transaction) return false;
        currentView.dispatch(transaction);
        return true;
      },
    });

  const registerDocument = (tabId: string) => {
    const document = documents.get(tabId);
    if (document) props.onRegisterDocument(tabId, createDocumentHandle(tabId, document));
  };

  const editorSettingsForState = (settings: EditorSettings): EditorSettings => ({ ...settings });

  const createState = (
    tab: EditorTab,
    normalizedContent: string | Text,
    lineEndingMap: LineEndingMap,
    serialized?: Pick<CachedDocument, "selectionJSON" | "historyJSON"> & { lineEndingHistory?: LineEndingHistory },
    largeFile = tab.largeFile === true,
  ): { state: EditorState; lineEndingField: StateField<LineEndingMapState> } => {
    const lineEnding = createLineEndingMapExtension(lineEndingMap, tab.lineEnding, serialized?.lineEndingHistory);
    const largeFileExtensions = [
      // Large files intentionally skip basicSetup: completion, folding,
      // bracket closing and other convenience services can be expensive for
      // long documents. Keep line numbers plus editing, undo and the shared
      // search API.
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
    ];
    const extensions = [
      ...(largeFile ? largeFileExtensions : [minimalSetup, lineNumbers()]),
      EditorState.allowMultipleSelections.of(true),
      scrollPastEnd(),
      editorContentName(() => `Editing ${props.tab?.name ?? tab.name}`),
      lineEnding.extension,
      themeCompartment.of(props.settings.theme === "dark" ? oneDark : lightEditorTheme),
      fontSizeCompartment.of(editorFontSizeTheme(props.settings.fontSize)),
      wrapCompartment.of(props.settings.wordWrap ? EditorView.lineWrapping : []),
      tabSizeCompartment.of(EditorState.tabSize.of(props.settings.tabSize)),
      indentCompartment.of(indentUnit.of(props.settings.insertSpaces ? " ".repeat(props.settings.tabSize) : "\t")),
      languageCompartment.of([]),
      search(),
      ...(largeFile ? [] : [keymap.of([indentWithTab])]),
      updateListener,
    ];
    let state: EditorState;
    if (serialized?.historyJSON !== undefined || serialized?.selectionJSON !== undefined) {
      try {
        state = EditorState.fromJSON({
          doc: typeof normalizedContent === "string" ? normalizedContent : normalizedContent.toString(),
          selection: serialized.selectionJSON,
          ...(serialized.historyJSON === undefined ? {} : { history: serialized.historyJSON }),
        }, { extensions }, { history: historyField });
      } catch (error) {
        if (serialized?.historyJSON !== undefined) throw error;
        state = EditorState.create({ doc: normalizedContent, extensions });
      }
    } else {
      state = EditorState.create({ doc: normalizedContent, extensions });
    }
    if (serialized?.selectionJSON === undefined) {
      const lineNumber = Math.max(1, Math.min(tab.cursorLine, state.doc.lines));
      const line = state.doc.line(lineNumber);
      const anchor = Math.min(line.to, line.from + Math.max(0, tab.cursorColumn - 1));
      state = state.update({ selection: { anchor } }).state;
    }
    return { state, lineEndingField: lineEnding.field };
  };

  const syncSavedBaseline = (document: CachedDocument, tab: EditorTab) => {
    document.savedRevision = tab.savedRevision;
    document.savedBom = tab.savedBom ?? tab.bom === true;
    const savedVersion = document.savedCandidates.get(tab.savedRevision);
    if (savedVersion) {
      document.savedText = savedVersion.text;
      document.savedLineEndingMap = savedVersion.lineEndingMap;
      document.savedBom = savedVersion.bom;
      for (const revision of document.savedCandidates.keys()) {
        if (revision <= tab.savedRevision) document.savedCandidates.delete(revision);
      }
      return;
    }

    if (tab.savedRevision === document.revision) {
      document.savedText = currentTextOf(document);
      document.savedLineEndingMap = currentLineEndingMapOf(document);
      document.savedBom = document.bom;
      document.savedCandidates.clear();
      return;
    }

    const currentText = currentTextOf(document);
    const currentLineEndingMap = currentLineEndingMapOf(document);
    const savedContent = tab.normalizedSavedRevision === tab.savedRevision
      ? tab.savedContent
      : normalizeDocumentContent(tab.savedContent);
    const savedContentMatches = savedContent === currentText.toString();
    const savedLineEndingText = tab.normalizedSavedRevision === tab.savedRevision && tab.savedLineEndings !== undefined
      ? tab.savedLineEndings
      : savedContentMatches
        ? normalizeLineEndingMapForLineBreakCount(tab.savedLineEndings ?? tab.lineEndings, currentLineEndingMap.length, tab.lineEnding)
        : normalizeLineEndingMap(savedContent, tab.savedLineEndings ?? tab.lineEndings, tab.lineEnding);
    if (savedContentMatches && savedLineEndingText === lineEndingMapToString(currentLineEndingMap)) {
      document.savedText = currentText;
      document.savedLineEndingMap = currentLineEndingMap;
    } else {
      document.savedText = textFromNormalizedString(savedContent);
      document.savedLineEndingMap = lineEndingMapFromString(savedLineEndingText);
    }
  };

  const createDocument = (
    tab: EditorTab,
    content = tab.content,
    serialized?: Pick<CachedDocument, "selectionJSON" | "historyJSON" | "lineEndingHistory">,
    lineEndingsOverride?: string,
  ): CachedDocument => {
    const source = normalizeEditorDocumentSource({
      ...tab,
      content,
      lineEndings: lineEndingsOverride ?? tab.lineEndings,
      normalizedContentVersion: content === tab.content && lineEndingsOverride === undefined
        ? tab.normalizedContentVersion
        : undefined,
    });
    const normalizedContent = source.content;
    const lineEndingText = source.lineEndings;
    const lineEndingMap = lineEndingMapFromString(lineEndingText);
    const savedContent = source.savedContent;
    const savedLineEndingText = source.savedLineEndings;
    const savedLineEndingMap = savedContent === normalizedContent && savedLineEndingText === lineEndingText
      ? lineEndingMap
      : lineEndingMapFromString(savedLineEndingText);
    const estimatedUtf8Bytes = utf8ByteLength(normalizedContent);
    const estimatedBytes = serializedDocumentByteLength(estimatedUtf8Bytes, lineEndingMap.crlf, tab.bom === true);
    const largeFile = largeFileModeForSize(tab.largeFile === true, estimatedBytes);
    const fallbackSelection = content === tab.content && lineEndingsOverride === undefined
      ? currentEditorSelectionFallback(tab.selectionFallback, tab.revision, tab.contentVersion, normalizedContent.length)
      : undefined;
    const stateSerialization = serialized?.selectionJSON === undefined && fallbackSelection
      ? { ...serialized, selectionJSON: fallbackSelection }
      : serialized;
    const created = createState(tab, normalizedContent, lineEndingMap, stateSerialization, largeFile);
    const state = created.state;
    const savedText = savedContent === normalizedContent ? state.doc : textFromNormalizedString(savedContent);
    const currentMapState = lineEndingMapOf(state, created.lineEndingField);
    return {
      state,
      text: state.doc,
      lineEndingField: created.lineEndingField,
      lineEndingMap,
      lineEnding: majorityLineEnding(currentMapState),
      savedLineEndingMap,
      bom: tab.bom === true,
      savedBom: tab.savedBom ?? tab.bom === true,
      encoding: tab.encoding,
      selectionJSON: state.selection.toJSON(),
      historyJSON: undefined,
      path: tab.path,
      sourceVersion: tab.contentVersion,
      revision: tab.revision,
      savedRevision: tab.savedRevision,
      savedText,
      savedCandidates: new Map(),
      lineEndingHistory: currentMapState.history,
      estimatedUtf8Bytes,
      lastEstimatedUtf8Bytes: estimatedUtf8Bytes,
      estimatedBytes,
      largeFile,
      settings: editorSettingsForState(props.settings),
      lastUsed: ++usageClock,
      historyBytesEstimate: serialized?.historyJSON === undefined ? 0 : serializedBytes(serialized.historyJSON),
      selectionBytesEstimate: serializedBytes(state.selection.toJSON()),
    };
  };

  const createDocumentFromSeed = (tab: EditorTab, seed: EditorDocumentSeed): CachedDocument => {
    const lineEndingMap = lineEndingMapFromString(seed.lineEndings);
    const savedLineEndingMap = seed.savedContent === seed.content && seed.savedLineEndings === seed.lineEndings
      ? lineEndingMap
      : lineEndingMapFromString(seed.savedLineEndings);
    const largeFile = largeFileModeForSize(tab.largeFile === true, seed.estimatedBytes);
    const created = createState(tab, seed.content, lineEndingMap, seed, largeFile);
    const state = created.state;
    const savedText = seed.savedContent === seed.content ? state.doc : textFromNormalizedString(seed.savedContent);
    const mapState = lineEndingMapOf(state, created.lineEndingField);
    const estimatedUtf8Bytes = Math.max(0, seed.estimatedBytes - lineEndingMap.crlf - (seed.bom ? 3 : 0));
    return {
      state,
      text: state.doc,
      lineEndingField: created.lineEndingField,
      lineEndingMap,
      lineEnding: majorityLineEnding(mapState),
      savedLineEndingMap,
      bom: seed.bom,
      savedBom: seed.savedBom,
      encoding: seed.encoding,
      selectionJSON: state.selection.toJSON(),
      historyJSON: undefined,
      path: tab.path,
      sourceVersion: seed.sourceVersion,
      revision: seed.revision,
      savedRevision: seed.savedRevision,
      savedText,
      savedCandidates: new Map(),
      lineEndingHistory: mapState.history,
      estimatedUtf8Bytes,
      lastEstimatedUtf8Bytes: estimatedUtf8Bytes,
      estimatedBytes: seed.estimatedBytes,
      largeFile,
      settings: editorSettingsForState(props.settings),
      lastUsed: ++usageClock,
      historyBytesEstimate: serializedBytes(seed.historyJSON),
      selectionBytesEstimate: serializedBytes(state.selection.toJSON()),
    };
  };

  const loadLanguage = async (path: string, tabId: string, currentView: EditorView) => {
    const requestRevision = ++languageRevision;
    const metadata = fileLanguageForPath(path);
    if (!shouldLoadEditorLanguage(metadata, documents.get(tabId)?.largeFile === true)) {
      currentView.dispatch({ effects: languageCompartment.reconfigure([]) });
      return;
    }
    try {
      const support = await loadEditorLanguageSupport(metadata);
      if (view !== currentView || activeDocumentId !== tabId || languageRevision !== requestRevision || documents.get(tabId)?.path !== path) return;
      currentView.dispatch({ effects: languageCompartment.reconfigure(support) });
    } catch {
      // A missing optional language package should not stop plain text editing.
    }
  };

  const replaceDocumentContent = (document: CachedDocument, tab: EditorTab) => {
    const currentState = document.state;
    const source = normalizeEditorDocumentSource(tab);
    const content = source.content;
    const lineEndingMap = lineEndingMapFromString(source.lineEndings);
    const estimatedUtf8Bytes = utf8ByteLength(content);
    const estimatedBytes = serializedDocumentByteLength(estimatedUtf8Bytes, lineEndingMap.crlf, tab.bom === true);
    const largeFile = largeFileModeForSize(tab.largeFile === true, estimatedBytes);
    const created = createState(tab, content, lineEndingMap, currentState ? { selectionJSON: currentState.selection.toJSON() } : undefined, largeFile);
    const nextState = created.state;
    syncing = true;
    document.state = nextState;
    syncing = false;
    document.lineEndingField = created.lineEndingField;
    document.text = nextState.doc;
    document.lineEndingMap = lineEndingMap;
    document.lineEnding = majorityLineEnding(lineEndingMapOf(nextState, created.lineEndingField));
    document.bom = tab.bom === true;
    document.encoding = tab.encoding;
    document.selectionJSON = nextState.selection.toJSON();
    document.selectionBytesEstimate = serializedBytes(document.selectionJSON);
    document.historyJSON = undefined;
    document.lineEndingHistory = lineEndingMapOf(nextState, created.lineEndingField).history;
    document.historyBytesEstimate = 0;
    document.estimatedUtf8Bytes = estimatedUtf8Bytes;
    document.lastEstimatedUtf8Bytes = estimatedUtf8Bytes;
    document.estimatedBytes = estimatedBytes;
    document.path = tab.path;
    document.sourceVersion = tab.contentVersion;
    document.revision = tab.revision;
    syncSavedBaseline(document, tab);
    document.largeFile = largeFile;
    document.savedCandidates.clear();
    document.settings = editorSettingsForState(props.settings);
  };

  const applySettings = (document: CachedDocument, settings: EditorSettings) => {
    const changed = changedEditorSettings(document.settings, settings);
    const effects = [];
    if (changed.includes("theme")) effects.push(themeCompartment.reconfigure(settings.theme === "dark" ? oneDark : lightEditorTheme));
    if (changed.includes("fontSize")) effects.push(fontSizeCompartment.reconfigure(editorFontSizeTheme(settings.fontSize)));
    if (changed.includes("wordWrap")) effects.push(wrapCompartment.reconfigure(settings.wordWrap ? EditorView.lineWrapping : []));
    if (changed.includes("tabSize")) effects.push(tabSizeCompartment.reconfigure(EditorState.tabSize.of(settings.tabSize)));
    if (changed.includes("insertSpaces") || changed.includes("tabSize")) effects.push(indentCompartment.reconfigure(indentUnit.of(settings.insertSpaces ? " ".repeat(settings.tabSize) : "\t")));

    if (effects.length && document.state) {
      const shouldDispatch = Boolean(activeDocumentId) && view?.state === document.state;
      if (shouldDispatch && view) {
        view.dispatch({ effects });
      } else {
        document.state = document.state.update({ effects }).state;
        document.text = document.state.doc;
        document.selectionJSON = document.state.selection.toJSON();
      }
    }
    document.settings = editorSettingsForState(settings);
  };

  const activateDocument = (tab: EditorTab) => {
    if (!view) return;
    const previous = documents.get(activeDocumentId);
    if (previous && activeDocumentId !== tab.id) {
      previous.state = view.state;
      previous.text = view.state.doc;
      previous.selectionJSON = view.state.selection.toJSON();
      touchDocument(previous);
    }

    let document = documents.get(tab.id);
    if (document && document.largeFile !== (tab.largeFile === true)) {
      // Crossing the large-file threshold changes the extension set. Rebuild
      // the state while carrying over text, cursor, and serialized history.
      const text = currentTextOf(document);
      const mapState = document.state && document.lineEndingField ? lineEndingMapOf(document.state, document.lineEndingField) : undefined;
      const snapshot = {
        text,
        selectionJSON: document.state?.selection.toJSON() ?? document.selectionJSON,
        historyJSON: document.state ? serializeEditorHistory(document.state) : document.historyJSON,
        lineEndingHistory: mapState?.history ?? document.lineEndingHistory,
      };
      if (snapshot.historyJSON === undefined) {
        // A state without a serializable history must stay attached so an
        // undo stack is never discarded during a setup change.
        return;
      }
      const created = createState(tab, snapshot.text.toString(), document.lineEndingMap, snapshot, tab.largeFile === true);
      document.state = created.state;
      document.text = created.state.doc;
      document.lineEndingField = created.lineEndingField;
      document.lineEndingHistory = lineEndingMapOf(created.state, created.lineEndingField).history;
      document.historyJSON = undefined;
      document.largeFile = tab.largeFile === true;
    }
    if (!document) document = props.getCachedDocument(tab.id)
      ? createDocumentFromSeed(tab, props.getCachedDocument(tab.id)!)
      : createDocument(tab);
    if (!document.state) {
      if (document.sourceVersion === tab.contentVersion) {
        const created = createState(tab, document.text.toString(), document.lineEndingMap, {
          selectionJSON: document.selectionJSON,
          historyJSON: document.historyJSON,
          lineEndingHistory: document.lineEndingHistory,
        }, document.largeFile);
        document.state = created.state;
        document.lineEndingField = created.lineEndingField;
        document.lineEndingHistory = lineEndingMapOf(created.state, created.lineEndingField).history;
      } else {
        const hasLocalEdits = !document.text.eq(document.savedText);
        if (hasLocalEdits && tab.dirty) {
          // The detached document may still contain the only copy of a dirty
          // buffer while App has advanced the disk snapshot in the meantime.
          // Rehydrate that text and history before updating its source marker.
          const created = createState(tab, document.text.toString(), document.lineEndingMap, {
            selectionJSON: document.selectionJSON,
            historyJSON: document.historyJSON,
            lineEndingHistory: document.lineEndingHistory,
          }, document.largeFile);
          document.state = created.state;
          document.lineEndingField = created.lineEndingField;
          document.lineEndingHistory = lineEndingMapOf(created.state, created.lineEndingField).history;
          document.sourceVersion = tab.contentVersion;
          document.revision = Math.max(document.revision, tab.revision);
          syncSavedBaseline(document, tab);
        } else {
          document = createDocument(tab);
        }
      }
      const hydratedState = document.state;
      if (!hydratedState) return;
      document.text = hydratedState.doc;
      document.historyJSON = undefined;
      document.lineEndingHistory = document.lineEndingField ? lineEndingMapOf(hydratedState, document.lineEndingField).history : document.lineEndingHistory;
    }
    if (document.sourceVersion !== tab.contentVersion) {
      const hasLocalEdits = !document.text.eq(document.savedText);
      if (hasLocalEdits && tab.dirty) {
        // Keep a dirty renderer buffer if an unrelated tab snapshot is stale.
        // An explicit reload clears tab.dirty and is allowed to replace it.
        document.sourceVersion = tab.contentVersion;
        document.revision = Math.max(document.revision, tab.revision);
        syncSavedBaseline(document, tab);
      } else {
        replaceDocumentContent(document, tab);
      }
    }
    if (document.savedRevision !== tab.savedRevision) {
      syncSavedBaseline(document, tab);
    }
    if (document.path !== tab.path) document.path = tab.path;
    documents.set(tab.id, document);
    applySettings(document, props.settings);
    touchDocument(document);
    registerDocument(tab.id);
    const activeState = document.state;
    if (!activeState) return;
    if (activeDocumentId === tab.id && view.state === activeState) return;
    view.setState(activeState);
    activeDocumentId = tab.id;
    view.dispatch({ effects: languageCompartment.reconfigure([]) });
    void loadLanguage(tab.path, tab.id, view);
    pruneEditorStates();
    if (!firstEditableDocumentMarked) {
      firstEditableDocumentMarked = true;
      markStartupEvent("first-tab-editable");
    }
  };

  onMount(() => {
    host.addEventListener("wheel", handleWheel, { passive: false });
    view = new EditorView({
      state: EditorState.create({ doc: "", extensions: [updateListener] }),
      parent: host,
    });
    if (!firstEditorViewMarked) {
      firstEditorViewMarked = true;
      markStartupEvent("first-editor-view");
    }
    const tab = props.tab;
    if (tab) activateDocument(tab);
    updateContentAccessibleName(tab?.name);
  });

  createEffect(() => {
    const name = props.tab?.name;
    updateContentAccessibleName(name);
  });

  createEffect(() => {
    const openIds = new Set(props.openTabIds);
    for (const id of documents.keys()) {
      if (openIds.has(id)) continue;
      const document = documents.get(id);
      documents.delete(id);
      props.onUnregisterDocument(id, document ? createDocumentHandle(id, document) : undefined);
    }
  });

  createEffect(() => {
    const tab = props.tab;
    if (!view || !tab) return;
    const document = documents.get(tab.id);
    if (!document) {
      activateDocument(tab);
      return;
    }
    if (activeDocumentId !== tab.id) {
      activateDocument(tab);
      return;
    }
    if (document.largeFile !== (tab.largeFile === true)) {
      activateDocument(tab);
      return;
    }
    if (document.sourceVersion !== tab.contentVersion) {
      const hasLocalEdits = !document.text.eq(document.savedText);
      if (hasLocalEdits && tab.dirty) {
        document.sourceVersion = tab.contentVersion;
        document.revision = Math.max(document.revision, tab.revision);
        syncSavedBaseline(document, tab);
        return;
      }
      replaceDocumentContent(document, tab);
      const replacementState = document.state;
      if (!replacementState) return;
      view.setState(replacementState);
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      void loadLanguage(tab.path, tab.id, view);
      return;
    }
    if (document.savedRevision !== tab.savedRevision) {
      syncSavedBaseline(document, tab);
    }
    if (document.path !== tab.path) {
      document.path = tab.path;
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      void loadLanguage(tab.path, tab.id, view);
    }
  });

  createEffect(() => {
    if (!view) return;
    const currentSettings = props.settings;
    const activeTabId = props.tab?.id;
    void activeTabId;
    const document = props.tab ? documents.get(props.tab.id) : undefined;
    if (document) applySettings(document, currentSettings);
  });

  createEffect(() => {
    const activeTabId = props.tab?.id;
    void activeTabId;
    const searchQuery = props.searchQuery;
    const searchReplace = props.searchReplace;
    const searchCaseSensitive = props.searchCaseSensitive;
    const searchRegexp = props.searchRegexp;
    const searchWholeWord = props.searchWholeWord;
    const searchAction = props.searchAction;
    const searchActionId = props.searchActionId;
    const searchActionTargetTabId = props.searchActionTargetTabId;
    searchActionGate.releaseClosedTabs(props.openTabIds);
    if (!view) return;
    const currentView = view;
    const revision = ++searchRevision;
    queueMicrotask(() => {
      if (revision !== searchRevision || view !== currentView) return;
      const query = new SearchQuery({
        search: searchQuery,
        replace: searchReplace,
        caseSensitive: searchCaseSensitive,
        regexp: searchRegexp,
        wholeWord: searchWholeWord,
      });
      currentView.dispatch({ effects: setSearchQuery.of(query) });
      if (!searchAction || searchActionId === 0 || !searchActionTargetTabId) return;
      if (!props.openTabIds.includes(searchActionTargetTabId)) {
        if (searchActionGate.consume(searchActionTargetTabId, searchActionId)) {
          searchActionGate.releaseClosedTabs(props.openTabIds);
          props.onSearchActionConsumed(searchActionTargetTabId, searchActionId);
        }
        return;
      }
      if (activeTabId !== searchActionTargetTabId || activeDocumentId !== searchActionTargetTabId) return;
      if (!searchActionGate.consume(searchActionTargetTabId, searchActionId)) return;
      if (!searchQuery) {
        props.onSearchActionConsumed(searchActionTargetTabId, searchActionId);
        return;
      }
      if (searchAction === "find") findNext(currentView);
      if (searchAction === "replace") replaceNext(currentView);
      if (searchAction === "replaceAll") replaceAll(currentView);
      props.onSearchActionConsumed(searchActionTargetTabId, searchActionId);
    });
  });

  let lastNavigationRequest: GoToLineRequest | undefined;
  createEffect(() => {
    const request = props.goToLine;
    const tabId = props.tab?.id;
    if (!view || !request || request === lastNavigationRequest || request.tabId && request.tabId !== tabId) return;
    if (activeDocumentId !== tabId) return;
    lastNavigationRequest = request;
    const lineNumber = Math.max(1, Math.min(request.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    let anchor = line.from;
    let head = line.from;
    if (request.query) {
      const cursor = new SearchQuery({ search: request.query, caseSensitive: request.caseSensitive, literal: true }).getCursor(view.state.doc, line.from, line.to).next();
      if (!cursor.done) { anchor = cursor.value.from; head = cursor.value.to; }
    }
    view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center", x: "center" }) });
    view.focus();
  });

  onCleanup(() => {
    host.removeEventListener("wheel", handleWheel);
    searchRevision += 1;
    languageRevision += 1;
    if (activeDocumentId) {
      const activeDocument = documents.get(activeDocumentId);
      if (activeDocument && view) {
        activeDocument.state = view.state;
        activeDocument.text = view.state.doc;
        activeDocument.selectionJSON = view.state.selection.toJSON();
      }
    }
    for (const [id, document] of documents) {
      if (document.state) captureDocumentState(document);
      props.onUnregisterDocument(id, createDocumentHandle(id, document));
    }
    view?.destroy();
    view = undefined;
    documents.clear();
  });

  return <div class="editor-host" ref={host} style={{ "--editor-font-size": `${props.settings.fontSize}px` }} aria-label={props.tab ? `Editing ${props.tab.name}` : "Editor"} />;
}
