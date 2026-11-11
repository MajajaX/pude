import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { emitDiagnostic } from "./lib/diagnostics";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { markFirstFrameShown, markStartupEvent } from "./lib/startup-timeline";
import { applyLanguage, t } from "./lib/i18n";
import { defaultSettings, SETTINGS_STORAGE_KEY, validateSettings } from "./lib/settings";

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

// Load the interface language before the first frame so text does not switch after it appears.
const storedLanguage = (() => {
  try {
    return validateSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null"), defaultSettings).language;
  } catch {
    return defaultSettings.language;
  }
})();
await applyLanguage(storedLanguage);

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
  document.getElementById("root")!,
);
markStartupEvent("render-done");

markStartupEvent("render-ready");
if (isTauriRuntime) {
  void invoke("mark_window_shown")
    .then(() => {
      markStartupEvent("show-success");
      requestAnimationFrame(markFirstFrameShown);
    })
    .catch(() => {});
} else {
  requestAnimationFrame(markFirstFrameShown);
}
