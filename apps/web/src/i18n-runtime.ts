import { createSignal } from "solid-js";
import { refreshReveals } from "./lib/reveal";

export type Locale = "en" | "zh-Hant";

function localeFromDocument(): Locale {
  if (typeof document === "undefined") return "en";
  return document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(localeFromDocument());

export function setLocale(next: Locale) {
  if (locale() === next) return;
  setLocaleSignal(next);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem("pude-web-locale", next);
    } catch {
      // Keep the in-memory locale working when persistence is unavailable.
    }
  }

  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (typeof window !== "undefined") window.requestAnimationFrame(refreshReveals);
}

export function applySavedLocale() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;

  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem("pude-web-locale");
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
  }

  if (saved === "en" || saved === "zh-Hant") {
    setLocale(saved);
    return;
  }

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  setLocale(languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-Hant" : "en");
}

export function localeHref(page: "home" | "docs", next: Locale): string {
  if (page === "home") return next === "zh-Hant" ? "index.zh-Hant.html" : "index.html";
  return next === "zh-Hant" ? "docs.zh-Hant.html" : "docs.html";
}

export function switchLocaleFromLink(event: MouseEvent, page: "home" | "docs", next: Locale) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (typeof window === "undefined") return;

  event.preventDefault();
  window.history.replaceState(null, "", localeHref(page, next));
  setLocale(next);
}

export { locale };
