import type { CommandPaletteItem } from "./plugin-activation";

export const RECENT_COMMANDS_STORAGE_KEY = "pude-recent-commands-v1";
const RECENT_COMMAND_LIMIT = 8;

const normalize = (value: string) => value.normalize("NFKD").toLocaleLowerCase();

/** Every word of the query must appear somewhere in the text, in any order. */
export function matchesAllWords(text: string, query: string): boolean {
  const haystack = normalize(text);
  return normalize(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** Recently run commands first, most recent first; the rest keep their order. */
export function orderByRecent(commands: readonly CommandPaletteItem[], recentIds: readonly string[]): CommandPaletteItem[] {
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return [...commands].sort((left, right) => (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity));
}

export function rememberRecentCommand(recentIds: readonly string[], id: string): string[] {
  return [id, ...recentIds.filter((recent) => recent !== id)].slice(0, RECENT_COMMAND_LIMIT);
}

export function loadRecentCommands(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_COMMAND_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveRecentCommands(recentIds: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(recentIds));
  } catch {
    // The order is a convenience; running the command matters more.
  }
}

/** Show `Mod+Shift+P` as `⌘⇧P` on macOS and `Ctrl+Shift+P` elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  if (!mac) return shortcut.replace(/\bMod\b/g, "Ctrl");
  const symbols: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Down: "↓", Up: "↑" };
  return shortcut.split("+").map((part) => symbols[part] ?? part).join("");
}
