import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { parseDiff, toStackedDiffLines } from "../lib/diff";
import type { DiffParseResult, StackedDiffLine } from "../lib/diff";
import { virtualTreeWindow } from "../lib/tree-virtualization";
import { Icon } from "./Icons";

// Both diff layouts use `white-space: pre` with clipped overflow, so rows
// never wrap and a fixed row height is exact — no estimated heights that
// could make scroll positions jump.
const DIFF_ROW_HEIGHT = 22;
const DIFF_OVERSCAN = 8;

export function DiffPane(props: {
  path: string;
  diff: string;
  staged: boolean;
  label?: string;
  backLabel?: string;
  contextLines?: number;
  nextContextLines?: number;
  loading?: boolean;
  onExpandContext?: () => void;
  onBack: () => void;
}) {
  const parsed = createMemo(() => parseDiff(props.diff));
  const [layout, setLayout] = createSignal<"side-by-side" | "stacked">("side-by-side");
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  let scrollHost!: HTMLDivElement;
  let stackedSource: DiffParseResult | undefined;
  let stackedCache: StackedDiffLine[] | undefined;

  const getStackedRows = (): StackedDiffLine[] => {
    const current = parsed();
    if (current !== stackedSource) {
      stackedSource = current;
      stackedCache = undefined;
    }
    stackedCache ??= toStackedDiffLines(current.rows);
    return stackedCache;
  };

  createEffect(() => {
    const current = parsed();
    if (current !== stackedSource) {
      stackedSource = current;
      stackedCache = undefined;
    }
  });

  const sideWindow = createMemo(() => virtualTreeWindow(parsed().rows.length, scrollTop(), viewportHeight(), DIFF_ROW_HEIGHT, DIFF_OVERSCAN));
  const stackedWindow = createMemo(() => {
    if (layout() !== "stacked") return virtualTreeWindow(0, scrollTop(), viewportHeight(), DIFF_ROW_HEIGHT, DIFF_OVERSCAN);
    return virtualTreeWindow(getStackedRows().length, scrollTop(), viewportHeight(), DIFF_ROW_HEIGHT, DIFF_OVERSCAN);
  });
  const renderedRows = createMemo(() => {
    const currentWindow = sideWindow();
    return parsed().rows.slice(currentWindow.start, currentWindow.end);
  });
  const renderedStackedRows = createMemo(() => {
    if (layout() !== "stacked") return [];
    const rows = getStackedRows();
    const currentWindow = stackedWindow();
    return rows.slice(currentWindow.start, currentWindow.end);
  });

  const updateViewport = () => {
    if (!scrollHost) return;
    setViewportHeight(scrollHost.clientHeight);
    setScrollTop(scrollHost.scrollTop);
  };

  onMount(() => {
    const handleScroll = () => setScrollTop(scrollHost.scrollTop);
    scrollHost.addEventListener("scroll", handleScroll, { passive: true });
    updateViewport();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateViewport);
    resizeObserver?.observe(scrollHost);
    onCleanup(() => {
      scrollHost.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
    });
  });

  // A new file or revision starts the preview from the top.
  createEffect(() => {
    props.path;
    props.diff;
    if (!scrollHost) return;
    if (scrollHost.scrollTop === 0) return;
    scrollHost.scrollTop = 0;
    setScrollTop(0);
  });

  return (
    <div class="diff-view">
      <div class="diff-toolbar">
        <div class="diff-toolbar-file"><button class="toolbar-link" onClick={props.onBack}><Icon name="chevron-right" size={13} class="rotate-180" /> {props.backLabel ?? "Back to editor"}</button><span class="diff-file-name">{props.path}</span></div>
        <div class="diff-toolbar-actions">
          <div class="diff-layout-toggle" role="group" aria-label="Diff layout">
            <button class="diff-layout-button" classList={{ "diff-layout-button-active": layout() === "side-by-side" }} aria-pressed={layout() === "side-by-side"} onClick={() => setLayout("side-by-side")}>Side by side</button>
            <button class="diff-layout-button" classList={{ "diff-layout-button-active": layout() === "stacked" }} aria-pressed={layout() === "stacked"} onClick={() => setLayout("stacked")}>Stacked</button>
          </div>
          <Show when={props.onExpandContext && props.nextContextLines !== undefined && (props.contextLines === undefined || props.nextContextLines > props.contextLines)}>
            <button
              class="diff-layout-button"
              disabled={props.loading === true}
              aria-busy={props.loading === true}
              aria-label={props.loading ? "Loading additional diff context" : `Load diff with ${props.nextContextLines} lines of context`}
              title={props.contextLines === undefined ? undefined : `Current context: ${props.contextLines} lines`}
              onClick={() => props.onExpandContext?.()}
            >
              {props.loading
                ? "Loading context…"
                : props.contextLines === undefined
                  ? `More context (${props.nextContextLines} lines)`
                  : `More context (${props.contextLines} → ${props.nextContextLines} lines)`}
            </button>
          </Show>
          <span class="diff-state">{props.label ?? (props.staged ? "STAGED CHANGES" : "WORKING TREE")}</span>
        </div>
      </div>
      <div class="diff-content" ref={scrollHost} role="document" aria-label={`Diff for ${props.path}`}>
        <Show when={parsed().rows.length} fallback={<div class="empty-diff">No textual changes to display.</div>}>
          <Show when={layout() === "side-by-side"} fallback={
            <div class="diff-rows-virtual" style={{ position: "relative", height: `${stackedWindow().totalHeight}px` }}>
              <For each={renderedStackedRows()}>{(row, index) => (
                <div class={`diff-stacked-row diff-stacked-row-${row.kind}`} style={{ position: "absolute", top: `${(stackedWindow().start + index()) * DIFF_ROW_HEIGHT}px`, left: "0", right: "0" }}>
                  <span class="diff-stacked-label">{row.kind === "context" ? "" : row.label}</span>
                  <div class={`diff-stacked-side diff-side-${row.kind}`}>
                    <span class="diff-number">{row.oldNumber ?? ""}</span>
                    <span class="diff-number">{row.newNumber ?? ""}</span>
                    <code>{row.text}</code>
                  </div>
                </div>
              )}</For>
            </div>
          }>
            <div class="diff-column-head"><span>BEFORE</span><span>AFTER</span></div>
            <div class="diff-rows-virtual" style={{ position: "relative", height: `${sideWindow().totalHeight}px` }}>
              <For each={renderedRows()}>{(row, index) => (
                <div class={`diff-row diff-row-${row.state}`} style={{ position: "absolute", top: `${(sideWindow().start + index()) * DIFF_ROW_HEIGHT}px`, left: "0", right: "0" }}>
                  <DiffSide text={row.left} number={row.leftNumber} state={row.state === "added" ? "empty" : row.state === "changed" ? "removed" : row.state} />
                  <DiffSide text={row.right} number={row.rightNumber} state={row.state === "removed" ? "empty" : row.state === "changed" ? "added" : row.state} />
                </div>
              )}</For>
            </div>
          </Show>
        </Show>
        <Show when={parsed().truncated}>
          <div class="diff-full-row diff-meta" role="status">Diff preview shortened for performance. Open the file or use Git to inspect the complete change.</div>
        </Show>
      </div>
    </div>
  );
}

function DiffSide(props: { text?: string; number?: number; state: "context" | "changed" | "added" | "removed" | "empty" }) {
  return <div class={`diff-side diff-side-${props.state}`}><span class="diff-number">{props.number ?? ""}</span><code>{props.text ?? " "}</code></div>;
}
