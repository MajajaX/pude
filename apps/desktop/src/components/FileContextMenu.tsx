import { Show, createEffect, createSignal } from "solid-js";
import type { DirectoryEntry } from "../types";
import { Icon } from "./Icons";
import { t } from "../lib/i18n";
import { addEntryToGitignore, canAddToGitignore } from "../lib/add-to-gitignore";

export function FileContextMenu(props: {
  entry: DirectoryEntry;
  x: number;
  y: number;
  showRelativePath: boolean;
  revealLabel: string;
  onAction: (action: "new-file" | "new-folder" | "rename" | "delete") => void;
  onCopy: (kind: "path" | "relative-path" | "name") => void;
  canPaste: boolean;
  onCopyItem: () => void;
  onPasteItem: () => void;
  onOpenTerminal: () => void;
  onReveal: () => void;
  workspace: string;
  repositoryRoot: string;
  ignored: boolean;
  onGitignoreOutcome: (outcome: Promise<string>) => void;
  /** Present on the top folder rows of a multi-folder workspace. */
  onRemoveFolder?: () => void;
}) {
  let menu!: HTMLDivElement;
  let copyTrigger!: HTMLButtonElement;
  let copyMenu: HTMLDivElement | undefined;
  const [copyOpen, setCopyOpen] = createSignal(false);
  const openCopyMenu = (focusFirstItem: boolean) => {
    setCopyOpen(true);
    queueMicrotask(() => {
      if (!copyMenu) return;
      const parent = menu.getBoundingClientRect();
      const trigger = copyTrigger.getBoundingClientRect();
      const bounds = copyMenu.getBoundingClientRect();
      const fitsRight = parent.right + bounds.width + 8 <= innerWidth;
      copyMenu.style.left = `${fitsRight ? parent.right - 4 : Math.max(8, parent.left - bounds.width + 4)}px`;
      copyMenu.style.top = `${Math.max(8, Math.min(trigger.top - 5, innerHeight - bounds.height - 8))}px`;
      if (focusFirstItem) copyMenu.querySelector("button")?.focus();
    });
  };
  const closeCopyMenu = () => {
    setCopyOpen(false);
    copyTrigger.focus();
  };
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
  return <div ref={menu} class="file-context-menu" style={{ left: `${props.x}px`, top: `${props.y}px` }} onClick={(event) => event.stopPropagation()}
    onMouseOver={(event) => { const target = event.target as Node; if (!copyTrigger.contains(target) && !copyMenu?.contains(target)) setCopyOpen(false); }}>
    <button onClick={() => props.onAction("new-file")}><Icon name="plus" size={13} /> {t("New file")}</button>
    <button onClick={() => props.onAction("new-folder")}><Icon name="folder" size={13} /> {t("New folder")}</button>
    <button ref={copyTrigger} class="file-context-submenu-trigger" aria-haspopup="menu" aria-expanded={copyOpen()}
      onMouseEnter={() => openCopyMenu(false)} onClick={(event) => openCopyMenu(event.detail === 0)}
      onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); openCopyMenu(true); } }}>
      <Icon name="copy" size={13} /> {t("Copy")}<Icon name="chevron-right" size={12} />
    </button>
    <Show when={copyOpen()}>
      <div ref={copyMenu} class="file-context-menu file-context-submenu" role="menu" aria-label={t("Copy")}
        onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCopyMenu(); } }}>
        <button onClick={props.onCopyItem}><Icon name="copy" size={13} /> {props.entry.kind === "directory" ? t("Copy Folder") : t("Copy File")}</button>
        <button onClick={() => props.onCopy("name")}><Icon name="copy" size={13} /> {t("Copy Name")}</button>
        <button onClick={() => props.onCopy("path")}><Icon name="copy" size={13} /> {t("Copy Path")}</button>
        <Show when={props.showRelativePath}><button onClick={() => props.onCopy("relative-path")}><Icon name="copy" size={13} /> {t("Copy Relative Path")}</button></Show>
      </div>
    </Show>
    <button disabled={!props.canPaste} onClick={props.onPasteItem}><Icon name="file" size={13} /> {t("Paste")}</button>
    <button onClick={props.onOpenTerminal}><Icon name="terminal" size={13} /> {t("Open in Integrated Terminal")}</button>
    <button onClick={props.onReveal}><Icon name="external" size={13} /> {props.revealLabel}</button>
    <Show when={!props.ignored && canAddToGitignore(props.entry.path, props.repositoryRoot)}><button onClick={() => props.onGitignoreOutcome(addEntryToGitignore(props.workspace, props.entry))}><Icon name="git" size={13} /> {t("Add to .gitignore")}</button></Show>
    <Show when={props.onRemoveFolder} fallback={<>
      <button onClick={() => props.onAction("rename")}><Icon name="file" size={13} /> {t("Rename")}</button>
      <button onClick={() => props.onAction("delete")}><Icon name="trash" size={13} /> {t("Delete")}</button>
    </>}>{(remove) => <button onClick={remove()}><Icon name="close" size={13} /> {t("Remove Folder from Workspace")}</button>}</Show>
  </div>;
}
