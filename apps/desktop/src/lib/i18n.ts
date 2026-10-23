import { batch, createSignal } from "solid-js";

/** Languages the interface ships in. English is the source text and needs no file. */
export type Locale = "en" | "zh-Hant";
export type LanguageSetting = "auto" | Locale;
export type Dictionary = Readonly<Record<string, string>>;

const [dictionary, setDictionary] = createSignal<Dictionary>({});
const [currentLocale, setCurrentLocale] = createSignal<Locale>("en");
export const locale = currentLocale;

// Each language is its own chunk, fetched only when it is the active language.
const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Dictionary }>> = {
  "zh-Hant": () => import("../locales/zh-Hant"),
};

/**
 * Translate interface text. The English text is the key, so a missing
 * translation shows English. `{name}` placeholders are filled from `values`.
 */
export function t(text: string, values?: Record<string, string | number | null | undefined>): string {
  const translated = dictionary()[text] ?? text;
  if (!values) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
}

/** Marks English text in a data table; it is translated where it is shown, with `t()`. */
export const translatable = (text: string): string => text;

/**
 * Translate a message from the native side, Git or a thrown error. Known
 * messages translate whole; otherwise a known first sentence translates and
 * the detail after it, such as a path or an OS error, stays as it is.
 */
export function translateMessage(message: string): string {
  const table = dictionary();
  const whole = table[message];
  if (whole) return whole;
  const sentenceEnd = message.indexOf(". ");
  if (sentenceEnd < 0) return message;
  const first = table[message.slice(0, sentenceEnd + 1)];
  return first ? `${first}${/[。！？]$/.test(first) ? "" : " "}${message.slice(sentenceEnd + 2)}` : message;
}

/** `auto` follows the system: Traditional Chinese regions get zh-Hant, everything else English. */
export function resolveLocale(setting: LanguageSetting, languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages): Locale {
  if (setting !== "auto") return setting;
  for (const tag of languages) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(lower) ? "zh-Hant" : "en";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

let languageRequest = 0;

export async function applyLanguage(setting: LanguageSetting): Promise<void> {
  const next = resolveLocale(setting);
  const request = ++languageRequest;
  let table: Dictionary = {};
  if (next !== "en") {
    try {
      table = (await loaders[next]()).default;
    } catch {
      return;
    }
  }
  if (request !== languageRequest) return;
  batch(() => {
    setDictionary(table);
    setCurrentLocale(next);
  });
  if (typeof document !== "undefined") document.documentElement.lang = next;
}
