import { createSignal, onCleanup, onMount } from "solid-js";
import { locale, localeHref, t } from "../i18n";
import { REPOSITORY_URL } from "../release-info";
import BrandMark from "./BrandMark";
import LanguageToggle from "./LanguageToggle";

export default function Nav() {
  const [scrolled, setScrolled] = createSignal(false);

  const onScroll = () => setScrolled(window.scrollY > 24);

  onMount(() => {
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  });
  onCleanup(() => {
    if (typeof window !== "undefined") window.removeEventListener("scroll", onScroll);
  });

  return (
    <header class="nav" classList={{ "is-scrolled": scrolled() }}>
      <div class="wrap nav-inner">
        <a class="brand" href="#top">
          <BrandMark />
          <span class="brand-name">pude</span>
          <span class="brand-sub">pure code editor</span>
        </a>
        <nav class="nav-links" aria-label={t().nav.sections}>
          <a href="#showcase">{t().nav.showcase}</a>
          <a href="#features">{t().nav.features}</a>
          <a href="#architecture">{t().nav.architecture}</a>
          <a href="#philosophy">{t().nav.philosophy}</a>
          <a href={localeHref("docs", locale())}>{t().nav.docs}</a>
          <a href={REPOSITORY_URL}>GitHub</a>
        </nav>
        <div class="nav-right">
          <LanguageToggle page="home" />
          <a class="nav-cta" href="#download">
            {t().nav.download}
          </a>
        </div>
      </div>
      <span class="nav-progress" aria-hidden="true" />
    </header>
  );
}
