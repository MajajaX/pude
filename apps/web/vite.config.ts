import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { createServer, defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { renderSeoHead, renderSitemap, SITE_ROUTES } from "./seo.ts";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

function siteRedirects(): Plugin {
  function installRedirects(server: ViteDevServer | PreviewServer) {
    const redirects = readFileSync(new URL("./public/_redirects", import.meta.url), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/));

    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const redirect = redirects.find(([source]) => source === url.pathname);
      if (!redirect) return next();
      const [, destination, status] = redirect;
      response.writeHead(Number(status), { Location: `${destination}${url.search}` });
      response.end();
    });
  }

  return {
    name: "pude-site-redirects",
    configureServer: installRedirects,
    configurePreviewServer: installRedirects,
  };
}

function siteMetadata(): Plugin {
  return {
    name: "pude-site-metadata",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const route = SITE_ROUTES.find(({ key }) => html.includes(`data-prerender="${key}"`));
        if (!route || !html.includes("<!-- seo -->")) throw new Error("A web page is missing its SEO route or head marker.");
        return html.replace("<!-- seo -->", renderSeoHead(route.page, route.locale));
      },
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: renderSitemap() });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/sitemap.xml") return next();
        response.setHeader("Content-Type", "application/xml; charset=utf-8");
        response.end(renderSitemap());
      });
    },
  };
}

function prerenderStaticRoutes(): Plugin {
  const pages = new Map<string, string>();
  let hydrationScript = "";
  let mode = "production";
  let ssrServer: ViteDevServer | undefined;

  return {
    name: "pude-static-content",
    apply: "build",
    configResolved(config) {
      mode = config.mode;
    },
    async buildStart() {
      ssrServer = await createServer({
        configFile: false,
        root: webRoot,
        mode,
        plugins: [solid({ ssr: true, dev: false, hot: false })],
        appType: "custom",
        server: { middlewareMode: true, hmr: false, ws: false },
        logLevel: "error",
      });

      try {
        const renderer = await ssrServer.ssrLoadModule("/src/prerender.tsx") as {
          prerenderPage(page: "home" | "docs", locale: "en" | "zh-Hant"): string;
          hydrationScript(): string;
        };
        hydrationScript = renderer.hydrationScript();
        for (const { key, page, locale } of SITE_ROUTES) {
          pages.set(key, renderer.prerenderPage(page, locale));
        }
      } catch (error) {
        await ssrServer.close();
        ssrServer = undefined;
        throw error;
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const match = html.match(/<div id="root" data-prerender="([A-Za-z-]+)"><\/div>/);
        if (!match) throw new Error("A web page is missing its static-content route marker.");
        const content = pages.get(match[1]);
        if (!content) throw new Error(`No static content was generated for ${match[1]}.`);
        return html
          .replace("</head>", `${hydrationScript}</head>`)
          .replace(match[0], `<div id="root">${content}</div>`);
      },
    },
    async buildEnd() {
      await ssrServer?.close();
      ssrServer = undefined;
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [siteRedirects(), siteMetadata(), prerenderStaticRoutes(), solid({ solid: { hydratable: true } })],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: Object.fromEntries(SITE_ROUTES.map(({ key, file }) => [key, fileURLToPath(new URL(file, import.meta.url))])),
    },
  },
});
