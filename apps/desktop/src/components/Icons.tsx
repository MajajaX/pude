import type { JSX } from "solid-js";
import { fileLanguageForPath } from "../lib/file-metadata";
import type { LanguageIconName } from "../lib/file-metadata";
import {
  LANGUAGE_ICON_CELLS,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  SPRITE_URL,
  UI_ICON_CELLS,
} from "./icon-sprite";

type IconName =
  | "folder" | "folder-open" | "file" | "file-code" | "git" | "terminal"
  | "search" | "save" | "plus" | "close" | "refresh" | "settings"
  | "chevron-right" | "chevron-down" | "copy" | "external" | "more"
  | "split" | "play" | "stop" | "sun" | "moon" | "plugin" | "lock"
  | "check" | "arrow-up" | "arrow-down" | "replace" | "command" | "trash"
  | "git-stage" | "git-unstage" | "git-discard";

const CELL = 32;

// All icons live in a single 32x32-cell WebP sprite (see
// scripts/convert-icons.py), so the whole UI costs one request instead of one
// custom-protocol fetch per icon.
function spriteStyle(cell: number, size: number): JSX.CSSProperties {
  const column = cell % SPRITE_COLUMNS;
  const row = Math.floor(cell / SPRITE_COLUMNS);
  const scale = size / CELL;
  return {
    width: `${size}px`,
    height: `${size}px`,
    "background-image": `url("${SPRITE_URL}")`,
    "background-repeat": "no-repeat",
    "background-size": `${SPRITE_COLUMNS * CELL * scale}px ${SPRITE_ROWS * CELL * scale}px`,
    "background-position": `${-column * size}px ${-row * size}px`,
  };
}

export function Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
  return <span class={`pude-icon pude-icon-${props.name}${props.class ? ` ${props.class}` : ""}`} style={spriteStyle(UI_ICON_CELLS[props.name], props.size ?? 16)} role="img" aria-hidden="true" />;
}

export function LanguageIcon(props: { name: LanguageIconName; size?: number; class?: string }): JSX.Element {
  return <span class={`language-icon language-icon-${props.name}${props.class ? ` ${props.class}` : ""}`} style={spriteStyle(LANGUAGE_ICON_CELLS[props.name], props.size ?? 16)} role="img" aria-hidden="true" />;
}

export function languageIconForPath(path: string): LanguageIconName | undefined {
  return fileLanguageForPath(path).icon;
}

export type { IconName, LanguageIconName };
