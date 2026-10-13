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
    modulePreload: { polyfill: false },
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "solid-runtime", test: /node_modules[\\/]solid-js[\\/]/ },
            { name: "desktop-bridge", test: /src[\\/]lib[\\/]bridge\.ts$/ },
          ],
        },
      },
    },
  },
});
