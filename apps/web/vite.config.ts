import { fileURLToPath, URL } from "node:url";
import { createServer, defineConfig, type Plugin, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

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
        for (const locale of ["en", "zh-Hant"] as const) {
          for (const page of ["home", "docs"] as const) {
            pages.set(`${page}-${locale}`, renderer.prerenderPage(page, locale));
          }
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
  plugins: [prerenderStaticRoutes(), solid({ solid: { hydratable: true } })],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        docs: fileURLToPath(new URL("./docs.html", import.meta.url)),
        mainZhHant: fileURLToPath(new URL("./index.zh-Hant.html", import.meta.url)),
        docsZhHant: fileURLToPath(new URL("./docs.zh-Hant.html", import.meta.url)),
      },
    },
  },
});
