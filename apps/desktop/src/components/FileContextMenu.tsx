import { Show, createEffect } from "solid-js";
import type { DirectoryEntry } from "../types";
import { Icon } from "./Icons";

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
      <button onClick={() => props.onAction("new-file")}><Icon name="plus" size={13} /> New file</button>
      <button onClick={() => props.onAction("new-folder")}><Icon name="folder" size={13} /> New folder</button>
    </Show>
    <button onClick={() => props.onCopyPath(false)}><Icon name="copy" size={13} /> Copy Path</button>
    <Show when={props.showRelativePath}><button onClick={() => props.onCopyPath(true)}><Icon name="copy" size={13} /> Copy Relative Path</button></Show>
    <button onClick={props.onOpenTerminal}><Icon name="terminal" size={13} /> Open in Integrated Terminal</button>
    <button onClick={props.onReveal}><Icon name="external" size={13} /> {props.revealLabel}</button>
    <button onClick={() => props.onAction("rename")}><Icon name="file" size={13} /> Rename</button>
    <button onClick={() => props.onAction("delete")}><Icon name="trash" size={13} /> Delete</button>
  </div>;
}
