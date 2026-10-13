import { createEffect, Show, type JSX } from "solid-js";
import { Icon, type IconName } from "./Icons";
import { nextMenuItemIndex } from "../lib/menu-keyboard";

const menuItemSelector = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';
const tabCandidateSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(",");

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

export function TopbarMenu(props: {
  label: string;
  open: boolean;
  onToggle: () => void;
  triggerRef?: (element: HTMLButtonElement) => void;
  children: JSX.Element;
}) {
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  let focusLastWhenOpened = false;
  const menuId = `topbar-menu-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const menuItems = () => Array.from(menu?.querySelectorAll<HTMLElement>(menuItemSelector) ?? []);

  const focusMenuItem = (index: number) => {
    const items = menuItems();
    if (!items.length) return;
    const nextIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === nextIndex ? 0 : -1; });
    items[nextIndex].focus({ preventScroll: true });
  };

  createEffect(() => {
    if (!props.open) return;
    const focusLast = focusLastWhenOpened;
    focusLastWhenOpened = false;
    queueMicrotask(() => {
      if (!props.open || !menu?.isConnected) return;
      focusMenuItem(focusLast ? menuItems().length - 1 : 0);
    });
  });

  const handleTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusLastWhenOpened = event.key === "ArrowUp";
    if (props.open) {
      focusMenuItem(focusLastWhenOpened ? menuItems().length - 1 : 0);
      focusLastWhenOpened = false;
    }
    else props.onToggle();
  };

  const handleMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      trigger?.focus({ preventScroll: true });
      props.onToggle();
      return;
    }

    if (event.key === "Tab") {
      const items = menuItems();
      const allControls = Array.from(document.querySelectorAll<HTMLElement>(tabCandidateSelector))
        .filter((element) => isVisible(element));
      const triggerIndex = trigger ? allControls.indexOf(trigger) : -1;
      const lastItemIndex = items.length ? allControls.indexOf(items[items.length - 1]) : -1;
      const next = event.shiftKey
        ? allControls.slice(0, triggerIndex).filter((element) => element.tabIndex >= 0).at(-1)
        : allControls.slice(lastItemIndex + 1).find((element) => element.tabIndex >= 0 && !menu?.contains(element));

      event.preventDefault();
      props.onToggle();
      (next ?? trigger)?.focus({ preventScroll: true });
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = menuItems();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextMenuItemIndex(event.key, currentIndex, items.length);
    if (nextIndex === null) return;
    event.preventDefault();
    focusMenuItem(nextIndex);
  };

  const handleMenuFocusIn = (event: FocusEvent) => {
    const items = menuItems();
    const focusedIndex = items.indexOf(event.target as HTMLElement);
    if (focusedIndex >= 0) items.forEach((item, index) => { item.tabIndex = index === focusedIndex ? 0 : -1; });
  };

  return (
    <div class="topbar-menu" onClick={(event) => event.stopPropagation()}>
      <button
        ref={(element) => { trigger = element; props.triggerRef?.(element); }}
        classList={{ "topbar-menu-trigger": true, "topbar-menu-trigger-open": props.open }}
        type="button"
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-controls={props.open ? menuId : undefined}
        onClick={props.onToggle}
        onKeyDown={handleTriggerKeyDown}
      >
        {props.label}
        <Icon name="chevron-down" size={11} />
      </button>
      <Show when={props.open}>
        <div
          ref={(element) => { menu = element; }}
          class="topbar-menu-popover"
          id={menuId}
          role="menu"
          aria-label={`${props.label} menu`}
          onKeyDown={handleMenuKeyDown}
          onFocusIn={handleMenuFocusIn}
        >
          {props.children}
        </div>
      </Show>
    </div>
  );
}

export function TopbarMenuItem(props: {
  icon: IconName;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <button class="topbar-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={props.onSelect}>
      <Icon name={props.icon} size={14} />
      <span>{props.label}</span>
      <Show when={props.shortcut}><kbd>{props.shortcut}</kbd></Show>
    </button>
  );
}
