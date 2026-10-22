import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { emitDiagnostic } from "./lib/diagnostics";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { markFirstFrameShown, markStartupEvent } from "./lib/startup-timeline";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

markStartupEvent("entry-start");

if (isTauriRuntime) {
  // SB-05: forward otherwise invisible frontend crashes to the local log.
  const report = (message: string) => {
    console.error(message);
    void invoke("log_frontend_error", { message, source: null }).catch(() => {});
  };
  window.addEventListener("error", (event) => {
    event.preventDefault();
    emitDiagnostic("frontend.error", event.error, report);
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    emitDiagnostic("frontend.rejection", event.reason, report);
  });
}

render(() => <App />, document.getElementById("root")!);
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
