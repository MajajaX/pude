import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  build: {
    // Align with the actual WebView runtimes (current WebView2 /
    // Safari 17) so the transpiler emits modern syntax without downleveling.
    target: ["chrome120", "safari17"],
    // The entry is loaded natively by the WebViews above; the modulepreload
    // polyfill would only add dead code to the entry chunk.
    modulePreload: {
      polyfill: false,
      // The page already loads the startup file; preloading it again from a lazy chunk's
      // dependency list makes WebKit warn about an unused preload.
      resolveDependencies: (_file, deps) => deps.filter((dep) => !/(^|\/)startup-[\w-]+\.js$/.test(dep)),
    },
    manifest: true,
    // The production CSP only allows fonts from the app itself, so a small font is never inlined as a data URL.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Every request goes through the app's asset handler, so everything the entry
          // imports statically loads as one file. Code loaded on demand keeps its own chunks.
          groups: [{ name: "startup", tags: ["$initial"] }],
        },
      },
    },
  },
});
