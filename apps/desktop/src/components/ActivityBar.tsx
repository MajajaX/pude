import { For, createSignal } from "solid-js";
import { Icon } from "./Icons";
import { tabNavigationAction, tabRovingIndex } from "../lib/tab-navigation";
import { t, translatable } from "../lib/i18n";

export type SidebarView = "explorer" | "search" | "git";

export const SIDEBAR_EXPLORER_TAB_ID = "sidebar-explorer-tab";
export const SIDEBAR_GIT_TAB_ID = "sidebar-git-tab";
export const SIDEBAR_SEARCH_TAB_ID = "sidebar-search-tab";
export const SIDEBAR_EXPLORER_PANEL_ID = "sidebar-explorer-panel";
export const SIDEBAR_GIT_PANEL_ID = "sidebar-git-panel";
export const SIDEBAR_SEARCH_PANEL_ID = "sidebar-search-panel";

export type ActivityBarProps = {
  selected: SidebarView;
  sidebarHidden: boolean;
  /** Shows a view, for keyboard movement between views. */
  onSelect: (view: SidebarView) => void;
  /** Shows a view, or hides the sidebar when that view is already showing. */
  onToggle: (view: SidebarView) => void;
};

const views: readonly { id: SidebarView; label: string; icon: "folder" | "search" | "git"; tabId: string; panelId: string }[] = [
  { id: "explorer", label: translatable("Explorer"), icon: "folder", tabId: SIDEBAR_EXPLORER_TAB_ID, panelId: SIDEBAR_EXPLORER_PANEL_ID },
  { id: "search", label: translatable("Search"), icon: "search", tabId: SIDEBAR_SEARCH_TAB_ID, panelId: SIDEBAR_SEARCH_PANEL_ID },
  { id: "git", label: translatable("Git"), icon: "git", tabId: SIDEBAR_GIT_TAB_ID, panelId: SIDEBAR_GIT_PANEL_ID },
];

export function ActivityBar(props: ActivityBarProps) {
  let tablistElement: HTMLDivElement | undefined;
  const [focusedView, setFocusedView] = createSignal<SidebarView>();
  const isShowing = (view: SidebarView) => props.selected === view && !props.sidebarHidden;

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
    const view = views.find((candidate) => candidate.id === target.dataset.sidebarView);
    if (view) setFocusedView(view.id);
  };

  const moveFocus = (index: number) => {
    const view = views[index];
    const button = tablistElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[index];
    if (!view || !button) return;
    setFocusedView(view.id);
    button.focus({ preventScroll: true });
    props.onSelect(view.id);
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
      orientation: "vertical",
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
      class="activity-bar"
      role="tablist"
      aria-label={t("Sidebar views")}
      aria-orientation="vertical"
      onFocusIn={rememberFocusedView}
    >
      <For each={views}>{(view, index) => (
        <button
          classList={{ "activity-bar-item": true, "activity-bar-item-active": isShowing(view.id) }}
          type="button"
          role="tab"
          id={view.tabId}
          data-sidebar-view={view.id}
          title={t(view.label)}
          aria-label={t(view.label)}
          aria-selected={isShowing(view.id)}
          aria-controls={view.panelId}
          tabIndex={tabRovingIndex(index(), focusedIndex())}
          onKeyDown={handleTabKeyDown}
          onClick={() => props.onToggle(view.id)}
        >
          <Icon name={view.icon} size={22} />
        </button>
      )}</For>
    </div>
  );
}
