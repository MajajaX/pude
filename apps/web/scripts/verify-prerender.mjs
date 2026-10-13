import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  {
    file: "dist/index.html",
    canonical: "https://pude.dev/",
    locale: "en",
    title: "Nothing else.",
    anchors: ["top", "showcase", "features", "architecture", "philosophy", "shortcuts", "download"],
    alternate: "index.zh-Hant.html",
    navigation: "docs.html",
  },
  {
    file: "dist/index.zh-Hant.html",
    canonical: "https://pude.dev/index.zh-Hant",
    locale: "zh-Hant",
    title: "僅此而已",
    anchors: ["top", "showcase", "features", "architecture", "philosophy", "shortcuts", "download"],
    alternate: "index.html",
    navigation: "docs.zh-Hant.html",
  },
  {
    file: "dist/docs.html",
    canonical: "https://pude.dev/docs",
    locale: "en",
    title: "Documentation",
    anchors: ["overview", "releases", "usage", "git", "terminal", "settings", "shortcuts", "plugins", "installation"],
    alternate: "docs.zh-Hant.html",
    navigation: "index.html",
  },
  {
    file: "dist/docs.zh-Hant.html",
    canonical: "https://pude.dev/docs.zh-Hant",
    locale: "zh-Hant",
    title: "使用文件",
    anchors: ["overview", "releases", "usage", "git", "terminal", "settings", "shortcuts", "plugins", "installation"],
    alternate: "docs.html",
    navigation: "index.zh-Hant.html",
  },
];

for (const route of routes) {
  const html = await readFile(new URL(`../${route.file}`, import.meta.url), "utf8");
  const roots = html.match(/<div id="root">/g) ?? [];
  assert.equal(roots.length, 1, `${route.file} should have one hydration root`);
  assert.match(html, new RegExp(`<html lang="${route.locale}">`), `${route.file} should declare its locale`);
  assert.ok(html.includes(`<h1`), `${route.file} should render its primary heading`);
  assert.ok(html.includes(route.title), `${route.file} should render its localized title`);
  assert.ok(html.includes(`href="${route.alternate}"`), `${route.file} should link to the other static locale`);
  assert.ok(html.includes(`href="${route.navigation}"`), `${route.file} should link to its localized counterpart page`);
  assert.ok(html.includes("rel=\"stylesheet\""), `${route.file} should include its stylesheet without JavaScript`);
  assert.ok(html.includes("_$HY"), `${route.file} should include the Solid hydration bootstrap`);
  assert.ok(html.includes(`<link rel="canonical" href="${route.canonical}"`), `${route.file} should declare its canonical URL`);
  assert.ok(html.includes(`<meta property="og:url" content="${route.canonical}"`), `${route.file} should share its canonical URL`);
  assert.ok(html.includes(`<meta property="og:image" content="https://pude.dev/og-image.png"`), `${route.file} should include the social preview image`);

  for (const anchor of route.anchors) {
    assert.ok(html.includes(`id="${anchor}"`), `${route.file} should include the #${anchor} target`);
  }
}

console.log(`Verified ${routes.length} localized prerendered pages.`);
