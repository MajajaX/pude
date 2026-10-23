import { For, Show, createSignal } from "solid-js";
import type { EditorTab } from "../types";
import { Icon, LanguageIcon, languageIconForPath } from "./Icons";
import { tabNavigationAction, tabRovingIndex } from "../lib/tab-navigation";
import { t } from "../lib/i18n";

export const WORKBENCH_EDITOR_PANEL_ID = "workbench-editor-panel";
export const WORKBENCH_HISTORY_PANEL_ID = "workbench-history-panel";
export const WORKBENCH_HISTORY_TAB_ID = "workbench-history-tab";

export const workbenchTabId = (tabId: string) => `workbench-tab-${encodeURIComponent(tabId)}`;

export type WorkbenchTabsProps = {
  tabs: readonly EditorTab[];
  activeTabId?: string;
  historyTabOpen: boolean;
  historySelected: boolean;
  onSelectTab: (tabId: string) => void;
  onSelectHistory: () => void;
  onCloseTab: (tabId: string) => void | Promise<unknown>;
  onCloseHistory: () => void | Promise<unknown>;
  onDragStart?: (tabId: string) => void;
  onDragEnd?: () => void;
  onDrop?: (tabId: string) => void;
  onContextMenu?: (tabId: string, event: MouseEvent, tabButton: HTMLButtonElement) => void;
};

type TabKey = `file:${string}` | "history";

export function WorkbenchTabs(props: WorkbenchTabsProps) {
  let tablistElement: HTMLDivElement | undefined;
  const [focusedTabKey, setFocusedTabKey] = createSignal<TabKey>();

  const tabKeys = () => {
    const keys: TabKey[] = props.tabs.map<TabKey>((tab) => `file:${tab.id}`);
    if (props.historyTabOpen) keys.push("history");
    return keys;
  };

  const selectedTabKey = (): TabKey | undefined => {
    if (props.historyTabOpen && props.historySelected) return "history";
    if (props.activeTabId && !props.historySelected && props.tabs.some((tab) => tab.id === props.activeTabId)) {
      return `file:${props.activeTabId}`;
    }
    return undefined;
  };

  const rovingTabIndex = () => {
    const keys = tabKeys();
    const focusedKey = focusedTabKey();
    const focusedIndex = focusedKey ? keys.indexOf(focusedKey) : -1;
    if (focusedIndex >= 0) return focusedIndex;
    const selectedKey = selectedTabKey();
    const selectedIndex = selectedKey ? keys.indexOf(selectedKey) : -1;
    return selectedIndex >= 0 ? selectedIndex : 0;
  };

  const rememberFocusedTab = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.closest<HTMLElement>("[data-tab-key]");
    const key = tab?.dataset.tabKey;
    if (key === "history" || key?.startsWith("file:")) setFocusedTabKey(key as TabKey);
  };

  const moveFocus = (index: number) => {
    const button = tablistElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[index];
    if (!button) return;
    const key = button.dataset.tabKey;
    if (key === "history" || key?.startsWith("file:")) setFocusedTabKey(key as TabKey);
    button.focus({ preventScroll: true });
    const fileId = button.dataset.fileTabId;
    if (fileId) props.onSelectTab(fileId);
    else if (key === "history") props.onSelectHistory();
  };

  const handleTabKeyDown = (event: KeyboardEvent) => {
    const buttons = tablistElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    if (!buttons?.length) return;
    const focusedIndex = Array.from(buttons).indexOf(event.currentTarget as HTMLButtonElement);
    if (focusedIndex < 0) return;
    const action = tabNavigationAction({
      key: event.key,
      count: buttons.length,
      focusedIndex,
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

  const restoreFocusAfterClose = async (key: TabKey, originalIndex: number, close: () => void | Promise<unknown>) => {
    const list = tablistElement;
    const focusWasInTablist = !!list?.contains(document.activeElement);
    await close();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    if (!list?.isConnected || tabKeys().includes(key)) return;
    if (!focusWasInTablist) return;
    const activeElement = document.activeElement;
    const focusWasLostWithRemovedButton = activeElement === document.body || activeElement === document.documentElement;
    if (!focusWasLostWithRemovedButton && !list.contains(activeElement)) return;

    const buttons = list.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    if (!buttons.length) {
      list.focus({ preventScroll: true });
      return;
    }
    const selected = Array.from(buttons).find((button) => button.getAttribute("aria-selected") === "true");
    const target = selected ?? buttons[Math.min(originalIndex, buttons.length - 1)];
    const targetKey = target.dataset.tabKey;
    if (targetKey === "history" || targetKey?.startsWith("file:")) setFocusedTabKey(targetKey as TabKey);
    target.focus({ preventScroll: true });
  };

  const closeTab = (tabId: string) => {
    const key: TabKey = `file:${tabId}`;
    const index = tabKeys().indexOf(key);
    void restoreFocusAfterClose(key, Math.max(0, index), () => props.onCloseTab(tabId));
  };

  const closeHistory = () => {
    const key: TabKey = "history";
    const index = tabKeys().indexOf(key);
    void restoreFocusAfterClose(key, Math.max(0, index), () => props.onCloseHistory());
  };

  return (
    <div
      ref={(element) => { tablistElement = element; }}
      class="tabbar-tabs"
      role="tablist"
      aria-label={t("Open tabs")}
      aria-orientation="horizontal"
      tabIndex={-1}
      onFocusIn={rememberFocusedTab}
    >
      <For each={props.tabs}>{(tab) => {
        const key: TabKey = `file:${tab.id}`;
        const selected = () => props.activeTabId === tab.id && !props.historySelected;
        const index = () => tabKeys().indexOf(key);
        let tabButton: HTMLButtonElement | undefined;

        return (
          <div
            classList={{ tab: true, "tab-active": selected(), "tab-pinned": tab.pinned === true }}
            role="presentation"
            data-tab-key={key}
            draggable="true"
            onDragStart={() => props.onDragStart?.(tab.id)}
            onDragEnd={() => props.onDragEnd?.()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => props.onDrop?.(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                closeTab(tab.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (tabButton) props.onContextMenu?.(tab.id, event, tabButton);
            }}
          >
            <button
              ref={(element) => { tabButton = element; }}
              class="tab-main"
              type="button"
              role="tab"
              id={workbenchTabId(tab.id)}
              data-tab-key={key}
              data-file-tab-id={tab.id}
              aria-selected={selected()}
              aria-controls={WORKBENCH_EDITOR_PANEL_ID}
              tabIndex={tabRovingIndex(index(), rovingTabIndex())}
              onKeyDown={handleTabKeyDown}
              onClick={() => props.onSelectTab(tab.id)}
            >
              <span class="tab-file-icon">
                <Show when={languageIconForPath(tab.path)} fallback={<Icon name="file-code" size={14} />}>
                  {(language) => <LanguageIcon name={language()} size={14} />}
                </Show>
              </span>
              <span>{tab.name}</span>
              <Show when={tab.pinned}><Icon name="lock" size={11} /></Show>
              <Show when={tab.dirty}><span class="dirty-dot" /></Show>
            </button>
            <button
              class="tab-close"
              type="button"
              tabIndex={selected() ? 0 : -1}
              onClick={() => closeTab(tab.id)}
              aria-label={t("Close {name}", { name: tab.name })}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      }}</For>
      <Show when={props.historyTabOpen}>
        <div
          classList={{ tab: true, "tab-active": props.historySelected }}
          role="presentation"
          data-tab-key="history"
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              closeHistory();
            }
          }}
        >
          <button
            class="tab-main"
            type="button"
            role="tab"
            id={WORKBENCH_HISTORY_TAB_ID}
            data-tab-key="history"
            aria-selected={props.historySelected}
            aria-controls={WORKBENCH_HISTORY_PANEL_ID}
            tabIndex={tabRovingIndex(tabKeys().indexOf("history"), rovingTabIndex())}
            onKeyDown={handleTabKeyDown}
            onClick={() => props.onSelectHistory()}
          >
            <span class="tab-file-icon"><Icon name="git" size={14} /></span>
            <span>{t("Git History")}</span>
          </button>
          <button class="tab-close" type="button" tabIndex={props.historySelected ? 0 : -1} onClick={closeHistory} aria-label={t("Close Git History")}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </Show>
      <Show when={!props.tabs.length && !props.historyTabOpen}>
        <div class="empty-tab-label" role="presentation">{t("No file open")}</div>
      </Show>
      <div class="tabbar-fill" role="presentation" />
    </div>
  );
}
