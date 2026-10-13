import { generateHydrationScript, renderToString } from "solid-js/web";
import App from "./App";
import DocsApp from "./components/DocsApp";
import { setLocale, type Locale } from "./i18n-runtime";

export function prerenderPage(page: "home" | "docs", nextLocale: Locale): string {
  setLocale(nextLocale);
  return renderToString(() => (page === "home" ? <App /> : <DocsApp />));
}

export function hydrationScript(): string {
  return generateHydrationScript();
}
