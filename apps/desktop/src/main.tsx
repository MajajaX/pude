// Keep first: imports run in order, and this one starts the downloads the first frame waits for.
import { firstFrameResources } from "./lib/first-frame-resources";
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { emitDiagnostic } from "./lib/diagnostics";
import "./styles/inter-fonts.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { markFirstFrame, markStartupEvent } from "./lib/startup-timeline";
import { t } from "./lib/i18n";

const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

markStartupEvent("entry-start");

// SB-05: forward otherwise invisible frontend crashes to the local log.
const report = (message: string) => {
  console.error(message);
  if (isTauriRuntime) void invoke("log_frontend_error", { message }).catch(() => {});
};

if (isTauriRuntime) {
  window.addEventListener("error", (event) => {
    event.preventDefault();
    emitDiagnostic("frontend.error", event.error, report);
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    emitDiagnostic("frontend.rejection", event.reason, report);
  });
}

await firstFrameResources;

/** Shown instead of a broken window when rendering fails. Recovery data stays in local storage. */
function AppCrashed() {
  return (
    <main class="app-crashed" role="alert">
      <h1>{t("pude hit an unexpected error.")}</h1>
      <p>{t("Unsaved changes are kept as recovery data and come back when the window reloads.")}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t("Reload window")}
      </button>
    </main>
  );
}

const root = document.getElementById("root")!;
root.replaceChildren(); // the startup skeleton from index.html
render(
  () => (
    <ErrorBoundary
      fallback={(error) => {
        emitDiagnostic("frontend.render", error, report);
        return <AppCrashed />;
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
);
markStartupEvent("render-done");
requestAnimationFrame(markFirstFrame);
