import { Show, createEffect } from "solid-js";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";

export type TabMenuAction = "pin" | "save-as" | "close" | "close-others" | "close-right" | "close-saved" | "close-all" | "copy-path" | "copy-relative-path" | "reveal";

export function TabContextMenu(props: {
  x: number;
  y: number;
  pinned: boolean;
  canSaveAs: boolean;
  revealLabel: string;
  onAction: (action: TabMenuAction) => void;
}) {
  let menu!: HTMLDivElement;
  // Keep the whole menu on screen, as the Explorer menu does.
  createEffect(() => {
    const x = props.x;
    const y = props.y;
    queueMicrotask(() => {
      if (!menu.isConnected) return;
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    });
  });
  const item = (action: TabMenuAction, icon: Parameters<typeof Icon>[0]["name"], label: string) =>
    <button onClick={() => props.onAction(action)}><Icon name={icon} size={13} /> {label}</button>;
  return <div ref={menu} class="tab-context-menu" style={{ left: `${props.x}px`, top: `${props.y}px` }} onClick={(event) => event.stopPropagation()}>
    {item("pin", "lock", props.pinned ? t("Unpin") : t("Pin"))}
    <Show when={props.canSaveAs}>{item("save-as", "save", t("Save As…"))}</Show>
    <div class="tab-context-menu-divider" />
    {item("close", "close", t("Close"))}
    {item("close-others", "split", t("Close others"))}
    {item("close-right", "arrow-down", t("Close to right"))}
    {item("close-saved", "check", t("Close saved"))}
    {item("close-all", "close", t("Close all"))}
    <div class="tab-context-menu-divider" />
    {item("copy-path", "copy", t("Copy Path"))}
    {item("copy-relative-path", "copy", t("Copy Relative Path"))}
    {item("reveal", "external", props.revealLabel)}
  </div>;
}
