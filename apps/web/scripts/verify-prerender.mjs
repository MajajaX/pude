import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  {
    file: "dist/index.html",
    canonical: "https://pude.dev/",
    locale: "en",
    anchors: ["top", "showcase", "features", "architecture", "philosophy", "shortcuts", "download"],
    alternate: "/zh/",
    navigation: "/docs",
  },
  {
    file: "dist/zh/index.html",
    canonical: "https://pude.dev/zh/",
    locale: "zh-Hant",
    anchors: ["top", "showcase", "features", "architecture", "philosophy", "shortcuts", "download"],
    alternate: "/",
    navigation: "/zh/docs",
  },
  {
    file: "dist/docs.html",
    canonical: "https://pude.dev/docs",
    locale: "en",
    anchors: ["overview", "releases", "usage", "git", "terminal", "settings", "shortcuts", "plugins", "installation"],
    alternate: "/zh/docs",
    navigation: "/",
  },
  {
    file: "dist/zh/docs.html",
    canonical: "https://pude.dev/zh/docs",
    locale: "zh-Hant",
    anchors: ["overview", "releases", "usage", "git", "terminal", "settings", "shortcuts", "plugins", "installation"],
    alternate: "/docs",
    navigation: "/zh/",
  },
];

const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const redirectSource = await readFile(new URL("../public/_redirects", import.meta.url), "utf8");
assert.equal(await readFile(new URL("../dist/_redirects", import.meta.url), "utf8"), redirectSource, "the deployment should include the redirect rules");
const redirects = new Map();
for (const line of redirectSource.trim().split("\n")) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  const [source, destination, status] = line.trim().split(/\s+/);
  assert.equal(status, "301", `${source} should permanently redirect`);
  assert.ok(!redirects.has(source), `${source} should have only one redirect`);
  assert.ok(!routes.some((route) => route.canonical === `https://pude.dev${source}`), `${source} should not redirect a canonical page`);
  assert.ok(routes.some((route) => route.canonical === `https://pude.dev${destination}`), `${source} should redirect directly to a canonical page`);
  assert.notEqual(source, destination, `${source} should not redirect to itself`);
  redirects.set(source, destination);
}
for (const suffix of ["", ".html", "/"]) {
  assert.equal(redirects.get(`/index.zh-Hant${suffix}`), "/zh/");
  assert.equal(redirects.get(`/docs.zh-Hant${suffix}`), "/zh/docs");
}
const sitemap = await readFile(new URL("../dist/sitemap.xml", import.meta.url), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
assert.deepEqual(sitemapUrls.sort(), routes.map((route) => route.canonical).sort(), "sitemap should contain exactly the four canonical pages");

const pages = new Map();
const titles = new Set();
const unescapeHtml = (value) => value.replace(/&(amp|quot|#39|lt|gt);/g, (_, entity) => ({ amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" })[entity]);

for (const route of routes) {
  const html = await readFile(new URL(`../${route.file}`, import.meta.url), "utf8");
  pages.set(route.canonical, html);
  const roots = html.match(/<div id="root">/g) ?? [];
  assert.equal(roots.length, 1, `${route.file} should have one hydration root`);
  assert.match(html, new RegExp(`<html lang="${route.locale}">`), `${route.file} should declare its locale`);
  assert.ok(html.includes(`<h1`), `${route.file} should render its primary heading`);
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, "").trim();
  assert.ok(heading, `${route.file} should render a non-empty primary heading`);
  assert.ok(html.includes(`href="${route.alternate}"`), `${route.file} should link to the other static locale`);
  assert.ok(html.includes(`href="${route.navigation}"`), `${route.file} should link to its localized counterpart page`);
  assert.ok(html.includes("rel=\"stylesheet\""), `${route.file} should include its stylesheet without JavaScript`);
  assert.ok(html.includes("_$HY"), `${route.file} should include the Solid hydration bootstrap`);
  assert.ok(html.includes(`<link rel="canonical" href="${route.canonical}"`), `${route.file} should declare its canonical URL`);
  assert.ok(html.includes(`<meta property="og:url" content="${route.canonical}"`), `${route.file} should share its canonical URL`);
  assert.ok(html.includes(`<meta property="og:image" content="https://pude.dev/og-image.png"`), `${route.file} should include the social preview image`);

  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
  const title = unescapeHtml(head.match(/<title>([^<]+)<\/title>/)?.[1] ?? "");
  const description = unescapeHtml(head.match(/<meta name="description" content="([^"]+)"/)?.[1] ?? "");
  assert.ok(title && description, `${route.file} should include non-empty metadata`);
  assert.ok(!titles.has(title), `${route.file} should have a distinct page title`);
  titles.add(title);
  assert.equal((head.match(/rel="canonical"/g) ?? []).length, 1, `${route.file} should declare exactly one canonical`);
  assert.equal((head.match(/<title>/g) ?? []).length, 1, `${route.file} should declare exactly one title`);
  assert.ok(!/noindex/i.test(head), `${route.file} should remain indexable`);
  assert.ok(!head.includes("<!-- seo -->"), `${route.file} should resolve its SEO template`);
  assert.ok(head.includes(`<meta property="og:title" content="${head.match(/<title>([^<]+)<\/title>/)[1]}"`), `${route.file} should share the same title`);

  const alternates = [...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)];
  const siblings = route.file.includes("docs") ? routes.slice(2) : routes.slice(0, 2);
  for (const sibling of siblings) {
    assert.ok(alternates.some(([, locale, url]) => locale === sibling.locale && url === sibling.canonical), `${route.file} should link reciprocally to ${sibling.locale}`);
  }
  assert.equal(alternates.length, 3, `${route.file} should include only its two language versions and x-default`);

  const scripts = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, `${route.file} should have one structured data graph`);
  const data = JSON.parse(scripts[0][1]);
  assert.equal(data["@context"], "https://schema.org");
  const page = data["@graph"].find((entry) => entry["@type"] === "WebPage");
  assert.equal(page.url, route.canonical);
  assert.equal(page.inLanguage, route.locale);
  assert.equal(page.name, title, `${route.file} structured data should match its title`);
  assert.equal(page.description, description, `${route.file} structured data should match its description`);
  const software = data["@graph"].find((entry) => entry["@type"] === "SoftwareApplication");
  if (route.file.includes("index")) {
    assert.ok(software, `${route.file} should describe the app`);
    assert.equal(software.softwareVersion, packageInfo.version, `${route.file} should use the current app version`);
    assert.equal(software["@id"], page.mainEntity["@id"]);
    assert.equal(software.applicationCategory, "DeveloperApplication");
    assert.equal(software.isAccessibleForFree, true);
    assert.ok(software.operatingSystem.every((os) => /Windows 11|macOS 14/.test(os)));
  } else {
    assert.equal(software, undefined, `${route.file} should describe documentation as a web page`);
  }

  for (const anchor of route.anchors) {
    assert.ok(html.includes(`id="${anchor}"`), `${route.file} should include the #${anchor} target`);
  }
}

for (const [canonical, html] of pages) {
  for (const [, rawHref] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    const url = new URL(unescapeHtml(rawHref), canonical);
    if (url.origin !== "https://pude.dev") continue;
    assert.ok(!url.pathname.endsWith(".html"), `${canonical} should link directly to canonical pages: ${url}`);
    const target = `${url.origin}${url.pathname}`;
    assert.ok(pages.has(target), `${canonical} should link to an existing page: ${url}`);
    if (url.hash) assert.ok(pages.get(target).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${canonical} should link to an existing section: ${url}`);
  }
}

console.log(`Verified ${routes.length} localized pages, metadata, structured data, sitemap, internal links and ${redirects.size} permanent redirects.`);
