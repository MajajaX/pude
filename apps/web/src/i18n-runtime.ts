import { createSignal } from "solid-js";
import type { Locale } from "./site";

export type { Locale } from "./site";
export { localeHref } from "./site";

function localeFromDocument(): Locale {
  if (typeof document === "undefined") return "en";
  return document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "en";
}

export const [locale, setLocale] = createSignal<Locale>(localeFromDocument());
