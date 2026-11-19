import { applyLanguage } from "./i18n";
import { defaultSettings, SETTINGS_STORAGE_KEY, validateSettings } from "./settings";

function storedLanguage() {
  try {
    return validateSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null"), defaultSettings).language;
  } catch {
    return defaultSettings.language;
  }
}

// The Latin subsets of Inter and JetBrains Mono; the other subsets load only when a glyph needs them.
// A font that cannot load must not hold up the window, so its text falls back to a system font.
const loadFonts = () =>
  Promise.all([
    document.fonts.load('1em "Inter Variable"'),
    document.fonts.load('1em "JetBrains Mono Variable"'),
  ]).catch(() => {});

/**
 * main.tsx imports this module before the app code, so the language file of a Traditional Chinese
 * interface and the two fonts start downloading while the rest of the app is still being evaluated.
 * The first frame waits for them, so neither text nor fonts change after it appears.
 */
export const firstFrameResources = Promise.all([applyLanguage(storedLanguage()), loadFonts()]);
