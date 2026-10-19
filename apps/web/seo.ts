import packageInfo from "./package.json" with { type: "json" };
import { LOCALES, PAGE_META, PAGE_PATHS, SITE_URL, type Locale, type Page } from "./src/site.ts";

const repositoryUrl = packageInfo.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

export const SITE_ROUTES = (["home", "docs"] as const).flatMap((page) =>
  LOCALES.map((locale) => ({
    page,
    locale,
    key: `${page}-${locale}`,
    file: `${locale === "en" ? "" : "zh/"}${page === "home" ? "index" : "docs"}.html`,
    path: PAGE_PATHS[page][locale],
  })),
);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function renderSeoHead(page: Page, locale: Locale): string {
  const meta = PAGE_META[page][locale];
  const canonical = `${SITE_URL}${PAGE_PATHS[page][locale]}`;
  const otherLocale = locale === "en" ? "zh-Hant" : "en";
  const graph: Record<string, unknown>[] = [{
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: "pude",
    inLanguage: LOCALES,
  }, {
    "@type": "WebPage",
    "@id": `${canonical}#webpage`,
    url: canonical,
    name: meta.title,
    description: meta.description,
    inLanguage: locale,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    ...(page === "home" ? { mainEntity: { "@id": `${SITE_URL}/#software` } } : {}),
  }];

  if (page === "home") {
    graph.push({
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "pude",
      url: `${SITE_URL}/`,
      description: meta.description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: ["Windows 11 (x64)", "macOS 14 or later (Apple Silicon)"],
      softwareVersion: packageInfo.version,
      license: `${repositoryUrl}/blob/main/LICENSE`,
      sameAs: repositoryUrl,
      isAccessibleForFree: true,
      image: `${SITE_URL}/shots/editor.webp`,
    });
  }

  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const ogLocale = (value: Locale) => value === "en" ? "en_US" : "zh_TW";
  const imageAlt = locale === "en"
    ? "pude — pure code editor. Fast. Local. Focused. Mint cursor on a dark background."
    : "pude 純粹的程式碼編輯器：快速、在地、專注。深色背景搭配薄荷綠游標。";

  return [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    ...LOCALES.map((language) => `<link rel="alternate" hreflang="${language}" href="${SITE_URL}${PAGE_PATHS[page][language]}" />`),
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}${PAGE_PATHS[page].en}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pude" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:image" content="${SITE_URL}/og-image.png" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1280" />`,
    `<meta property="og:image:height" content="640" />`,
    `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />`,
    `<meta property="og:locale" content="${ogLocale(locale)}" />`,
    `<meta property="og:locale:alternate" content="${ogLocale(otherLocale)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${SITE_URL}/og-image.png" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}" />`,
    `<script type="application/ld+json">${json}</script>`,
  ].join("\n    ");
}

export function renderSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${SITE_ROUTES.map(({ page, path }) => `  <url>
    <loc>${SITE_URL}${path}</loc>
${LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${SITE_URL}${PAGE_PATHS[page][locale]}" />`).join("\n")}
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}${PAGE_PATHS[page].en}" />
  </url>`).join("\n")}
</urlset>
`;
}
