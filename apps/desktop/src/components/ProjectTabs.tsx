import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "./Icons";
import type { ProjectTab } from "../lib/project-tabs";
import { tabNavigationAction } from "../lib/tab-navigation";
import { t } from "../lib/i18n";

export function ProjectTabs(props: {
  projects: readonly ProjectTab[];
  activeId?: string;
  busy: boolean;
  onSelect: (id: string) => void | Promise<void>;
  onClose: (id: string) => void | Promise<void>;
  onAdd: () => void;
  onReorder: (sourceId: string, targetId: string) => void;
}) {
  let list!: HTMLDivElement;
  const [draggedId, setDraggedId] = createSignal<string>();
  const projectIds = createMemo(() => props.projects.map((project) => project.id), undefined,
    { equals: (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index]) });
  const projectById = createMemo(() => new Map(props.projects.map((project) => [project.id, project])));
  createEffect(() => {
    const id = props.activeId;
    projectIds();
    if (!id) return;
    requestAnimationFrame(() => {
      const selected = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.dataset.projectId === id);
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
  const keyDown = (event: KeyboardEvent, id: string) => {
    const index = props.projects.findIndex((project) => project.id === id);
    const action = tabNavigationAction({ key: event.key, isComposing: event.isComposing, keyCode: event.keyCode,
      ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey,
      count: props.projects.length, focusedIndex: index, orientation: "horizontal" });
    if (!action.handled) return;
    event.preventDefault();
    if (props.busy || action.selectedIndex === undefined) return;
    const project = props.projects[action.selectedIndex];
    list.querySelectorAll<HTMLButtonElement>('[role="tab"]')[action.selectedIndex]?.focus({ preventScroll: true });
    void Promise.resolve(props.onSelect(project.id)).then(() => {
      if (props.activeId === project.id) list.querySelectorAll<HTMLButtonElement>('[role="tab"]')[props.projects.findIndex((item) => item.id === project.id)]?.focus({ preventScroll: true });
    });
  };
  return (
    <div class="project-tabs-container">
      <div class="project-tabs" ref={list} role="tablist" aria-label={t("Projects")}>
        <For each={projectIds()}>{(id) => {
          const project = () => projectById().get(id) ?? { id, workspace: "", label: "Files", title: "Files", dirty: false };
          return (
          <div class="project-tab" classList={{ "project-tab-active": props.activeId === project().id }} draggable={!props.busy}
            onDragStart={(event) => { setDraggedId(project().id); event.dataTransfer?.setData("application/x-pude-project", project().id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => setDraggedId(undefined)}
            onDragOver={(event) => { if (draggedId() && !props.busy) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); const source = draggedId(); if (source && !props.busy) props.onReorder(source, project().id); setDraggedId(undefined); }}>
            <button type="button" role="tab" id={`project-tab-${project().id}`} data-project-id={project().id}
              aria-selected={props.activeId === project().id} aria-controls="project-workspace-panel"
              tabIndex={props.activeId === project().id ? 0 : -1} aria-disabled={props.busy}
              title={project().title} onClick={() => { if (!props.busy) void props.onSelect(project().id); }} onKeyDown={(event) => keyDown(event, project().id)}>
              <Icon name="folder" size={13} /><span class="project-tab-label">{project().label}</span>
              <Show when={project().dirty}><span class="project-tab-dirty" aria-label={t("Unsaved changes")}>●</span></Show>
            </button>
            <button type="button" class="project-tab-close" aria-disabled={props.busy} title={t("Close project")} aria-label={t("Close {label}", { label: project().label })} onClick={() => { if (!props.busy) void props.onClose(project().id); }}><Icon name="close" size={12} /></button>
          </div>
          );
        }}</For>
      </div>
      <button type="button" class="icon-button project-add" aria-disabled={props.busy} title={t("New tab")} aria-label={t("New tab")} onClick={() => { if (!props.busy) props.onAdd(); }}><Icon name="plus" size={15} /></button>
    </div>
  );
}
