import { For, createSignal } from "solid-js";
import { Icon } from "./Icons";
import type { DirectoryEntry } from "../types";
import { isImeComposing } from "../lib/keyboard-input";

type RecentProjectsListProps = {
  entries: DirectoryEntry[];
  onOpen: (entry: DirectoryEntry) => void;
};

export function RecentProjectsList(props: RecentProjectsListProps) {
  const [focusedPath, setFocusedPath] = createSignal<string>();
  const rows = new Map<string, HTMLDivElement>();
  const activePath = () => props.entries.some((entry) => entry.path === focusedPath())
    ? focusedPath()
    : props.entries[0]?.path;

  const focusEntry = (path: string) => {
    setFocusedPath(path);
    queueMicrotask(() => rows.get(path)?.focus({ preventScroll: true }));
  };

  const handleKeyDown = (entry: DirectoryEntry, event: KeyboardEvent) => {
    if (isImeComposing(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      props.onOpen(entry);
      return;
    }
    const index = props.entries.findIndex((candidate) => candidate.path === entry.path);
    if (index < 0) return;
    const nextIndex = event.key === "ArrowDown" ? Math.min(props.entries.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? props.entries.length - 1
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = props.entries[nextIndex];
    if (next) focusEntry(next.path);
  };

  return <For each={props.entries}>{(entry, index) => (
    <div
      ref={(element) => rows.set(entry.path, element)}
      class="tree-row tree-row-directory"
      role="treeitem"
      aria-level={1}
      aria-posinset={index() + 1}
      aria-setsize={props.entries.length}
      aria-label={`Open recent project ${entry.name}`}
      tabIndex={activePath() === entry.path ? 0 : -1}
      onFocus={() => setFocusedPath(entry.path)}
      onKeyDown={(event) => handleKeyDown(entry, event)}
      onDblClick={() => props.onOpen(entry)}
    >
      <button class="tree-chevron" tabIndex={-1} aria-label="Open recent project" onClick={() => props.onOpen(entry)}><Icon name="chevron-right" size={13} /></button>
      <span class="tree-kind"><Icon name="folder" size={15} /></span>
      <button class="tree-label" tabIndex={-1} onClick={() => props.onOpen(entry)}>{entry.name}</button>
    </div>
  )}</For>;
}
