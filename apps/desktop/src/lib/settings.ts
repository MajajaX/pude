import type { AppSettings } from "../types";

export const defaultSettings = {
  theme: "dark",
  fontSize: 14,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
  sidebarWidth: 276,
  terminalHeight: 238,
  hideDotFiles: false,
  checkForUpdates: true,
  watcherExcludes: [],
} satisfies AppSettings;

type NumericSetting = "fontSize" | "tabSize" | "sidebarWidth" | "terminalHeight";

const ranges: Record<NumericSetting, { min: number; max: number }> = {
  fontSize: { min: 11, max: 24 },
  tabSize: { min: 1, max: 8 },
  sidebarWidth: { min: 215, max: 520 },
  terminalHeight: { min: 160, max: 600 },
};

export function clampSetting(name: NumericSetting, value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const range = ranges[name];
  return Math.min(range.max, Math.max(range.min, Math.round(numeric)));
}

export function validateSettings(value: unknown, defaults: AppSettings): AppSettings {
  const stored = isRecord(value) ? value : {};
  return {
    theme: stored.theme === "light" || stored.theme === "dark" ? stored.theme : defaults.theme,
    fontSize: clampSetting("fontSize", stored.fontSize, defaults.fontSize),
    tabSize: clampSetting("tabSize", stored.tabSize, defaults.tabSize),
    insertSpaces: typeof stored.insertSpaces === "boolean" ? stored.insertSpaces : defaults.insertSpaces,
    wordWrap: typeof stored.wordWrap === "boolean" ? stored.wordWrap : defaults.wordWrap,
    sidebarWidth: clampSetting("sidebarWidth", stored.sidebarWidth, defaults.sidebarWidth),
    terminalHeight: clampSetting("terminalHeight", stored.terminalHeight, defaults.terminalHeight),
    hideDotFiles: typeof stored.hideDotFiles === "boolean" ? stored.hideDotFiles : defaults.hideDotFiles,
    checkForUpdates: typeof stored.checkForUpdates === "boolean" ? stored.checkForUpdates : defaults.checkForUpdates,
    watcherExcludes: parseWatcherExcludes(stored.watcherExcludes, defaults.watcherExcludes),
  };
}

export function parseWatcherExcludes(value: unknown, fallback: readonly string[] = []): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\r\n,]+/) : fallback;
  const seen = new Set<string>();
  const excludes: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || normalized.length > 512 || seen.has(normalized)) continue;
    seen.add(normalized);
    excludes.push(normalized);
    if (excludes.length >= 64) break;
  }
  return excludes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type { NumericSetting };
