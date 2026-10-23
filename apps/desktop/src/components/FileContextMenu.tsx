import { Show, createEffect } from "solid-js";
import type { DirectoryEntry } from "../types";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";

export function FileContextMenu(props: {
  entry: DirectoryEntry;
  x: number;
  y: number;
  showRelativePath: boolean;
  revealLabel: string;
  onAction: (action: "new-file" | "new-folder" | "rename" | "delete") => void;
  onCopyPath: (relative: boolean) => void;
  onOpenTerminal: () => void;
  onReveal: () => void;
  /** Present on the top folder rows of a multi-folder workspace. */
  onRemoveFolder?: () => void;
}) {
  let menu!: HTMLDivElement;
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
  return <div ref={menu} class="file-context-menu" style={{ left: `${props.x}px`, top: `${props.y}px` }} onClick={(event) => event.stopPropagation()}>
    <Show when={props.entry.kind === "directory"}>
      <button onClick={() => props.onAction("new-file")}><Icon name="plus" size={13} /> {t("New file")}</button>
      <button onClick={() => props.onAction("new-folder")}><Icon name="folder" size={13} /> {t("New folder")}</button>
    </Show>
    <button onClick={() => props.onCopyPath(false)}><Icon name="copy" size={13} /> {t("Copy Path")}</button>
    <Show when={props.showRelativePath}><button onClick={() => props.onCopyPath(true)}><Icon name="copy" size={13} /> {t("Copy Relative Path")}</button></Show>
    <button onClick={props.onOpenTerminal}><Icon name="terminal" size={13} /> {t("Open in Integrated Terminal")}</button>
    <button onClick={props.onReveal}><Icon name="external" size={13} /> {props.revealLabel}</button>
    <Show when={props.onRemoveFolder} fallback={<>
      <button onClick={() => props.onAction("rename")}><Icon name="file" size={13} /> {t("Rename")}</button>
      <button onClick={() => props.onAction("delete")}><Icon name="trash" size={13} /> {t("Delete")}</button>
    </>}>{(remove) => <button onClick={remove()}><Icon name="close" size={13} /> {t("Remove Folder from Workspace")}</button>}</Show>
  </div>;
}
