import { locale, localeHref, switchLocaleFromLink } from "../i18n-runtime";

export default function LanguageToggle(props: { page: "home" | "docs" }) {
  return (
    <div class="lang-toggle" role="group" aria-label="Language">
      <a
        href={localeHref(props.page, "en")}
        classList={{ active: locale() === "en" }}
        aria-current={locale() === "en" ? "page" : undefined}
        onClick={(event) => switchLocaleFromLink(event, props.page, "en")}
      >
        EN
      </a>
      <a
        href={localeHref(props.page, "zh-Hant")}
        classList={{ active: locale() === "zh-Hant" }}
        aria-current={locale() === "zh-Hant" ? "page" : undefined}
        onClick={(event) => switchLocaleFromLink(event, props.page, "zh-Hant")}
      >
        繁中
      </a>
    </div>
  );
}
