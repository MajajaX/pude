import { For, createSignal } from "solid-js";
import { tabNavigationAction, tabRovingIndex } from "../lib/tab-navigation";

export type SidebarView = "explorer" | "git" | "search";

export const SIDEBAR_EXPLORER_TAB_ID = "sidebar-explorer-tab";
export const SIDEBAR_GIT_TAB_ID = "sidebar-git-tab";
export const SIDEBAR_SEARCH_TAB_ID = "sidebar-search-tab";
export const SIDEBAR_EXPLORER_PANEL_ID = "sidebar-explorer-panel";
export const SIDEBAR_GIT_PANEL_ID = "sidebar-git-panel";
export const SIDEBAR_SEARCH_PANEL_ID = "sidebar-search-panel";

export type SidebarTabsProps = {
  selected: SidebarView;
  onSelect: (view: SidebarView) => void;
};

const views: readonly { id: SidebarView; label: string; tabId: string; panelId: string }[] = [
  { id: "explorer", label: "EXPLORER", tabId: SIDEBAR_EXPLORER_TAB_ID, panelId: SIDEBAR_EXPLORER_PANEL_ID },
  { id: "git", label: "GIT", tabId: SIDEBAR_GIT_TAB_ID, panelId: SIDEBAR_GIT_PANEL_ID },
  { id: "search", label: "SEARCH", tabId: SIDEBAR_SEARCH_TAB_ID, panelId: SIDEBAR_SEARCH_PANEL_ID },
];

export function SidebarTabs(props: SidebarTabsProps) {
  let tablistElement: HTMLDivElement | undefined;
  const [focusedView, setFocusedView] = createSignal<SidebarView>();

  const focusedIndex = () => {
    const focused = focusedView();
    if (focused) {
      const index = views.findIndex((view) => view.id === focused);
      if (index >= 0) return index;
    }
    const selectedIndex = views.findIndex((view) => view.id === props.selected);
    return selectedIndex >= 0 ? selectedIndex : 0;
  };

  const rememberFocusedView = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const view = target.dataset.sidebarView;
    if (view === "explorer" || view === "git" || view === "search") setFocusedView(view);
  };

  const moveFocus = (index: number) => {
    const button = tablistElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[index];
    if (!button) return;
    const view = button.dataset.sidebarView;
    if (view !== "explorer" && view !== "git" && view !== "search") return;
    setFocusedView(view);
    button.focus({ preventScroll: true });
    props.onSelect(view);
  };

  const handleTabKeyDown = (event: KeyboardEvent) => {
    const buttons = tablistElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    if (!buttons?.length) return;
    const currentIndex = Array.from(buttons).indexOf(event.currentTarget as HTMLButtonElement);
    if (currentIndex < 0) return;
    const action = tabNavigationAction({
      key: event.key,
      count: buttons.length,
      focusedIndex: currentIndex,
      orientation: "horizontal",
      direction: getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl" ? "rtl" : "ltr",
      activation: "automatic",
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
    });
    if (!action.handled) return;
    if (action.preventDefault) event.preventDefault();
    if (action.focusIndex !== undefined) moveFocus(action.focusIndex);
  };

  return (
    <div
      ref={(element) => { tablistElement = element; }}
      class="sidebar-tabs"
      role="tablist"
      aria-label="Sidebar views"
      aria-orientation="horizontal"
      onFocusIn={rememberFocusedView}
    >
      <For each={views}>{(view, index) => (
        <button
          classList={{ "sidebar-tab": true, "sidebar-tab-active": props.selected === view.id }}
          type="button"
          role="tab"
          id={view.tabId}
          data-sidebar-view={view.id}
          aria-selected={props.selected === view.id}
          aria-controls={view.panelId}
          tabIndex={tabRovingIndex(index(), focusedIndex())}
          onKeyDown={handleTabKeyDown}
          onClick={() => props.onSelect(view.id)}
        >
          {view.label}
        </button>
      )}</For>
    </div>
  );
}
